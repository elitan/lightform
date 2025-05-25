import { loadConfig, loadSecrets } from "../config";
import { LumaConfig, LumaSecrets } from "../config/types";
import { SSHClient, getSSHCredentials } from "../ssh";
import { DockerClient } from "../docker";
import { setupLumaProxy, LUMA_PROXY_NAME } from "../setup-proxy/index";
import { Logger } from "../utils/logger";

// Module-level logger
let logger: Logger;

// Convert object or array format to a normalized array of entries with names
function normalizeConfigEntries(
  entries: Record<string, any> | Array<any> | undefined
): Array<any> {
  if (!entries) return [];

  // If it's already an array, return it
  if (Array.isArray(entries)) {
    return entries;
  }

  // If it's an object, convert to array with name property
  return Object.entries(entries).map(([name, entry]) => ({
    ...entry,
    name,
  }));
}

async function setupServer(
  serverHostname: string,
  config: LumaConfig,
  secrets: LumaSecrets
) {
  const stepStart = Date.now();
  let sshClient: SSHClient | undefined;
  let sshCredentials: any;

  try {
    logger.server(serverHostname);

    sshCredentials = await getSSHCredentials(
      serverHostname,
      config,
      secrets,
      logger.verbose
    );

    if (!sshCredentials.username) {
      logger.serverStepError(
        `Could not determine SSH username`,
        undefined,
        true
      );
      return;
    }

    // Early exit if using root
    if (sshCredentials.username === "root") {
      logger.serverStepError(
        `Using root for SSH access is not recommended`,
        undefined,
        true
      );
      logger.verboseLog(
        `Please see https://github.com/elitan/luma for security best practices.`
      );
      return;
    }

    logger.verboseLog(`Resolved SSH username: ${sshCredentials.username}`);
    if (sshCredentials.identity) {
      logger.verboseLog(`Using SSH key path: ${sshCredentials.identity}`);
    } else if (sshCredentials.password) {
      logger.verboseLog(`Using SSH password (not displayed).`);
    } else {
      logger.verboseLog(
        `No specific key or password configured; attempting agent/default key authentication.`
      );
    }

    const sshClientOptions = {
      ...sshCredentials,
      host: serverHostname,
      username: sshCredentials.username as string,
      debug: logger.verbose
        ? (message: string) => {
            logger.verboseLog(`SSH_DEBUG: ${message}`);
          }
        : undefined,
    };

    if (logger.verbose) {
      const loggableSshClientOptions = {
        ...sshCredentials,
        password: sshCredentials.password ? "***hidden***" : undefined,
        debug: "debug-function",
      };
      logger.verboseLog(
        `SSHClient options: ${JSON.stringify(
          loggableSshClientOptions,
          null,
          2
        )}`
      );
    }

    sshClient = await SSHClient.create(sshClientOptions);
    await sshClient.connect();

    // Create Docker client
    const dockerClient = new DockerClient(
      sshClient,
      serverHostname,
      logger.verbose
    );

    // Step 1: Check Docker installation
    logger.serverStep("Checking Docker installation");
    const dockerInstalled = await dockerClient.checkInstallation();

    // Install Docker if not installed
    if (!dockerInstalled) {
      logger.verboseLog(`Will attempt to install Docker...`);
      const installSuccess = await dockerClient.install();
      if (!installSuccess) {
        logger.serverStepError(`Docker installation failed`, undefined, true);
        logger.verboseLog(
          `Please install Docker manually. See https://github.com/elitan/luma for server setup instructions.`
        );
        return;
      }
    }
    logger.serverStepComplete(
      `Docker ${dockerInstalled ? "verified" : "installed"}`
    );

    // Step 2: Docker registry authentication
    logger.serverStep("Configuring Docker registry");

    const dockerRegistry = config.docker?.registry || "docker.io";
    const dockerUsername = config.docker?.username;
    const dockerPassword = secrets.DOCKER_REGISTRY_PASSWORD;

    logger.verboseLog(
      `Using Docker registry: ${dockerRegistry} (default: docker.io)`
    );

    if (dockerUsername && dockerPassword) {
      await dockerClient.login(dockerRegistry, dockerUsername, dockerPassword);
      logger.verboseLog(`Successfully logged into Docker registry`);
    } else {
      logger.verboseLog(
        `Docker registry username or password not configured/found in secrets. Skipping Docker login.`
      );
      logger.verboseLog(
        `Please ensure DOCKER_REGISTRY_PASSWORD is in .luma/secrets and docker.username is in luma.yml if login is required.`
      );
    }
    logger.serverStepComplete(`Docker registry configured`);

    // Step 3: Create project network
    if (!config.name) {
      logger.serverStepError(
        `Project name is required in luma.yml`,
        undefined,
        true
      );
      logger.verboseLog(
        `The project name is used to create a unique Docker network for your services.`
      );
      throw new Error(
        `Project name not specified in configuration. Please add 'name: your_project_name' to your luma.yml file.`
      );
    }

    logger.serverStep("Creating project network");
    const networkName = `${config.name}-network`;
    await dockerClient.createNetwork({ name: networkName });
    logger.serverStepComplete(`Network ${networkName} ready`);

    // Step 4: Setup Luma Proxy
    logger.serverStep("Setting up Luma Proxy");
    const proxySetupResult = await setupLumaProxy(
      serverHostname,
      sshClient,
      logger.verbose
    );

    if (!proxySetupResult) {
      logger.serverStepError(`Failed to set up Luma Proxy`, undefined);
      logger.verboseLog(`Some services may not work correctly.`);
    } else {
      logger.verboseLog(`Luma Proxy is ready.`);

      // Connect Luma Proxy to the project network
      logger.verboseLog(`Connecting Luma Proxy to the project network...`);
      try {
        const proxyExists = await dockerClient.containerExists(LUMA_PROXY_NAME);

        if (!proxyExists) {
          throw new Error(
            `Luma Proxy container (${LUMA_PROXY_NAME}) does not exist despite setup reporting success`
          );
        }

        // Check if the proxy is already connected to the network
        const checkNetworkCmd = `docker inspect ${LUMA_PROXY_NAME} --format "{{json .NetworkSettings.Networks}}"`;
        const networkOutput = await sshClient.exec(checkNetworkCmd);
        const networks = JSON.parse(networkOutput.trim());

        if (networks && networks[networkName]) {
          logger.verboseLog(
            `Luma Proxy is already connected to network: ${networkName}`
          );
        } else {
          const connectCmd = `docker network connect ${networkName} ${LUMA_PROXY_NAME}`;
          await sshClient.exec(connectCmd);
          logger.verboseLog(
            `Successfully connected Luma Proxy to network: ${networkName}`
          );
        }
      } catch (error) {
        logger.verboseLog(`Failed to connect Luma Proxy to network: ${error}`);
        logger.verboseLog(
          `Some services may not be accessible through the proxy.`
        );
      }
    }
    logger.serverStepComplete(
      `Luma Proxy ${proxySetupResult ? "configured" : "failed"}`
    );

    // Step 5: Setup services
    logger.serverStep("Setting up services", true);

    const servicesOnThisServer = Object.entries(config.services || {})
      .filter(
        ([_, service]) =>
          service.servers && service.servers.includes(serverHostname)
      )
      .map(([name, service]) => ({ name, ...service }));

    if (servicesOnThisServer.length === 0) {
      logger.verboseLog(`No services found for this server`);
    } else {
      logger.verboseLog(
        `Found ${servicesOnThisServer.length} services to start`
      );

      // Handle service-specific registry logins
      const serviceRegistryMap = new Map<
        string,
        { registry: string; username: string; password: string }
      >();

      for (const service of servicesOnThisServer) {
        if (
          service.registry &&
          typeof service.registry === "object" &&
          service.registry.username
        ) {
          const serviceRegistry = service.registry.url || dockerRegistry;
          const serviceUsername = service.registry.username;

          logger.verboseLog(
            `Service ${service.name} uses registry: ${serviceRegistry}`
          );

          if (
            service.registry.password_secret &&
            !serviceRegistryMap.has(serviceRegistry)
          ) {
            const servicePassword = secrets[service.registry.password_secret];

            if (servicePassword) {
              serviceRegistryMap.set(serviceRegistry, {
                registry: serviceRegistry,
                username: serviceUsername,
                password: servicePassword,
              });
            } else {
              logger.verboseLog(
                `Service ${service.name}: Secret ${service.registry.password_secret} not found in .luma/secrets. Skipping registry login.`
              );
            }
          }
        }
      }

      // Login to all service-specific registries
      for (const [registry, credentials] of serviceRegistryMap.entries()) {
        await dockerClient.login(
          registry,
          credentials.username,
          credentials.password
        );
      }

      // Start services
      for (const service of servicesOnThisServer) {
        logger.verboseLog(`Setting up service: ${service.name}...`);

        try {
          // Pull the latest image
          await dockerClient.pullImage(service.image);

          // Create container options from the service definition
          const containerOptions = DockerClient.serviceToContainerOptions(
            service,
            config.name,
            secrets
          );

          // Check if container already exists (running or not)
          const containerExists = await dockerClient.containerExists(
            containerOptions.name
          );

          if (containerExists) {
            // Container exists, check if it's running
            const containerRunning = await dockerClient.containerIsRunning(
              containerOptions.name
            );

            if (containerRunning) {
              logger.verboseLog(
                `Container ${containerOptions.name} is already running. Setup command does not restart existing containers.`
              );
              continue;
            } else {
              logger.verboseLog(
                `Container ${containerOptions.name} exists but is not running. Starting it...`
              );
              await dockerClient.startContainer(containerOptions.name);
              continue;
            }
          }

          // Create new container
          logger.verboseLog(`Creating new container: ${containerOptions.name}`);
          await dockerClient.createContainer(containerOptions);
        } catch (error) {
          logger.error(`Failed to start service ${service.name}`, error);
        }
      }
    }
    logger.serverStepComplete(`Services configured`, undefined, true);

    await sshClient.close();
  } catch (error: any) {
    const portForError = config.ssh?.port || 22;
    logger.serverStepError(
      `Error during server setup (connecting to ${sshCredentials.username}@${serverHostname}:${portForError})`,
      error,
      true
    );

    if (
      error.level === "client-authentication" ||
      (error.message &&
        error.message.includes("All configured authentication methods failed"))
    ) {
      logger.verboseLog(`Authentication failure. Please verify:
        1. SSH key path ('identity') in Luma config/secrets is correct and accessible.
        2. If using a password, it's correct in Luma secrets.
        3. SSH agent (if used) is configured correctly with the right keys.
        4. The user '${sshCredentials.username}' is allowed to SSH to '${serverHostname}'.`);
    } else if (error.code === "ECONNREFUSED") {
      logger.verboseLog(
        `Connection refused. Ensure an SSH server is running on '${serverHostname}' and accessible on port ${portForError}. Check firewalls.`
      );
    } else if (
      error.code === "ETIMEDOUT" ||
      (error.message && error.message.toLowerCase().includes("timeout"))
    ) {
      logger.verboseLog(
        `Connection timed out. Check network connectivity to '${serverHostname}', server load, and any firewalls.`
      );
    } else if (error.message && error.message.includes("ENOTFOUND")) {
      logger.verboseLog(
        `Hostname not found. Ensure '${serverHostname}' is a valid and resolvable hostname.`
      );
    }
  } finally {
    await sshClient?.close();
  }
}

export async function setupCommand(
  serviceNames?: string[],
  verbose: boolean = false
) {
  try {
    // Initialize logger with verbose flag
    logger = new Logger({ verbose });

    logger.setupStart("Starting infrastructure setup");

    const config = await loadConfig();
    const secrets = await loadSecrets();

    const configuredServices = normalizeConfigEntries(config.services);
    let servicesToSetup: Array<any> = [];

    if (serviceNames && serviceNames.length > 0) {
      logger.verboseLog(`Targeting services: ${serviceNames.join(", ")}`);
      serviceNames.forEach((name) => {
        const service = configuredServices.find((s) => s.name === name);
        if (service) {
          servicesToSetup.push(service);
        } else {
          logger.warn(
            `Service "${name}" not found in configuration. Skipping.`
          );
        }
      });
    } else {
      logger.verboseLog("Targeting all services for setup.");
      servicesToSetup = configuredServices;
    }

    if (servicesToSetup.length === 0) {
      logger.info("No services to set up.");
      return;
    }

    const uniqueServers = new Set<string>();
    servicesToSetup.forEach((service) => {
      if (service.servers && service.servers.length > 0) {
        service.servers.forEach((server: string) => uniqueServers.add(server));
      } else {
        logger.warn(
          `Service "${
            service.name || "Unknown Service"
          }" has no servers defined. Skipping.`
        );
      }
    });

    if (uniqueServers.size === 0) {
      logger.info("No target servers found for the specified services.");
      return;
    }

    logger.phase(`Setting up ${uniqueServers.size} server(s)`);
    logger.verboseLog(
      `Target servers: ${Array.from(uniqueServers).join(", ")}`
    );

    for (const serverHostname of uniqueServers) {
      await setupServer(serverHostname, config, secrets);
    }

    logger.phaseComplete(`Setting up ${uniqueServers.size} server(s)`);
    logger.setupComplete();
  } catch (error) {
    logger.setupFailed(error);
    process.exit(1);
  } finally {
    logger.cleanup();
  }
}
