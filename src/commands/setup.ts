import { loadConfig, loadSecrets } from "../config";
import { LumaConfig, LumaSecrets, LumaService } from "../config/types";
import { SSHClient, getSSHCredentials } from "../ssh";
import { DockerClient } from "../docker";

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
  console.log(`Setting up server: ${serverHostname}...`);

  const sshCredentials = await getSSHCredentials(
    serverHostname,
    config,
    secrets
  );
  if (!sshCredentials.username) {
    console.error(
      `[${serverHostname}] Could not determine SSH username. Skipping.`
    );
    return;
  }

  // Early exit if using root
  if (sshCredentials.username === "root") {
    console.error(
      `[${serverHostname}] Using root for SSH access is not recommended.`
    );
    console.error(
      `[${serverHostname}] Please see https://github.com/elitan/luma for security best practices.`
    );
    return;
  }

  console.log(
    `[${serverHostname}] Resolved SSH username: ${sshCredentials.username}`
  );
  if (sshCredentials.identity) {
    console.log(
      `[${serverHostname}] Using SSH key path: ${sshCredentials.identity}`
    );
  } else if (sshCredentials.password) {
    console.log(`[${serverHostname}] Using SSH password (not displayed).`);
  } else {
    console.log(
      `[${serverHostname}] No specific key or password configured; attempting agent/default key authentication.`
    );
  }

  // Add ssh2 debug logging
  const sshClientOptions = {
    ...sshCredentials,
    debug: (message: string) => {
      console.log(`[${serverHostname}] SSH_DEBUG: ${message}`);
    },
  };

  const loggableSshClientOptions = {
    ...sshClientOptions,
    password: sshClientOptions.password ? "***hidden***" : undefined,
    debug: sshClientOptions.debug ? "<function>" : undefined,
  };
  console.log(
    `[${serverHostname}] SSHClient options:`,
    JSON.stringify(loggableSshClientOptions, null, 2)
  );

  const sshClient = await SSHClient.create(sshClientOptions);

  try {
    await sshClient.connect();

    // Create Docker client
    const dockerClient = new DockerClient(sshClient, serverHostname);

    // 1. Check if Docker is installed
    console.log(`[${serverHostname}] Checking Docker installation...`);
    const dockerInstalled = await dockerClient.checkInstallation();

    // Install Docker if not installed
    if (!dockerInstalled) {
      console.log(`[${serverHostname}] Will attempt to install Docker...`);
      const installSuccess = await dockerClient.install();
      if (!installSuccess) {
        console.log(
          `[${serverHostname}] Please install Docker manually. See https://github.com/elitan/luma for server setup instructions.`
        );
        return; // Early exit if installation failed
      }
    }

    // 2. Log into Docker registry
    const dockerRegistry = config.docker?.registry || "docker.io"; // Default to Docker Hub
    const dockerUsername = config.docker?.username;
    const dockerPassword = secrets.DOCKER_REGISTRY_PASSWORD; // Assuming this key exists in secrets

    console.log(
      `[${serverHostname}] Using Docker registry: ${dockerRegistry} (default: docker.io)`
    );

    if (dockerUsername && dockerPassword) {
      await dockerClient.login(dockerRegistry, dockerUsername, dockerPassword);
    } else {
      console.warn(
        `[${serverHostname}] Docker registry username or password not configured/found in secrets. Skipping Docker login.`
      );
      console.warn(
        `[${serverHostname}] Please ensure DOCKER_REGISTRY_PASSWORD is in .luma/secrets and docker.username is in luma.yml if login is required.`
      );
    }

    // 3. Start the services assigned to this server
    console.log(
      `[${serverHostname}] Starting services assigned to this server...`
    );

    const servicesOnThisServer = Object.entries(config.services || {})
      .filter(
        ([_, service]) =>
          service.servers && service.servers.includes(serverHostname)
      )
      .map(([name, service]) => ({ name, ...service }));

    if (servicesOnThisServer.length === 0) {
      console.log(`[${serverHostname}] No services found for this server.`);
    } else {
      console.log(
        `[${serverHostname}] Found ${servicesOnThisServer.length} services to start.`
      );

      // Require a project name for network creation
      if (!config.name) {
        console.error(
          `[${serverHostname}] Project name is required in luma.yml (add 'name: your_project_name').`
        );
        console.error(
          `[${serverHostname}] The project name is used to create a unique Docker network for your services.`
        );
        throw new Error(
          `Project name not specified in configuration. Please add 'name: your_project_name' to your luma.yml file.`
        );
      }

      // Create a dedicated Docker network for all Luma containers
      const networkName = `${config.name}-network`;
      await dockerClient.createNetwork({ name: networkName });

      // Handle service-specific registry logins
      const serviceRegistryMap = new Map<
        string,
        { registry: string; username: string; password: string }
      >();

      for (const service of servicesOnThisServer) {
        // Check if this service has a specific registry configuration
        if (
          service.registry &&
          typeof service.registry === "object" &&
          service.registry.username
        ) {
          // Use service registry URL if provided, otherwise fall back to global registry, which defaults to Docker Hub
          const serviceRegistry = service.registry.url || dockerRegistry;
          const serviceUsername = service.registry.username;

          console.log(
            `[${serverHostname}] Service ${service.name} uses registry: ${serviceRegistry}`
          );

          // Check if registry has a password in secrets
          if (
            service.registry.password &&
            Array.isArray(service.registry.password) &&
            service.registry.password.length > 0
          ) {
            const passwordSecretKey = service.registry.password[0];
            const servicePassword = secrets[passwordSecretKey];

            if (servicePassword && !serviceRegistryMap.has(serviceRegistry)) {
              serviceRegistryMap.set(serviceRegistry, {
                registry: serviceRegistry,
                username: serviceUsername,
                password: servicePassword,
              });
            } else if (!servicePassword) {
              console.warn(
                `[${serverHostname}] Service ${service.name}: Secret ${passwordSecretKey} not found in .luma/secrets. Skipping registry login.`
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
        console.log(
          `[${serverHostname}] Setting up service: ${service.name}...`
        );

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
              console.log(
                `[${serverHostname}] Container ${containerOptions.name} is already running. Setup command does not restart existing containers.`
              );
              continue; // Skip to the next service
            } else {
              console.log(
                `[${serverHostname}] Container ${containerOptions.name} exists but is not running. Starting it...`
              );
              await dockerClient.startContainer(containerOptions.name);
              continue; // Skip to the next service
            }
          }

          // Create new container
          console.log(
            `[${serverHostname}] Creating new container: ${containerOptions.name}`
          );
          await dockerClient.createContainer(containerOptions);
        } catch (error) {
          console.error(
            `[${serverHostname}] Failed to start service ${service.name}: ${error}`
          );
        }
      }
    }

    console.log(`[${serverHostname}] Setup steps completed.`);
  } catch (error: any) {
    const portForError = config.ssh?.port || 22;
    console.error(
      `[${serverHostname}] Error during server setup (connecting to ${
        sshCredentials.username
      }@${serverHostname}:${portForError}): ${error.message || error}`
    );
    if (
      error.level === "client-authentication" ||
      (error.message &&
        error.message.includes("All configured authentication methods failed"))
    ) {
      console.error(`[${serverHostname}] Authentication failure. Please verify:
          1. SSH key path ('identity') in Luma config/secrets is correct and accessible.
          2. If using a password, it's correct in Luma secrets.
          3. SSH agent (if used) is configured correctly with the right keys.
          4. The user '${sshCredentials.username}' is allowed to SSH to '${serverHostname}'.`);
    } else if (error.code === "ECONNREFUSED") {
      console.error(
        `[${serverHostname}] Connection refused. Ensure an SSH server is running on '${serverHostname}' and accessible on port ${portForError}. Check firewalls.`
      );
    } else if (
      error.code === "ETIMEDOUT" ||
      (error.message && error.message.toLowerCase().includes("timeout"))
    ) {
      console.error(
        `[${serverHostname}] Connection timed out. Check network connectivity to '${serverHostname}', server load, and any firewalls.`
      );
    } else if (error.message && error.message.includes("ENOTFOUND")) {
      console.error(
        `[${serverHostname}] Hostname not found. Ensure '${serverHostname}' is a valid and resolvable hostname.`
      );
    }
  } finally {
    await sshClient.close();
  }
}

export async function setupCommand(serviceNames?: string[]) {
  try {
    const config = await loadConfig();
    const secrets = await loadSecrets();

    const configuredServices = normalizeConfigEntries(config.services);
    let servicesToSetup: Array<any> = [];

    if (serviceNames && serviceNames.length > 0) {
      console.log(`Targeting services: ${serviceNames.join(", ")}`);
      serviceNames.forEach((name) => {
        const service = configuredServices.find((s) => s.name === name);
        if (service) {
          servicesToSetup.push(service);
        } else {
          console.warn(
            `Service "${name}" not found in configuration. Skipping.`
          );
        }
      });
    } else {
      console.log("Targeting all services for setup.");
      servicesToSetup = configuredServices;
    }

    if (servicesToSetup.length === 0) {
      console.log("No services to set up.");
      return;
    }

    const uniqueServers = new Set<string>();
    servicesToSetup.forEach((service) => {
      if (service.servers && service.servers.length > 0) {
        service.servers.forEach((server) => uniqueServers.add(server));
      } else {
        console.warn(
          `Service "${Object.keys(config.services).find(
            (key) => config.services[key] === service
          )}" has no servers defined. Skipping.`
        );
      }
    });

    if (uniqueServers.size === 0) {
      console.log("No target servers found for the specified services.");
      return;
    }

    console.log(
      `Identified unique target servers: ${Array.from(uniqueServers).join(
        ", "
      )}`
    );

    for (const serverHostname of uniqueServers) {
      await setupServer(serverHostname, config, secrets);
    }

    console.log("Setup command finished.");
  } catch (error) {
    console.error("Failed to execute setup command:", error);
    // Optionally, exit with error code: process.exit(1);
  }
}
