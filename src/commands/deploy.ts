import { loadConfig } from "../config"; // Assuming loadConfig is exported from src/config/index.ts
import { loadSecrets } from "../config"; // Assuming loadSecrets is exported from src/config/index.ts
import {
  LumaConfig,
  AppEntry,
  ServiceEntry,
  HealthCheckConfig,
  LumaSecrets,
} from "../config/types";
import {
  DockerClient,
  DockerBuildOptions,
  DockerContainerOptions,
} from "../docker"; // Updated path and name
import { SSHClient, SSHClientOptions, getSSHCredentials } from "../ssh"; // Updated to import the utility function
import { generateReleaseId, getProjectNetworkName } from "../utils"; // Changed path and added getProjectNetworkName
import { execSync } from "child_process";
import { LumaProxyClient } from "../proxy";

/**
 * Resolves environment variables for a container from plain and secret sources
 */
function resolveEnvironmentVariables(
  entry: AppEntry | ServiceEntry,
  secrets: LumaSecrets
): Record<string, string> {
  const envVars: Record<string, string> = {};
  if (entry.environment?.plain) {
    for (const [key, value] of Object.entries(entry.environment.plain)) {
      envVars[key] = value;
    }
  }
  if (entry.environment?.secret) {
    for (const secretKey of entry.environment.secret) {
      if (secrets[secretKey] !== undefined) {
        envVars[secretKey] = secrets[secretKey];
      } else {
        console.warn(
          `Secret key "${secretKey}" for entry "${entry.name}" not found in loaded secrets. It will not be set as an environment variable.`
        );
      }
    }
  }
  return envVars;
}

/**
 * Checks if there are uncommitted changes in the working directory
 */
async function hasUncommittedChanges(): Promise<boolean> {
  try {
    const status = execSync("git status --porcelain").toString().trim();
    return status.length > 0;
  } catch (error) {
    console.warn(
      "Failed to check git status. Assuming no uncommitted changes."
    );
    return false;
  }
}

/**
 * Creates Docker container options for an app entry
 */
function appEntryToContainerOptions(
  appEntry: AppEntry,
  releaseId: string,
  secrets: LumaSecrets,
  projectName: string
): DockerContainerOptions {
  const imageNameWithRelease = `${appEntry.image}:${releaseId}`;
  const containerName = `${appEntry.name}-${releaseId}`;
  const envVars = resolveEnvironmentVariables(appEntry, secrets);
  const networkName = getProjectNetworkName(projectName);

  return {
    name: containerName,
    image: imageNameWithRelease,
    ports: appEntry.ports,
    volumes: appEntry.volumes,
    envVars: envVars,
    network: networkName,
    restart: "unless-stopped",
    // TODO: Add healthcheck options if DockerContainerOptions supports them directly,
    // or handle healthcheck separately after container start.
    // Dockerode, for example, allows specifying Healthcheck in HostConfig
  };
}

/**
 * Creates Docker container options for a service entry
 */
function serviceEntryToContainerOptions(
  serviceEntry: ServiceEntry,
  secrets: LumaSecrets,
  projectName: string
): DockerContainerOptions {
  const containerName = serviceEntry.name; // Services use their simple name
  const envVars = resolveEnvironmentVariables(serviceEntry, secrets);
  const networkName = getProjectNetworkName(projectName);

  return {
    name: containerName,
    image: serviceEntry.image, // Includes tag, e.g., "postgres:15"
    ports: serviceEntry.ports,
    volumes: serviceEntry.volumes,
    envVars: envVars,
    network: networkName, // Assumes network is named project_name-network
    restart: "unless-stopped", // Default restart policy for services
  };
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

interface DeploymentContext {
  config: LumaConfig;
  secrets: LumaSecrets;
  targetEntries: (AppEntry | ServiceEntry)[];
  releaseId: string;
  projectName: string;
  networkName: string;
  forceFlag: boolean;
  deployServicesFlag: boolean;
}

interface ParsedArgs {
  entryNames: string[];
  forceFlag: boolean;
  deployServicesFlag: boolean;
}

/**
 * Parses command line arguments and extracts flags and entry names
 */
function parseDeploymentArgs(rawEntryNamesAndFlags: string[]): ParsedArgs {
  const forceFlag = rawEntryNamesAndFlags.includes("--force");
  const deployServicesFlag = rawEntryNamesAndFlags.includes("--services");

  const entryNames = rawEntryNamesAndFlags.filter(
    (name) => name !== "--services" && name !== "--force"
  );

  return { entryNames, forceFlag, deployServicesFlag };
}

/**
 * Validates git status and throws error if uncommitted changes exist (unless forced)
 */
async function checkUncommittedChanges(forceFlag: boolean): Promise<void> {
  if (!forceFlag && (await hasUncommittedChanges())) {
    console.error(
      "ERROR: Uncommitted changes detected in working directory. Deployment aborted for safety.\n" +
        "Please commit your changes before deploying, or use --force to deploy anyway."
    );
    throw new Error("Uncommitted changes detected");
  }
}

/**
 * Loads and validates Luma configuration and secrets files
 */
async function loadConfigurationAndSecrets(): Promise<{
  config: LumaConfig;
  secrets: LumaSecrets;
}> {
  try {
    const config = await loadConfig();
    const secrets = await loadSecrets();
    console.log("Configuration and secrets loaded successfully.");
    return { config, secrets };
  } catch (error) {
    console.error("Failed to load or validate configuration/secrets:", error);
    throw error;
  }
}

/**
 * Determines which apps or services to deploy based on arguments and configuration
 */
function identifyTargetEntries(
  entryNames: string[],
  deployServicesFlag: boolean,
  config: LumaConfig
): (AppEntry | ServiceEntry)[] {
  const configuredApps = normalizeConfigEntries(config.apps);
  const configuredServices = normalizeConfigEntries(config.services);
  let targetEntries: (AppEntry | ServiceEntry)[] = [];

  if (deployServicesFlag) {
    if (entryNames.length === 0) {
      targetEntries = [...configuredServices];
      if (targetEntries.length === 0) {
        console.log("No services found in configuration to deploy.");
        return [];
      }
      console.log("Targeting all services for deployment.");
    } else {
      entryNames.forEach((name) => {
        const service = configuredServices.find((s) => s.name === name);
        if (service) {
          targetEntries.push(service);
        } else {
          console.warn(`Service "${name}" not found in configuration.`);
        }
      });
      if (targetEntries.length === 0) {
        console.log("No valid services found for specified names.");
        return [];
      }
      console.log(
        "Targeting specified services for deployment:",
        targetEntries.map((e) => e.name).join(", ")
      );
    }
  } else {
    if (entryNames.length === 0) {
      targetEntries = [...configuredApps];
      if (targetEntries.length === 0) {
        console.log("No apps found in configuration to deploy.");
        return [];
      }
      console.log("Targeting all apps for deployment.");
    } else {
      entryNames.forEach((name) => {
        const app = configuredApps.find((a) => a.name === name);
        if (app) {
          targetEntries.push(app);
        } else {
          console.warn(`App "${name}" not found in configuration.`);
        }
      });
      if (targetEntries.length === 0) {
        console.log("No valid apps found for specified names.");
        return [];
      }
      console.log(
        "Targeting specified apps for deployment:",
        targetEntries.map((e) => e.name).join(", ")
      );
    }
  }

  return targetEntries;
}

/**
 * Verifies that required networks and luma-proxy containers exist on target servers
 */
async function verifyInfrastructure(
  targetEntries: (AppEntry | ServiceEntry)[],
  config: LumaConfig,
  secrets: LumaSecrets,
  networkName: string
): Promise<void> {
  const allTargetServers = new Set<string>();
  targetEntries.forEach((entry) => {
    entry.servers.forEach((server) => allTargetServers.add(server));
  });

  console.log(
    `Verifying luma-proxy container and project network "${networkName}" on target servers: ${Array.from(
      allTargetServers
    ).join(", ")}`
  );

  let missingNetworkServers: string[] = [];
  let missingProxyServers: string[] = [];

  for (const serverHostname of Array.from(allTargetServers)) {
    let sshClientNetwork: SSHClient | undefined;
    try {
      const sshCreds = await getSSHCredentials(serverHostname, config, secrets);
      if (!sshCreds.host) sshCreds.host = serverHostname;
      sshClientNetwork = await SSHClient.create(sshCreds as SSHClientOptions);
      await sshClientNetwork.connect();
      const dockerClientRemote = new DockerClient(
        sshClientNetwork,
        serverHostname
      );

      const networkExists = await dockerClientRemote.networkExists(networkName);
      if (networkExists) {
        console.log(`  [${serverHostname}] Network "${networkName}" verified.`);
      } else {
        console.error(
          `  [${serverHostname}] Network "${networkName}" does not exist. Please run \`luma setup\` first.`
        );
        missingNetworkServers.push(serverHostname);
      }

      const proxyClient = new LumaProxyClient(
        dockerClientRemote,
        serverHostname
      );
      const proxyRunning = await proxyClient.isProxyRunning();
      if (proxyRunning) {
        console.log(`  [${serverHostname}] luma-proxy container is running.`);
      } else {
        console.error(
          `  [${serverHostname}] luma-proxy container is not running. Please run \`luma setup\` first.`
        );
        missingProxyServers.push(serverHostname);
      }
    } catch (networkError) {
      console.error(
        `  [${serverHostname}] Error verifying network and proxy:`,
        networkError
      );
      missingNetworkServers.push(serverHostname);
      missingProxyServers.push(serverHostname);
    } finally {
      if (sshClientNetwork) {
        await sshClientNetwork.close();
      }
    }
  }

  if (missingNetworkServers.length > 0 || missingProxyServers.length > 0) {
    if (missingNetworkServers.length > 0) {
      console.error(
        `Error: Required network "${networkName}" is missing on servers: ${missingNetworkServers.join(
          ", "
        )}`
      );
    }
    if (missingProxyServers.length > 0) {
      console.error(
        `Error: Required luma-proxy container is not running on servers: ${missingProxyServers.join(
          ", "
        )}`
      );
    }
    console.error(
      `Please run \`luma setup\` to create the required network and start luma-proxy.`
    );
    throw new Error("Infrastructure verification failed");
  }
}

/**
 * Main deployment loop that processes all target entries
 */
async function deployEntries(context: DeploymentContext): Promise<void> {
  for (const entry of context.targetEntries) {
    const isApp = !context.deployServicesFlag;

    if (isApp) {
      await deployApp(entry as AppEntry, context);
    } else {
      await deployService(entry as ServiceEntry, context);
    }
  }
}

/**
 * Deploys a single app to all its target servers
 */
async function deployApp(
  appEntry: AppEntry,
  context: DeploymentContext
): Promise<void> {
  const imageNameWithRelease = `${appEntry.image}:${context.releaseId}`;
  console.log(
    `Deploying app: ${appEntry.name} (release ${
      context.releaseId
    }) to servers: ${appEntry.servers.join(", ")}`
  );

  const imageReady = await buildOrTagAppImage(appEntry, imageNameWithRelease);
  if (!imageReady) return;

  await pushAppImage(appEntry, imageNameWithRelease, context.config);

  for (const serverHostname of appEntry.servers) {
    await deployAppToServer(appEntry, serverHostname, context);
  }
}

/**
 * Builds or tags a Docker image for an app entry
 */
async function buildOrTagAppImage(
  appEntry: AppEntry,
  imageNameWithRelease: string
): Promise<boolean> {
  if (appEntry.build) {
    console.log(`  Building app ${appEntry.name}...`);
    try {
      const buildPlatform = appEntry.build.platform || "linux/amd64";
      if (!appEntry.build.platform) {
        console.log(`  No platform specified, defaulting to ${buildPlatform}`);
      }

      await DockerClient.build({
        context: appEntry.build.context,
        dockerfile: appEntry.build.dockerfile,
        tags: [imageNameWithRelease],
        buildArgs: appEntry.build.args,
        platform: buildPlatform,
        target: appEntry.build.target,
      });
      console.log(`  Successfully built and tagged ${imageNameWithRelease}`);
      return true;
    } catch (error) {
      console.error(`  Failed to build app ${appEntry.name}:`, error);
      return false;
    }
  } else {
    console.log(
      `  No build config for ${appEntry.name}. Tagging ${appEntry.image} as ${imageNameWithRelease}...`
    );
    try {
      await DockerClient.tag(appEntry.image, imageNameWithRelease);
      console.log(
        `  Successfully tagged ${appEntry.image} as ${imageNameWithRelease}`
      );
      return true;
    } catch (error) {
      console.error(
        `  Failed to tag pre-built image ${appEntry.image}:`,
        error
      );
      return false;
    }
  }
}

/**
 * Pushes an app image to the configured registry
 */
async function pushAppImage(
  appEntry: AppEntry,
  imageNameWithRelease: string,
  config: LumaConfig
): Promise<void> {
  console.log(`  Pushing image ${imageNameWithRelease}...`);
  try {
    const registryToPush = appEntry.registry?.url || config.docker?.registry;
    await DockerClient.push(imageNameWithRelease, registryToPush);
    console.log(`  Successfully pushed ${imageNameWithRelease}`);
  } catch (error) {
    console.error(`  Failed to push image ${imageNameWithRelease}:`, error);
    throw error;
  }
}

/**
 * Deploys an app to a specific server with full deployment lifecycle
 */
async function deployAppToServer(
  appEntry: AppEntry,
  serverHostname: string,
  context: DeploymentContext
): Promise<void> {
  console.log(
    `  Deploying app ${appEntry.name} to server ${serverHostname}...`
  );
  let sshClient: SSHClient | undefined;

  try {
    sshClient = await establishSSHConnection(
      serverHostname,
      context.config,
      context.secrets
    );
    const dockerClientRemote = new DockerClient(sshClient, serverHostname);

    await authenticateAndPullImage(
      appEntry,
      dockerClientRemote,
      context,
      `${appEntry.image}:${context.releaseId}`
    );

    const containerOptions = appEntryToContainerOptions(
      appEntry,
      context.releaseId,
      context.secrets,
      context.projectName
    );
    await createAndHealthCheckContainer(
      containerOptions,
      appEntry,
      dockerClientRemote,
      serverHostname,
      context.projectName
    );

    await cleanupOldContainers(
      appEntry.name,
      containerOptions.name,
      dockerClientRemote,
      serverHostname
    );
    await configureProxyForApp(
      appEntry,
      dockerClientRemote,
      serverHostname,
      context.projectName
    );

    console.log(`    [${serverHostname}] Pruning Docker resources...`);
    await dockerClientRemote.prune();

    console.log(
      `    [${serverHostname}] App ${appEntry.name} deployed successfully.`
    );
  } catch (serverError) {
    console.error(
      `  [${serverHostname}] Failed to deploy app ${appEntry.name}:`,
      serverError
    );
  } finally {
    if (sshClient) {
      await sshClient.close();
    }
  }
}

/**
 * Deploys a single service to all its target servers
 */
async function deployService(
  serviceEntry: ServiceEntry,
  context: DeploymentContext
): Promise<void> {
  console.log(
    `Deploying service: ${
      serviceEntry.name
    } to servers: ${serviceEntry.servers.join(", ")}`
  );

  for (const serverHostname of serviceEntry.servers) {
    await deployServiceToServer(serviceEntry, serverHostname, context);
  }
}

/**
 * Deploys a service to a specific server by replacing the existing container
 */
async function deployServiceToServer(
  serviceEntry: ServiceEntry,
  serverHostname: string,
  context: DeploymentContext
): Promise<void> {
  console.log(
    `  Deploying service ${serviceEntry.name} to server ${serverHostname}...`
  );
  let sshClient: SSHClient | undefined;

  try {
    sshClient = await establishSSHConnection(
      serverHostname,
      context.config,
      context.secrets
    );
    const dockerClientRemote = new DockerClient(sshClient, serverHostname);

    await authenticateAndPullImage(
      serviceEntry,
      dockerClientRemote,
      context,
      serviceEntry.image
    );

    await replaceServiceContainer(
      serviceEntry,
      dockerClientRemote,
      serverHostname,
      context
    );

    console.log(`    [${serverHostname}] Pruning Docker resources...`);
    await dockerClientRemote.prune();

    console.log(
      `    [${serverHostname}] Service ${serviceEntry.name} deployed successfully.`
    );
  } catch (serverError) {
    console.error(
      `  [${serverHostname}] Failed to deploy service ${serviceEntry.name}:`,
      serverError
    );
  } finally {
    if (sshClient) {
      await sshClient.close();
    }
  }
}

/**
 * Establishes an SSH connection to a server using configured credentials
 */
async function establishSSHConnection(
  serverHostname: string,
  config: LumaConfig,
  secrets: LumaSecrets
): Promise<SSHClient> {
  const sshCreds = await getSSHCredentials(serverHostname, config, secrets);
  if (!sshCreds.host) sshCreds.host = serverHostname;
  const sshClient = await SSHClient.create(sshCreds as SSHClientOptions);
  await sshClient.connect();
  console.log(`    [${serverHostname}] SSH connection established.`);
  return sshClient;
}

/**
 * Handles registry authentication and pulls the specified image
 */
async function authenticateAndPullImage(
  entry: AppEntry | ServiceEntry,
  dockerClientRemote: DockerClient,
  context: DeploymentContext,
  imageToPull: string
): Promise<void> {
  const globalRegistryConfig = context.config.docker;
  const entryRegistry = entry.registry;
  let imageRegistry =
    entryRegistry?.url || globalRegistryConfig?.registry || "docker.io";
  let registryLoginPerformed = false;

  if (entryRegistry?.username && entryRegistry?.password_secret) {
    const password = context.secrets[entryRegistry.password_secret];
    if (password) {
      await performRegistryLogin(
        dockerClientRemote,
        imageRegistry,
        entryRegistry.username,
        password
      );
      registryLoginPerformed = true;
    }
  } else if (
    globalRegistryConfig?.username &&
    context.secrets.DOCKER_REGISTRY_PASSWORD
  ) {
    await performRegistryLogin(
      dockerClientRemote,
      imageRegistry,
      globalRegistryConfig.username,
      context.secrets.DOCKER_REGISTRY_PASSWORD
    );
    registryLoginPerformed = true;
  }

  console.log(`    Pulling image ${imageToPull}...`);
  const pullSuccess = await dockerClientRemote.pullImage(imageToPull);

  if (registryLoginPerformed) {
    await dockerClientRemote.logout(imageRegistry);
  }

  if (!pullSuccess) {
    throw new Error(`Failed to pull image ${imageToPull}`);
  }
}

/**
 * Performs Docker registry login with error handling for unencrypted warnings
 */
async function performRegistryLogin(
  dockerClient: DockerClient,
  registry: string,
  username: string,
  password: string
): Promise<void> {
  try {
    await dockerClient.login(registry, username, password);
    console.log(`    Successfully logged into registry`);
  } catch (loginError) {
    const errorMessage = String(loginError);
    if (
      errorMessage.includes("WARNING! Your password will be stored unencrypted")
    ) {
      console.log(`    Successfully logged into registry`);
    } else {
      console.error(`    Failed to login to registry:`, loginError);
    }
  }
}

/**
 * Creates a container and performs health checks to ensure it's ready
 */
async function createAndHealthCheckContainer(
  containerOptions: DockerContainerOptions,
  appEntry: AppEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  projectName: string
): Promise<void> {
  const containerExists = await dockerClient.containerExists(
    containerOptions.name
  );
  if (containerExists) {
    const containerRunning = await dockerClient.containerIsRunning(
      containerOptions.name
    );
    if (containerRunning) {
      console.log(
        `    [${serverHostname}] Container ${containerOptions.name} is already running. Skipping.`
      );
      return;
    } else {
      await dockerClient.removeContainer(containerOptions.name);
    }
  }

  console.log(
    `    [${serverHostname}] Starting new container ${containerOptions.name}...`
  );
  const createSuccess = await dockerClient.createContainer(containerOptions);
  if (!createSuccess) {
    throw new Error(`Failed to create container ${containerOptions.name}`);
  }

  const isHealthy = await performHealthChecks(
    containerOptions.name,
    appEntry,
    dockerClient,
    serverHostname,
    projectName
  );
  if (!isHealthy) {
    await dockerClient.stopContainer(containerOptions.name);
    await dockerClient.removeContainer(containerOptions.name);
    throw new Error(`Container ${containerOptions.name} failed health checks`);
  }
}

/**
 * Performs health checks on a container using the /up endpoint
 */
async function performHealthChecks(
  containerName: string,
  appEntry: AppEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  projectName: string
): Promise<boolean> {
  console.log(
    `    [${serverHostname}] Performing health checks for ${containerName}...`
  );

  const hcConfig = appEntry.health_check || {};
  const startPeriodSeconds = parseInt(hcConfig.start_period || "0s", 10);

  if (startPeriodSeconds > 0) {
    console.log(
      `    [${serverHostname}] Waiting for start period: ${startPeriodSeconds}s...`
    );
    await new Promise((resolve) =>
      setTimeout(resolve, startPeriodSeconds * 1000)
    );
  }

  try {
    // Extract the correct app port from proxy configuration
    const appPort = appEntry.proxy?.app_port || 80;
    console.log(
      `    [${serverHostname}] Using app port ${appPort} for health check`
    );

    const result = await dockerClient.checkContainerEndpoint(
      containerName,
      true,
      projectName,
      appPort
    );
    const [healthCheckPassed] = result as [boolean, string];

    if (healthCheckPassed) {
      console.log(
        `    [${serverHostname}] Health check successful for ${containerName}`
      );
      return true;
    } else {
      console.error(
        `    [${serverHostname}] Health check failed for ${containerName}`
      );
      return false;
    }
  } catch (error) {
    console.error(
      `    [${serverHostname}] Health check error for ${containerName}:`,
      error
    );
    return false;
  }
}

/**
 * Removes old containers from previous deployments of the same app
 */
async function cleanupOldContainers(
  appName: string,
  currentContainerName: string,
  dockerClient: DockerClient,
  serverHostname: string
): Promise<void> {
  const previousContainers = await dockerClient.findContainersByPrefix(
    `${appName}-`
  );
  const oldContainers = previousContainers.filter(
    (name) =>
      name !== currentContainerName && !name.startsWith("luma-hc-helper")
  );

  if (oldContainers.length > 0) {
    console.log(
      `    [${serverHostname}] Cleaning up ${
        oldContainers.length
      } old container(s): ${oldContainers.join(", ")}`
    );

    for (const oldContainer of oldContainers) {
      try {
        await dockerClient.stopContainer(oldContainer);
        await dockerClient.removeContainer(oldContainer);
        console.log(
          `    [${serverHostname}] Removed old container ${oldContainer}`
        );
      } catch (error) {
        console.warn(
          `    [${serverHostname}] Could not remove old container ${oldContainer}:`,
          error
        );
      }
    }
  }
}

/**
 * Configures luma-proxy routing for an app's hosts
 */
async function configureProxyForApp(
  appEntry: AppEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  projectName: string
): Promise<void> {
  if (!appEntry.proxy?.hosts?.length) return;

  console.log(
    `    [${serverHostname}] Configuring luma-proxy for ${appEntry.name}...`
  );

  const proxyClient = new LumaProxyClient(dockerClient, serverHostname);
  const hosts = appEntry.proxy.hosts;
  const appPort = appEntry.proxy.app_port || 80;
  const useSSL = appEntry.proxy.ssl || false;

  for (const host of hosts) {
    try {
      const configSuccess = await proxyClient.configureProxy(
        host,
        appEntry.name,
        appPort,
        projectName,
        useSSL
      );

      if (!configSuccess) {
        console.error(
          `    [${serverHostname}] Failed to configure proxy for host ${host}`
        );
      }
    } catch (proxyError) {
      console.error(
        `    [${serverHostname}] Error configuring proxy for host ${host}:`,
        proxyError
      );
    }
  }
}

/**
 * Replaces a service container by stopping the old one and creating a new one
 */
async function replaceServiceContainer(
  serviceEntry: ServiceEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  context: DeploymentContext
): Promise<void> {
  const containerName = serviceEntry.name;

  try {
    await dockerClient.stopContainer(containerName);
    await dockerClient.removeContainer(containerName);
  } catch (e) {
    console.warn(
      `    [${serverHostname}] Error stopping/removing old service container:`,
      e
    );
  }

  const serviceContainerOptions = serviceEntryToContainerOptions(
    serviceEntry,
    context.secrets,
    context.projectName
  );

  console.log(
    `    [${serverHostname}] Starting new service container ${containerName}...`
  );
  const createSuccess = await dockerClient.createContainer(
    serviceContainerOptions
  );

  if (!createSuccess) {
    throw new Error(`Failed to create container ${containerName}`);
  }
}

/**
 * Main deployment command that orchestrates the entire deployment process
 */
export async function deployCommand(rawEntryNamesAndFlags: string[]) {
  console.log("Deploy command initiated with args:", rawEntryNamesAndFlags);

  try {
    const { entryNames, forceFlag, deployServicesFlag } = parseDeploymentArgs(
      rawEntryNamesAndFlags
    );

    await checkUncommittedChanges(forceFlag);

    const { config, secrets } = await loadConfigurationAndSecrets();

    const targetEntries = identifyTargetEntries(
      entryNames,
      deployServicesFlag,
      config
    );
    if (targetEntries.length === 0) {
      console.log("No entries selected for deployment. Exiting.");
      return;
    }

    const releaseId = await generateReleaseId();
    console.log(`Generated Release ID: ${releaseId}`);

    const projectName = config.name;
    const networkName = getProjectNetworkName(projectName);

    await verifyInfrastructure(targetEntries, config, secrets, networkName);

    const context: DeploymentContext = {
      config,
      secrets,
      targetEntries,
      releaseId,
      projectName,
      networkName,
      forceFlag,
      deployServicesFlag,
    };

    await deployEntries(context);
  } catch (error) {
    console.error("Deployment failed:", error);
    process.exit(1);
  }
}
