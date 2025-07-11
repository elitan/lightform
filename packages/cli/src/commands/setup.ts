import { loadConfig, loadSecrets } from "../config";
import {
  LightformConfig,
  LightformSecrets,
  ServiceEntry,
} from "../config/types";
import { SSHClient, SSHClientOptions, getSSHCredentials } from "../ssh";
import { DockerClient } from "../docker";
import {
  setupLightformProxy,
  LIGHTFORM_PROXY_NAME,
} from "../setup-proxy/index";
import { Logger } from "../utils/logger";

// Module-level logger that gets configured when setupCommand runs
let logger: Logger;

interface SetupContext {
  config: LightformConfig;
  secrets: LightformSecrets;
  verboseFlag: boolean;
  allowBootstrap?: boolean;
}

interface ParsedSetupArgs {
  entryNames: string[];
  verboseFlag: boolean;
  forceBootstrap: boolean;
}

/**
 * Attempts to bootstrap a fresh server as root user
 */
async function bootstrapFreshServer(
  serverHostname: string,
  context: SetupContext
): Promise<boolean> {
  logger.phase(`Bootstrapping fresh server: ${serverHostname}`);

  try {
    // Try to connect as root
    const rootCredentials = await getSSHCredentials(
      serverHostname,
      { ...context.config, ssh: { ...context.config.ssh, username: "root" } },
      context.secrets,
      context.verboseFlag
    );

    const sshClient = await SSHClient.create({
      ...rootCredentials,
      host: serverHostname,
      username: "root",
      skipHostKeyVerification: true, // Fresh servers need this
    });

    await sshClient.connect();
    logger.verboseLog("Successfully connected as root");

    // Get the target username from config
    const targetUsername = context.config.ssh?.username || "lightform";

    // Bootstrap the server
    await performBootstrapSteps(sshClient, targetUsername, context);

    await sshClient.close();
    logger.phaseComplete(`Server bootstrapped successfully`);
    return true;
  } catch (error) {
    // Check if it's just debconf warnings or user already exists (which are not real failures)
    const errorMessage = error?.toString() || "";
    const isDebconfWarning = errorMessage.includes(
      "debconf: unable to initialize frontend"
    );
    const isUserExists = errorMessage.includes("already exists");
    const hasRealError =
      errorMessage.includes("E:") ||
      errorMessage.includes("ERROR") ||
      errorMessage.includes("fatal:");

    if ((isDebconfWarning || isUserExists) && !hasRealError) {
      logger.verboseLog(
        "Non-critical warnings detected (normal for server setup)"
      );
      logger.phaseComplete(`Server bootstrapped successfully`);
      return true;
    }

    logger.error("Failed to bootstrap server", error);
    return false;
  }
}

/**
 * Performs the actual bootstrap steps on the server
 */
async function performBootstrapSteps(
  sshClient: SSHClient,
  targetUsername: string,
  context: SetupContext
): Promise<void> {
  logger.serverStep("Creating lightform user");

  // Create user (handle if already exists)
  try {
    await sshClient.exec(
      `adduser --disabled-password --gecos "" ${targetUsername}`
    );
    logger.verboseLog(`Created user: ${targetUsername}`);
  } catch (error) {
    if (String(error).includes("already exists")) {
      logger.verboseLog(
        `User ${targetUsername} already exists, configuring...`
      );
    } else {
      logger.verboseLog(
        `Warning during user creation: ${String(error).slice(0, 100)}...`
      );
    }
  }

  try {
    await sshClient.exec(`usermod -aG sudo ${targetUsername}`);
    logger.verboseLog("→ Added user to sudo group");
  } catch (error) {
    logger.verboseLog(`Warning: ${String(error).slice(0, 50)}...`);
  }

  logger.serverStep("Installing Docker");

  // Check if Docker already installed
  try {
    await sshClient.exec("docker --version");
    logger.verboseLog("Docker already installed, skipping...");
  } catch (error) {
    logger.verboseLog("Installing Docker Engine...");

    try {
      // Install Docker with progress feedback
      await sshClient.exec(
        "export DEBIAN_FRONTEND=noninteractive && apt-get update"
      );
      logger.verboseLog("→ Updated package lists");

      await sshClient.exec(
        "export DEBIAN_FRONTEND=noninteractive && apt-get install -y ca-certificates curl"
      );
      logger.verboseLog("→ Installed prerequisites");

      await sshClient.exec("install -m 0755 -d /etc/apt/keyrings");
      await sshClient.exec(
        "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc"
      );
      await sshClient.exec("chmod a+r /etc/apt/keyrings/docker.asc");
      logger.verboseLog("→ Added Docker GPG key");

      await sshClient.exec(
        `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null`
      );
      await sshClient.exec(
        "export DEBIAN_FRONTEND=noninteractive && apt-get update"
      );
      logger.verboseLog("→ Added Docker repository");

      await sshClient.exec(
        "export DEBIAN_FRONTEND=noninteractive && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin pigz"
      );
      logger.verboseLog("→ Installed Docker packages and compression tools");
    } catch (dockerError) {
      // Don't fail bootstrap for debconf warnings
      if (String(dockerError).includes("debconf:")) {
        logger.verboseLog("→ Docker installed (ignoring debconf warnings)");
      } else {
        throw dockerError;
      }
    }
  }

  try {
    await sshClient.exec(`usermod -aG docker ${targetUsername}`);
    logger.verboseLog("→ Added user to docker group");
  } catch (error) {
    logger.verboseLog(`Warning: ${String(error).slice(0, 50)}...`);
  }

  logger.serverStep("Setting up SSH keys");

  // Setup SSH directory for target user
  await sshClient.exec(`mkdir -p /home/${targetUsername}/.ssh`);
  await sshClient.exec(`chmod 700 /home/${targetUsername}/.ssh`);
  logger.verboseLog("→ Created SSH directory");

  // Copy root's authorized_keys to target user
  await sshClient.exec(
    `cp /root/.ssh/authorized_keys /home/${targetUsername}/.ssh/authorized_keys 2>/dev/null || true`
  );
  await sshClient.exec(
    `chown -R ${targetUsername}:${targetUsername} /home/${targetUsername}/.ssh`
  );
  await sshClient.exec(
    `chmod 600 /home/${targetUsername}/.ssh/authorized_keys`
  );
  logger.verboseLog("→ Configured SSH access");

  logger.serverStep("Securing SSH configuration");

  // Secure SSH config
  await sshClient.exec(
    `sed -i 's/#PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config`
  );
  await sshClient.exec(
    `sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config`
  );
  await sshClient.exec(
    `sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config`
  );
  logger.verboseLog("→ Updated SSH config");

  await sshClient.exec(`systemctl restart ssh`);
  logger.verboseLog("→ Restarted SSH service");

  logger.serverStep("Installing Fail2Ban");

  // Check if Fail2Ban already installed
  try {
    await sshClient.exec("fail2ban-client --version");
    logger.verboseLog("Fail2Ban already installed");
  } catch (error) {
    await sshClient.exec(
      `export DEBIAN_FRONTEND=noninteractive && apt-get install -y fail2ban`
    );
    logger.verboseLog("→ Installed Fail2Ban");
  }

  try {
    await sshClient.exec(`systemctl enable fail2ban`);
    logger.verboseLog("→ Enabled Fail2Ban service");
  } catch (error) {
    // Ignore systemctl enable output (it's not an error)
    if (
      String(error).includes("Synchronizing state") ||
      String(error).includes("Executing:")
    ) {
      logger.verboseLog("→ Enabled Fail2Ban service");
    } else {
      logger.verboseLog(
        `Warning enabling Fail2Ban: ${String(error).slice(0, 50)}...`
      );
    }
  }

  try {
    await sshClient.exec(`systemctl start fail2ban`);
    logger.verboseLog("→ Started Fail2Ban service");
  } catch (error) {
    logger.verboseLog(
      `Warning starting Fail2Ban: ${String(error).slice(0, 50)}...`
    );
  }

  logger.serverStep("Enabling automatic security updates");

  // Install and configure unattended upgrades
  try {
    await sshClient.exec(
      `export DEBIAN_FRONTEND=noninteractive && apt-get install -y unattended-upgrades`
    );
    await sshClient.exec(
      `echo 'Unattended-Upgrade::Automatic-Reboot "false";' >> /etc/apt/apt.conf.d/50unattended-upgrades`
    );
    await sshClient.exec(`systemctl enable unattended-upgrades`);
    logger.verboseLog("→ Enabled automatic security updates");
  } catch (error) {
    logger.verboseLog(
      `Warning configuring auto-updates: ${String(error).slice(0, 50)}...`
    );
  }

  logger.serverStep("Basic system hardening");

  // Disable unused services
  try {
    await sshClient.exec(
      `systemctl disable --now avahi-daemon 2>/dev/null || true`
    );
    logger.verboseLog("→ Disabled mDNS service");
  } catch (error) {
    // Ignore if service doesn't exist
  }

  try {
    await sshClient.exec(`systemctl disable --now cups 2>/dev/null || true`);
    logger.verboseLog("→ Disabled print service");
  } catch (error) {
    // Ignore if service doesn't exist
  }

  // Secure SSH config permissions
  try {
    await sshClient.exec(`chmod 600 /etc/ssh/sshd_config`);
    logger.verboseLog("→ Secured SSH config permissions");
  } catch (error) {
    logger.verboseLog(
      `Warning securing SSH config: ${String(error).slice(0, 50)}...`
    );
  }

  // Enable NTP time synchronization
  try {
    await sshClient.exec(`timedatectl set-ntp true`);
    logger.verboseLog("→ Enabled NTP time sync");
  } catch (error) {
    logger.verboseLog(
      `Warning configuring NTP: ${String(error).slice(0, 50)}...`
    );
  }

  // Set stricter umask for new files
  try {
    await sshClient.exec(`echo "umask 027" >> /etc/profile`);
    logger.verboseLog("→ Set secure file permissions");
  } catch (error) {
    logger.verboseLog(
      `Warning setting umask: ${String(error).slice(0, 50)}...`
    );
  }

  logger.serverStepComplete("Bootstrap completed");
}

/**
 * Checks if a server appears to be fresh (no lightform user configured)
 */
async function detectFreshServer(
  serverHostname: string,
  context: SetupContext
): Promise<boolean> {
  try {
    const sshCredentials = await getSSHCredentials(
      serverHostname,
      context.config,
      context.secrets,
      context.verboseFlag
    );

    if (!sshCredentials.username) {
      return false;
    }

    // Try to connect with configured user
    const sshClient = await SSHClient.create({
      ...sshCredentials,
      host: serverHostname,
      username: sshCredentials.username as string,
      skipHostKeyVerification: true, // For fresh server detection
      suppressConnectionErrors: true, // Don't show errors during detection
    });

    await sshClient.connect();
    await sshClient.close();

    // If connection succeeds, it's not a fresh server
    return false;
  } catch (error) {
    // If connection fails, it might be a fresh server
    logger.verboseLog(
      `Connection failed with configured user, server might be fresh: ${error}`
    );
    return true;
  }
}

/**
 * Converts object or array format configuration entries to a normalized array
 */
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

/**
 * Parses command line arguments for setup command
 */
function parseSetupArgs(
  entryNames?: string[],
  verbose: boolean = false,
  forceBootstrap: boolean = false
): ParsedSetupArgs {
  return {
    entryNames: entryNames || [],
    verboseFlag: verbose,
    forceBootstrap,
  };
}

/**
 * Loads and validates Lightform configuration and secrets files
 */
async function loadConfigurationAndSecrets(): Promise<{
  config: LightformConfig;
  secrets: LightformSecrets;
}> {
  try {
    const config = await loadConfig();
    const secrets = await loadSecrets();
    return { config, secrets };
  } catch (error) {
    if (error instanceof Error && (error.message.includes("ENOENT") || error.message.includes("lightform.yml"))) {
      logger.error("Configuration files not found.");
      logger.error("");
      logger.error("To fix this:");
      logger.error("   lightform init                    # Create configuration files");
      logger.error("   # Edit lightform.yml with your server settings");
      logger.error("   lightform setup                   # Run setup again");
    } else {
      logger.error("Failed to load configuration/secrets", error);
    }
    throw error;
  }
}

/**
 * Collects all unique servers from apps and services configuration
 */
function collectAllServers(config: LightformConfig): Set<string> {
  const configuredApps = normalizeConfigEntries(config.apps);
  const configuredServices = normalizeConfigEntries(config.services);
  const allServers = new Set<string>();

  // Add servers from apps
  configuredApps.forEach((app) => {
    if (app.server) {
      allServers.add(app.server);
    }
  });

  // Add servers from services
  configuredServices.forEach((service) => {
    if (service.server) {
      allServers.add(service.server);
    }
  });

  return allServers;
}

/**
 * Filters servers based on specified entry names
 */
function filterServersByEntries(
  entryNames: string[],
  config: LightformConfig
): Set<string> {
  if (entryNames.length === 0) {
    return collectAllServers(config);
  }

  logger.verboseLog(`Targeting entries: ${entryNames.join(", ")}`);

  const configuredApps = normalizeConfigEntries(config.apps);
  const configuredServices = normalizeConfigEntries(config.services);
  const targetServers = new Set<string>();

  entryNames.forEach((name) => {
    const app = configuredApps.find((a) => a.name === name);
    if (app && app.server) {
      targetServers.add(app.server);
    }

    const service = configuredServices.find((s) => s.name === name);
    if (service && service.server) {
      targetServers.add(service.server);
    }

    if (!app && !service) {
      logger.warn(
        `Entry "${name}" not found in apps or services configuration. Skipping.`
      );
    }
  });

  return targetServers;
}

/**
 * Establishes SSH connection to a server with proper error handling
 */
async function establishSSHConnection(
  serverHostname: string,
  context: SetupContext
): Promise<{ sshClient: SSHClient; sshCredentials: any }> {
  const sshCredentials = await getSSHCredentials(
    serverHostname,
    context.config,
    context.secrets,
    context.verboseFlag
  );

  if (!sshCredentials.username) {
    throw new Error("Could not determine SSH username");
  }

  // Security check for root user (allow during bootstrap)
  if (sshCredentials.username === "root" && !context.allowBootstrap) {
    logger.serverStepError(
      `Using root for SSH access is not recommended`,
      undefined,
      true
    );
    logger.verboseLog(
      `Please see https://github.com/elitan/lightform for security best practices.`
    );
    throw new Error("Root SSH access not recommended");
  }

  logger.verboseLog(`Resolved SSH username: ${sshCredentials.username}`);
  logSSHCredentials(sshCredentials);

  const sshClientOptions = {
    ...sshCredentials,
    host: serverHostname,
    username: sshCredentials.username as string,
    debug: context.verboseFlag
      ? (message: string) => {
          logger.verboseLog(`SSH_DEBUG: ${message}`);
        }
      : undefined,
  };

  if (context.verboseFlag) {
    logSSHClientOptions(sshClientOptions);
  }

  const sshClient = await SSHClient.create(sshClientOptions);
  await sshClient.connect();

  return { sshClient, sshCredentials };
}

/**
 * Logs SSH credential information (safely)
 */
function logSSHCredentials(sshCredentials: any): void {
  if (sshCredentials.identity) {
    logger.verboseLog(`Using SSH key path: ${sshCredentials.identity}`);
  } else if (sshCredentials.password) {
    logger.verboseLog(`Using SSH password (not displayed).`);
  } else {
    logger.verboseLog(
      `No specific key or password configured; attempting agent/default key authentication.`
    );
  }
}

/**
 * Logs SSH client options (safely hiding sensitive data)
 */
function logSSHClientOptions(sshClientOptions: any): void {
  const loggableSshClientOptions = {
    ...sshClientOptions,
    password: sshClientOptions.password ? "***hidden***" : undefined,
    debug: "debug-function",
  };
  logger.verboseLog(
    `SSHClient options: ${JSON.stringify(loggableSshClientOptions, null, 2)}`
  );
}

/**
 * Checks Docker installation and installs if needed
 */
async function ensureDockerInstallation(
  dockerClient: DockerClient,
  serverHostname: string
): Promise<void> {
  logger.serverStep("Checking Docker installation");

  const dockerInstalled = await dockerClient.checkInstallation();

  if (!dockerInstalled) {
    logger.verboseLog(`Will attempt to install Docker...`);
    const installSuccess = await dockerClient.install();
    if (!installSuccess) {
      logger.serverStepError(`Docker installation failed`, undefined, true);
      logger.verboseLog(
        `Please install Docker manually. See https://github.com/elitan/lightform for server setup instructions.`
      );
      throw new Error("Docker installation failed");
    }
  }

  logger.serverStepComplete(
    `Docker ${dockerInstalled ? "verified" : "installed"}`
  );
}

/**
 * Configures Docker registry authentication
 */
async function configureDockerRegistry(
  dockerClient: DockerClient,
  context: SetupContext
): Promise<void> {
  logger.serverStep("Configuring Docker registry");

  const dockerRegistry = context.config.docker?.registry || "docker.io";
  const dockerUsername = context.config.docker?.username;
  const dockerPassword = context.secrets.DOCKER_REGISTRY_PASSWORD;

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
      `Please ensure DOCKER_REGISTRY_PASSWORD is in .lightform/secrets and docker.username is in lightform.yml if login is required.`
    );
  }

  logger.serverStepComplete(`Docker registry configured`);
}

/**
 * Creates the project network for the server
 */
async function createProjectNetwork(
  dockerClient: DockerClient,
  context: SetupContext
): Promise<string> {
  if (!context.config.name) {
    const errorMsg = `Project name is required in lightform.yml`;
    logger.serverStepError(errorMsg, undefined, true);
    logger.verboseLog(
      `The project name is used to create a unique Docker network for your services.`
    );
    throw new Error(
      `Project name not specified in configuration. Please add 'name: your_project_name' to your lightform.yml file.`
    );
  }

  logger.serverStep("Creating project network");
  const networkName = `${context.config.name}-network`;
  await dockerClient.createNetwork({ name: networkName });
  logger.serverStepComplete(`Network ${networkName} ready`);

  return networkName;
}

/**
 * Sets up and configures the Lightform Proxy
 */
async function setupAndConfigureLightformProxy(
  sshClient: SSHClient,
  dockerClient: DockerClient,
  networkName: string,
  serverHostname: string,
  context: SetupContext
): Promise<void> {
  logger.serverStep("Setting up Lightform Proxy");

  const proxySetupResult = await setupLightformProxy(
    serverHostname,
    sshClient,
    context.verboseFlag
  );

  if (!proxySetupResult) {
    logger.serverStepError(`Failed to set up Lightform Proxy`, undefined);
    logger.verboseLog(`Some services may not work correctly.`);
  } else {
    logger.verboseLog(`Lightform Proxy is ready.`);
    await connectProxyToNetwork(sshClient, dockerClient, networkName);
  }

  logger.serverStepComplete(
    `Lightform Proxy ${proxySetupResult ? "configured" : "failed"}`
  );
}

/**
 * Connects the Lightform Proxy to the project network
 */
async function connectProxyToNetwork(
  sshClient: SSHClient,
  dockerClient: DockerClient,
  networkName: string
): Promise<void> {
  logger.verboseLog(`Connecting Lightform Proxy to the project network...`);

  try {
    const proxyExists = await dockerClient.containerExists(
      LIGHTFORM_PROXY_NAME
    );

    if (!proxyExists) {
      throw new Error(
        `Lightform Proxy container (${LIGHTFORM_PROXY_NAME}) does not exist despite setup reporting success`
      );
    }

    // Check if the proxy is already connected to the network
    const checkNetworkCmd = `docker inspect ${LIGHTFORM_PROXY_NAME} --format "{{json .NetworkSettings.Networks}}"`;
    const networkOutput = await sshClient.exec(checkNetworkCmd);
    const networks = JSON.parse(networkOutput.trim());

    if (networks && networks[networkName]) {
      logger.verboseLog(
        `Lightform Proxy is already connected to network: ${networkName}`
      );
    } else {
      const connectCmd = `docker network connect ${networkName} ${LIGHTFORM_PROXY_NAME}`;
      await sshClient.exec(connectCmd);
      logger.verboseLog(
        `Successfully connected Lightform Proxy to network: ${networkName}`
      );
    }
  } catch (error) {
    logger.verboseLog(`Failed to connect Lightform Proxy to network: ${error}`);
    logger.verboseLog(`Some services may not be accessible through the proxy.`);
  }
}

/**
 * Gets services that should be deployed to a specific server
 */
function getServicesForServer(
  serverHostname: string,
  context: SetupContext
): ServiceEntry[] {
  return Object.entries(context.config.services || {})
    .filter(([_, service]) => service.server === serverHostname)
    .map(([name, service]) => ({ name, ...service }));
}

/**
 * Authenticates with service-specific Docker registries
 */
async function authenticateServiceRegistries(
  services: ServiceEntry[],
  dockerClient: DockerClient,
  context: SetupContext
): Promise<void> {
  const dockerRegistry = context.config.docker?.registry || "docker.io";
  const serviceRegistryMap = new Map<
    string,
    { registry: string; username: string; password: string }
  >();

  for (const service of services) {
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
        const servicePassword =
          context.secrets[service.registry.password_secret];

        if (servicePassword) {
          serviceRegistryMap.set(serviceRegistry, {
            registry: serviceRegistry,
            username: serviceUsername,
            password: servicePassword,
          });
        } else {
          logger.verboseLog(
            `Service ${service.name}: Secret ${service.registry.password_secret} not found in .lightform/secrets. Skipping registry login.`
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
}

/**
 * Deploys a single service to the server
 */
async function deployService(
  service: ServiceEntry,
  dockerClient: DockerClient,
  context: SetupContext
): Promise<void> {
  logger.verboseLog(`Setting up service: ${service.name}...`);

  try {
    // Pull the latest image
    await dockerClient.pullImage(service.image);

    // Create container options from the service definition
    const containerOptions = DockerClient.serviceToContainerOptions(
      service,
      context.config.name,
      context.secrets
    );

    // Check if container already exists (running or not)
    const containerExists = await dockerClient.containerExists(
      containerOptions.name
    );

    if (containerExists) {
      await handleExistingServiceContainer(containerOptions.name, dockerClient);
    } else {
      await createNewServiceContainer(containerOptions, dockerClient);
    }
  } catch (error) {
    logger.error(`Failed to start service ${service.name}`, error);
    throw error;
  }
}

/**
 * Handles existing service containers (start if stopped, skip if running)
 */
async function handleExistingServiceContainer(
  containerName: string,
  dockerClient: DockerClient
): Promise<void> {
  const containerRunning = await dockerClient.containerIsRunning(containerName);

  if (containerRunning) {
    logger.verboseLog(
      `Container ${containerName} is already running. Setup command does not restart existing containers.`
    );
  } else {
    logger.verboseLog(
      `Container ${containerName} exists but is not running. Starting it...`
    );
    await dockerClient.startContainer(containerName);
  }
}

/**
 * Creates a new service container
 */
async function createNewServiceContainer(
  containerOptions: any,
  dockerClient: DockerClient
): Promise<void> {
  logger.verboseLog(`Creating new container: ${containerOptions.name}`);
  await dockerClient.createContainer(containerOptions);
}

/**
 * Sets up all services for a server
 */
async function setupServicesOnServer(
  dockerClient: DockerClient,
  serverHostname: string,
  context: SetupContext
): Promise<void> {
  logger.serverStep("Setting up services", true);

  const servicesOnThisServer = getServicesForServer(serverHostname, context);

  // Check if there are apps on this server to provide better messaging
  const configuredApps = normalizeConfigEntries(context.config.apps);
  const appsOnThisServer = configuredApps.filter(
    (app) => app.server === serverHostname
  );

  if (servicesOnThisServer.length === 0) {
    if (appsOnThisServer.length > 0) {
      logger.verboseLog(
        `No services configured for this server, but ${appsOnThisServer.length} app(s) found. Infrastructure setup is complete for app deployments.`
      );
    } else {
      logger.verboseLog(`No services found for this server`);
    }
  } else {
    logger.verboseLog(`Found ${servicesOnThisServer.length} services to start`);

    // Authenticate with service-specific registries
    await authenticateServiceRegistries(
      servicesOnThisServer,
      dockerClient,
      context
    );

    // Deploy each service
    for (const service of servicesOnThisServer) {
      await deployService(service, dockerClient, context);
    }
  }

  const statusMessage =
    servicesOnThisServer.length > 0
      ? `Services configured`
      : appsOnThisServer.length > 0
      ? `Infrastructure ready for apps`
      : `No services configured`;

  logger.serverStepComplete(statusMessage, undefined, true);
}

/**
 * Handles setup errors with specific error messages and suggestions
 */
function handleSetupError(
  error: any,
  serverHostname: string,
  sshCredentials: any,
  context: SetupContext
): void {
  const portForError = context.config.ssh?.port || 22;
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
      1. SSH key path ('identity') in Lightform config/secrets is correct and accessible.
      2. If using a password, it's correct in Lightform secrets.
      3. SSH agent (if used) is configured correctly with the right keys.
      4. The user '${sshCredentials.username}' is allowed to SSH to '${serverHostname}'.`);
    logger.verboseLog("");
    logger.verboseLog("Quick fixes:");
    logger.verboseLog(`   ssh ${sshCredentials.username}@${serverHostname}    # Test SSH manually`);
    logger.verboseLog("   # Check your SSH key: ls ~/.ssh/");
    logger.verboseLog("   # Add key to agent: ssh-add ~/.ssh/your_key");
  } else if (error.code === "ECONNREFUSED") {
    logger.verboseLog(
      `Connection refused. Ensure an SSH server is running on '${serverHostname}' and accessible on port ${portForError}.`
    );
    logger.verboseLog("");
    logger.verboseLog("Quick fixes:");
    logger.verboseLog(`   ping ${serverHostname}                     # Test basic connectivity`);
    logger.verboseLog(`   telnet ${serverHostname} ${portForError}           # Test SSH port`);
    logger.verboseLog("   # Check firewall settings on the server");
  } else if (
    error.code === "ETIMEDOUT" ||
    (error.message && error.message.toLowerCase().includes("timeout"))
  ) {
    logger.verboseLog(
      `Connection timed out. Check network connectivity to '${serverHostname}', server load, and any firewalls.`
    );
    logger.verboseLog("");
    logger.verboseLog("Quick fixes:");
    logger.verboseLog(`   ping ${serverHostname}                     # Test basic connectivity`);
    logger.verboseLog("   # Check server is powered on and accessible");
    logger.verboseLog("   # Try from a different network");
  } else if (error.message && error.message.includes("ENOTFOUND")) {
    logger.verboseLog(
      `Hostname not found. Ensure '${serverHostname}' is a valid and resolvable hostname.`
    );
    logger.verboseLog("");
    logger.verboseLog("Quick fixes:");
    logger.verboseLog(`   nslookup ${serverHostname}                 # Check DNS resolution`);
    logger.verboseLog("   # Verify hostname spelling in lightform.yml");
    logger.verboseLog("   # Try using IP address instead of hostname");
  }
}

/**
 * Sets up a single server with all required infrastructure and services
 */
async function setupServer(
  serverHostname: string,
  context: SetupContext
): Promise<void> {
  let sshClient: SSHClient | undefined;
  let sshCredentials: any;

  try {
    logger.server(serverHostname);

    // Check if this is a fresh server
    const isFreshServer = await detectFreshServer(serverHostname, context);

    if (isFreshServer) {
      logger.verboseLog(
        "Server appears to be fresh (configured user cannot connect)"
      );
      logger.verboseLog(
        "🚀 Fresh server detected - bootstrapping automatically with security best practices"
      );
      logger.verboseLog("   → Creating lightform user with sudo access");
      logger.verboseLog("   → Installing Docker Engine");
      logger.verboseLog("   → Setting up SSH keys");
      logger.verboseLog("   → Securing SSH configuration");
      logger.verboseLog("   → Installing Fail2Ban");
      logger.verboseLog("   → Enabling automatic security updates");
      logger.verboseLog("   → Basic system hardening");

      const bootstrapSuccess = await bootstrapFreshServer(
        serverHostname,
        context
      );
      if (!bootstrapSuccess) {
        logger.serverStepError("Bootstrap failed", undefined, true);
        return;
      }

      logger.verboseLog(
        "✅ Server bootstrapped successfully, continuing with setup..."
      );

      // Give the server a moment to apply changes
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Establish SSH connection (now with potentially bootstrapped server)
    logger.verboseLog("Connecting with configured user...");
    const connectionResult = await establishSSHConnection(
      serverHostname,
      context
    );
    sshClient = connectionResult.sshClient;
    sshCredentials = connectionResult.sshCredentials;
    logger.verboseLog("SSH connection established successfully");

    // Create Docker client
    const dockerClient = new DockerClient(
      sshClient,
      serverHostname,
      context.verboseFlag
    );

    // Setup infrastructure
    await ensureDockerInstallation(dockerClient, serverHostname);
    await configureDockerRegistry(dockerClient, context);
    const networkName = await createProjectNetwork(dockerClient, context);
    await setupAndConfigureLightformProxy(
      sshClient,
      dockerClient,
      networkName,
      serverHostname,
      context
    );
    await setupServicesOnServer(dockerClient, serverHostname, context);

    await sshClient.close();
  } catch (error: any) {
    handleSetupError(error, serverHostname, sshCredentials, context);
  } finally {
    await sshClient?.close();
  }
}

/**
 * Provides a summary of what will be set up
 */
function logSetupSummary(
  targetServers: Set<string>,
  config: LightformConfig,
  verboseFlag: boolean
): void {
  const configuredApps = normalizeConfigEntries(config.apps);
  const configuredServices = normalizeConfigEntries(config.services);

  const appsCount = configuredApps.filter((app) =>
    targetServers.has(app.server)
  ).length;

  const servicesCount = configuredServices.filter((service) =>
    targetServers.has(service.server)
  ).length;

  if (verboseFlag) {
    logger.verboseLog(`Setup will prepare infrastructure for:`);
    if (appsCount > 0) {
      logger.verboseLog(`  - ${appsCount} app(s) ready for deployment`);
    }
    if (servicesCount > 0) {
      logger.verboseLog(`  - ${servicesCount} service(s) to be started`);
    }
    if (appsCount === 0 && servicesCount === 0) {
      logger.verboseLog(
        `  - Server infrastructure only (no apps or services configured for these servers)`
      );
    }
  }
}

/**
 * Main setup command that orchestrates the entire setup process
 */
export async function setupCommand(
  entryNames?: string[],
  verbose: boolean = false
) {
  try {
    const { entryNames: parsedEntryNames, verboseFlag } = parseSetupArgs(
      entryNames,
      verbose
    );

    // Initialize logger with verbose flag
    logger = new Logger({ verbose: verboseFlag });

    logger.setupStart("Starting infrastructure setup");

    // Load configuration and secrets
    const { config, secrets } = await loadConfigurationAndSecrets();

    const context: SetupContext = {
      config,
      secrets,
      verboseFlag,
      allowBootstrap: true,
    };

    // Determine target servers
    const targetServers = filterServersByEntries(parsedEntryNames, config);

    if (targetServers.size === 0) {
      logger.info(
        "No servers to set up. Please check your lightform.yml configuration has apps or services with servers defined."
      );
      return;
    }

    // Check what types of entries we're setting up for better messaging
    const configuredApps = normalizeConfigEntries(config.apps);
    const configuredServices = normalizeConfigEntries(config.services);

    const hasApps = configuredApps.some((app) => targetServers.has(app.server));
    const hasServices = configuredServices.some((service) =>
      targetServers.has(service.server)
    );

    let phaseMessage = `Setting up ${targetServers.size} server(s)`;
    if (hasApps && hasServices) {
      phaseMessage += ` for apps and services`;
    } else if (hasApps) {
      phaseMessage += ` for app deployments`;
    } else if (hasServices) {
      phaseMessage += ` for services`;
    }

    logger.phase(phaseMessage);
    logger.verboseLog(
      `Target servers: ${Array.from(targetServers).join(", ")}`
    );

    // Provide setup summary
    logSetupSummary(targetServers, config, verboseFlag);

    // Setup each server
    for (const serverHostname of targetServers) {
      await setupServer(serverHostname, context);
    }

    logger.phaseComplete(phaseMessage);
    logger.setupComplete();
  } catch (error) {
    logger.setupFailed(error);
    process.exit(1);
  } finally {
    logger.cleanup();
  }
}
