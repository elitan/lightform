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
import { performBlueGreenDeployment } from "./blue-green";
import { Logger } from "../utils/logger";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { createHash } from "crypto";
import { unlink, stat } from "fs/promises";
import * as cliProgress from "cli-progress";
import { join, basename } from "path";

// Module-level logger that gets configured when deployCommand runs
let logger: Logger;

/**
 * Resolves environment variables for a container from plain and secret sources
 */
function resolveEnvironmentVariables(
  entry: AppEntry | ServiceEntry,
  secrets: LumaSecrets
): Record<string, string> {
  const envVars: Record<string, string> = {};

  if (entry.environment?.plain) {
    for (const envVar of entry.environment.plain) {
      const [key, ...valueParts] = envVar.split("=");
      if (key && valueParts.length > 0) {
        envVars[key] = valueParts.join("=");
      }
    }
  }

  if (entry.environment?.secret) {
    for (const secretKey of entry.environment.secret) {
      if (secrets[secretKey] !== undefined) {
        envVars[secretKey] = secrets[secretKey];
      } else {
        logger.warn(
          `Secret key "${secretKey}" for ${entry.name} not found in loaded secrets`
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
    logger.verboseLog(
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
  const imageNameWithRelease = buildImageName(appEntry, releaseId);
  const containerName = `${projectName}-${appEntry.name}-${releaseId}`;
  const envVars = resolveEnvironmentVariables(appEntry, secrets);
  const networkName = getProjectNetworkName(projectName);

  return {
    name: containerName,
    image: imageNameWithRelease,
    ports: appEntry.ports,
    volumes: appEntry.volumes,
    envVars: envVars,
    network: networkName,
    networkAlias: appEntry.name,
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
  const containerName = `${projectName}-${serviceEntry.name}`; // Project-prefixed names
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
    labels: {
      "luma.managed": "true",
      "luma.project": projectName,
      "luma.type": "service",
      "luma.service": serviceEntry.name,
    },
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
  verboseFlag: boolean;
  imageArchives?: Map<string, string>; // app name -> archive path
}

interface ParsedArgs {
  entryNames: string[];
  forceFlag: boolean;
  deployServicesFlag: boolean;
  verboseFlag: boolean;
}

/**
 * Parses command line arguments and extracts flags and entry names
 */
function parseDeploymentArgs(rawEntryNamesAndFlags: string[]): ParsedArgs {
  const forceFlag = rawEntryNamesAndFlags.includes("--force");
  const deployServicesFlag = rawEntryNamesAndFlags.includes("--services");
  const verboseFlag = rawEntryNamesAndFlags.includes("--verbose");

  const entryNames = rawEntryNamesAndFlags.filter(
    (name) =>
      name !== "--services" && name !== "--force" && name !== "--verbose"
  );

  return { entryNames, forceFlag, deployServicesFlag, verboseFlag };
}

/**
 * Validates git status and throws error if uncommitted changes exist (unless forced)
 */
async function checkUncommittedChanges(forceFlag: boolean): Promise<void> {
  if (!forceFlag && (await hasUncommittedChanges())) {
    logger.error(
      "Uncommitted changes detected in working directory. Deployment aborted for safety.\n" +
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
    return { config, secrets };
  } catch (error) {
    logger.error("Failed to load configuration/secrets", error);
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
        logger.warn("No services found in configuration");
        return [];
      }
    } else {
      entryNames.forEach((name) => {
        const service = configuredServices.find((s) => s.name === name);
        if (service) {
          targetEntries.push(service);
        } else {
          logger.warn(`Service "${name}" not found in configuration`);
        }
      });
      if (targetEntries.length === 0) {
        logger.warn("No valid services found for specified names");
        return [];
      }
    }
  } else {
    if (entryNames.length === 0) {
      targetEntries = [...configuredApps];
      if (targetEntries.length === 0) {
        logger.warn("No apps found in configuration");
        return [];
      }
    } else {
      entryNames.forEach((name) => {
        const app = configuredApps.find((a) => a.name === name);
        if (app) {
          targetEntries.push(app);
        } else {
          logger.warn(`App "${name}" not found in configuration`);
        }
      });
      if (targetEntries.length === 0) {
        logger.warn("No valid apps found for specified names");
        return [];
      }
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
  networkName: string,
  verbose: boolean = false
): Promise<void> {
  const allTargetServers = new Set<string>();
  targetEntries.forEach((entry) => {
    entry.servers.forEach((server) => allTargetServers.add(server));
  });

  logger.verboseLog(
    `Checking infrastructure on servers: ${Array.from(allTargetServers).join(
      ", "
    )}`
  );

  let missingNetworkServers: string[] = [];
  let missingProxyServers: string[] = [];

  for (const serverHostname of Array.from(allTargetServers)) {
    let sshClientNetwork: SSHClient | undefined;
    try {
      const sshCreds = await getSSHCredentials(
        serverHostname,
        config,
        secrets,
        verbose
      );
      if (!sshCreds.host) sshCreds.host = serverHostname;
      sshClientNetwork = await SSHClient.create(sshCreds as SSHClientOptions);
      await sshClientNetwork.connect();
      const dockerClientRemote = new DockerClient(
        sshClientNetwork,
        serverHostname,
        verbose
      );

      const networkExists = await dockerClientRemote.networkExists(networkName);
      if (!networkExists) {
        missingNetworkServers.push(serverHostname);
      }

      const proxyClient = new LumaProxyClient(
        dockerClientRemote,
        serverHostname
      );
      const proxyRunning = await proxyClient.isProxyRunning();
      if (!proxyRunning) {
        missingProxyServers.push(serverHostname);
      }
    } catch (networkError) {
      logger.verboseLog(`Error verifying ${serverHostname}: ${networkError}`);
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
      logger.error(
        `Required network "${networkName}" is missing on servers: ${missingNetworkServers.join(
          ", "
        )}`
      );
    }
    if (missingProxyServers.length > 0) {
      logger.error(
        `Required luma-proxy container is not running on servers: ${missingProxyServers.join(
          ", "
        )}`
      );
    }
    logger.error(
      "Please run `luma setup` to create the required infrastructure"
    );
    throw new Error("Infrastructure verification failed");
  }
}

/**
 * Main deployment loop that processes all target entries
 */
async function deployEntries(context: DeploymentContext): Promise<void> {
  // Categorize entries by type
  const apps = context.targetEntries.filter(
    (entry) =>
      (entry.name !== undefined && (entry as AppEntry).build !== undefined) ||
      (entry as AppEntry).proxy !== undefined
  ) as AppEntry[];
  const services = context.targetEntries.filter(
    (entry) =>
      entry.name !== undefined &&
      (entry as ServiceEntry).image !== undefined &&
      !(entry as AppEntry).build &&
      !(entry as AppEntry).proxy
  ) as ServiceEntry[];

  const appsNeedingBuild = apps.filter((app) => app.build !== undefined);

  // Initialize image archives map
  context.imageArchives = new Map<string, string>();

  // Build phase for apps that have build config
  if (appsNeedingBuild.length > 0) {
    logger.phase("Building Images");
    for (const appEntry of appsNeedingBuild) {
      const archivePath = await buildAndSaveApp(appEntry, context);
      context.imageArchives.set(appEntry.name, archivePath);
    }
    logger.phaseComplete("Building Images");
  }

  // Skip build phase for pre-built apps and show info
  if (apps.length > 0 && apps.length > appsNeedingBuild.length) {
    logger.verboseLog(
      `Using pre-built images: ${apps
        .filter((app) => !(app as AppEntry).build)
        .map((app) => `${app.name} (${app.image})`)
        .join(", ")}`
    );
  }

  // Clean up removed apps with reconciliation
  logger.phase("App State Reconciliation");
  const allAppServers = new Set<string>();
  context.targetEntries.forEach((entry) => {
    const appEntry = entry as AppEntry;
    appEntry.servers.forEach((server) => allAppServers.add(server));
  });

  // Also check servers that might have orphaned apps
  const configuredApps = normalizeConfigEntries(context.config.apps);
  const allConfiguredServers = new Set<string>();
  configuredApps.forEach((app) => {
    app.servers.forEach((server: string) => allConfiguredServers.add(server));
  });
  allConfiguredServers.forEach((server) => allAppServers.add(server));

  for (const serverHostname of Array.from(allAppServers)) {
    await reconcileAppsOnServer(context, serverHostname);
  }
  logger.phaseComplete("App State Reconciliation");

  // Deploy phase for apps
  if (apps.length > 0) {
    logger.phase("Deploying Apps");
    const deploymentStartTime = Date.now();

    // Deployment phase: Deploy each app to their servers
    for (const appEntry of apps) {
      await deployAppToServers(appEntry, context);
    }

    const deploymentDuration = Date.now() - deploymentStartTime;
    logger.phaseComplete("Deploying Apps", deploymentDuration);
  }

  // Deploy phase for services with reconciliation
  if (services.length > 0 || context.deployServicesFlag) {
    logger.phase("Deploying Services");

    // Get all unique servers that need service deployment
    const allServiceServers = new Set<string>();
    services.forEach((entry) => {
      const serviceEntry = entry as ServiceEntry;
      serviceEntry.servers.forEach((server) => allServiceServers.add(server));
    });

    // Deploy to each server with reconciliation
    for (const serverHostname of Array.from(allServiceServers)) {
      await deployServicesWithReconciliation(context, serverHostname);
    }

    logger.phaseComplete("Service deployment complete");
  }
}

/**
 * Builds an app and saves it to a tar archive for transfer
 */
async function buildAndSaveApp(
  appEntry: AppEntry,
  context: DeploymentContext
): Promise<string> {
  const imageNameWithRelease = `${appEntry.image}:${context.releaseId}`;
  const stepStart = Date.now();

  try {
    const imageReady = await buildOrTagAppImage(
      appEntry,
      imageNameWithRelease,
      context.verboseFlag
    );
    if (!imageReady) throw new Error("Image build failed");

    const archivePath = await saveAppImage(
      appEntry,
      imageNameWithRelease,
      context.verboseFlag
    );

    const duration = Date.now() - stepStart;
    logger.stepComplete(`${appEntry.name} → ${imageNameWithRelease}`, duration);
    return archivePath;
  } catch (error) {
    logger.stepError(`${appEntry.name} → ${imageNameWithRelease}`, error);
    throw error;
  }
}

/**
 * Deploys an app to all its servers (deployment phase)
 */
async function deployAppToServers(
  appEntry: AppEntry,
  context: DeploymentContext
): Promise<void> {
  logger.appDeployment(appEntry.name, appEntry.servers);

  for (let i = 0; i < appEntry.servers.length; i++) {
    const serverHostname = appEntry.servers[i];
    const isLastServer = i === appEntry.servers.length - 1;

    await deployAppToServer(appEntry, serverHostname, context, isLastServer);
  }
}

/**
 * Builds or tags a Docker image for an app entry
 */
async function buildOrTagAppImage(
  appEntry: AppEntry,
  imageNameWithRelease: string,
  verbose: boolean = false
): Promise<boolean> {
  if (appEntry.build) {
    logger.verboseLog(`Building app ${appEntry.name}...`);
    try {
      const buildPlatform = appEntry.build.platform || "linux/amd64";
      if (!appEntry.build.platform) {
        logger.verboseLog(
          `No platform specified, defaulting to ${buildPlatform}`
        );
      }

      await DockerClient.build({
        context: appEntry.build.context,
        dockerfile: appEntry.build.dockerfile,
        tags: [imageNameWithRelease],
        buildArgs: appEntry.build.args,
        platform: buildPlatform,
        target: appEntry.build.target,
        verbose: verbose,
      });
      logger.verboseLog(
        `Successfully built and tagged ${imageNameWithRelease}`
      );
      return true;
    } catch (error) {
      logger.error(`Failed to build app ${appEntry.name}`, error);
      return false;
    }
  } else {
    logger.verboseLog(
      `Tagging ${appEntry.image} as ${imageNameWithRelease}...`
    );
    try {
      await DockerClient.tag(appEntry.image, imageNameWithRelease, verbose);
      logger.verboseLog(
        `Successfully tagged ${appEntry.image} as ${imageNameWithRelease}`
      );
      return true;
    } catch (error) {
      logger.error(`Failed to tag pre-built image ${appEntry.image}`, error);
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
  config: LumaConfig,
  verbose: boolean = false
): Promise<void> {
  logger.verboseLog(`Pushing image ${imageNameWithRelease}...`);
  try {
    const registryToPush = appEntry.registry?.url || config.docker?.registry;
    await DockerClient.push(imageNameWithRelease, registryToPush, verbose);
    logger.verboseLog(`Successfully pushed ${imageNameWithRelease}`);
  } catch (error) {
    logger.error(`Failed to push image ${imageNameWithRelease}`, error);
    throw error;
  }
}

/**
 * Saves an app image to a tar archive for transfer
 */
async function saveAppImage(
  appEntry: AppEntry,
  imageNameWithRelease: string,
  verbose: boolean = false
): Promise<string> {
  logger.verboseLog(`Saving image ${imageNameWithRelease} to archive...`);
  try {
    // Create a temporary directory for the archive
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-"));
    const archivePath = path.join(
      tempDir,
      `${appEntry.name}-${Date.now()}.tar`
    );

    await DockerClient.save(imageNameWithRelease, archivePath, verbose);
    logger.verboseLog(
      `Successfully saved ${imageNameWithRelease} to ${archivePath}`
    );
    return archivePath;
  } catch (error) {
    logger.error(`Failed to save image ${imageNameWithRelease}`, error);
    throw error;
  }
}

/**
 * Builds the full image name with release ID for built apps, or returns original name for pre-built apps
 */
function buildImageName(appEntry: AppEntry, releaseId: string): string {
  // For apps with build config, use release ID
  if (appEntry.build) {
    return `${appEntry.image}:${releaseId}`;
  }
  // For pre-built apps, use the image as-is
  return appEntry.image;
}

/**
 * Deploys an app to a specific server using zero-downtime deployment
 */
async function deployAppToServer(
  appEntry: AppEntry,
  serverHostname: string,
  context: DeploymentContext,
  isLastServer: boolean = false
): Promise<void> {
  try {
    logger.verboseLog(`Deploying ${appEntry.name} to ${serverHostname}`);

    const sshClient = await establishSSHConnection(
      serverHostname,
      context.config,
      context.secrets,
      context.verboseFlag
    );

    const dockerClient = new DockerClient(
      sshClient,
      serverHostname,
      context.verboseFlag
    );

    const imageNameWithRelease = buildImageName(appEntry, context.releaseId);

    // Step 1: Pull image
    logger.serverStep(`Loading ${appEntry.name} image`);
    await transferAndLoadImage(
      appEntry,
      sshClient,
      dockerClient,
      context,
      imageNameWithRelease
    );
    logger.serverStepComplete(`Loading ${appEntry.name} image`);

    // Step 2: Zero-downtime deployment
    logger.serverStep(`Zero-downtime deployment of ${appEntry.name}`);
    const deploymentResult = await performBlueGreenDeployment({
      appEntry,
      releaseId: context.releaseId,
      secrets: context.secrets,
      projectName: context.projectName,
      networkName: context.networkName,
      dockerClient,
      serverHostname,
      verbose: context.verboseFlag,
    });

    if (!deploymentResult.success) {
      await sshClient.close();
      throw new Error(deploymentResult.error || "Deployment failed");
    }
    logger.serverStepComplete(`Zero-downtime deployment of ${appEntry.name}`);

    // Step 3: Configure proxy
    logger.serverStep(`Configuring proxy for ${appEntry.name}`, isLastServer);
    await configureProxyForApp(
      appEntry,
      dockerClient,
      serverHostname,
      context.projectName,
      context.verboseFlag
    );
    logger.serverStepComplete(
      `Configuring proxy for ${appEntry.name}`,
      undefined,
      isLastServer
    );

    await sshClient.close();
  } catch (error) {
    logger.serverStepError(
      `${appEntry.name} deployment to ${serverHostname}`,
      error,
      isLastServer
    );
    throw error;
  }
}

/**
 * Deploys a single service to all its target servers
 */
async function deployService(
  serviceEntry: ServiceEntry,
  context: DeploymentContext
): Promise<void> {
  logger.verboseLog(
    `Deploying service: ${
      serviceEntry.name
    } to servers: ${serviceEntry.servers.join(", ")}`
  );

  for (const serverHostname of serviceEntry.servers) {
    let sshClient: SSHClient | undefined;

    try {
      sshClient = await establishSSHConnection(
        serverHostname,
        context.config,
        context.secrets,
        context.verboseFlag
      );
      const dockerClient = new DockerClient(
        sshClient,
        serverHostname,
        context.verboseFlag
      );

      await deployServiceDirectly(
        serviceEntry,
        dockerClient,
        serverHostname,
        context
      );
    } finally {
      if (sshClient) {
        await sshClient.close();
      }
    }
  }
}

/**
 * Deploys services with state reconciliation to a specific server
 */
async function deployServicesWithReconciliation(
  context: DeploymentContext,
  serverHostname: string
): Promise<void> {
  let sshClient: SSHClient | undefined;

  try {
    sshClient = await establishSSHConnection(
      serverHostname,
      context.config,
      context.secrets,
      context.verboseFlag
    );
    const dockerClient = new DockerClient(
      sshClient,
      serverHostname,
      context.verboseFlag
    );

    // Step 1: Plan state reconciliation
    const reconciliationPlan = await planStateReconciliation(
      context,
      dockerClient,
      serverHostname
    );

    // Step 2: Remove orphaned services first
    await removeOrphanedServices(
      reconciliationPlan.servicesToRemove,
      dockerClient,
      serverHostname,
      context.projectName
    );

    // Step 3: Deploy/update desired services
    const servicesToDeploy = context.targetEntries.filter((entry) => {
      const serviceEntry = entry as ServiceEntry;
      return serviceEntry.servers.includes(serverHostname);
    });

    for (const entry of servicesToDeploy) {
      const serviceEntry = entry as ServiceEntry;
      await deployServiceDirectly(
        serviceEntry,
        dockerClient,
        serverHostname,
        context
      );
    }
  } catch (error) {
    logger.error(`Failed to deploy services to ${serverHostname}: ${error}`);
    throw error;
  } finally {
    if (sshClient) {
      await sshClient.close();
    }
  }
}

/**
 * Deploys a service directly to a specific server (low-level function)
 */
async function deployServiceDirectly(
  serviceEntry: ServiceEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  context: DeploymentContext
): Promise<void> {
  logger.verboseLog(
    `Deploying service ${serviceEntry.name} to server ${serverHostname}`
  );

  try {
    await authenticateAndPullImage(
      serviceEntry,
      dockerClient,
      context,
      serviceEntry.image
    );

    await replaceServiceContainer(
      serviceEntry,
      dockerClient,
      serverHostname,
      context
    );

    logger.verboseLog(`Pruning Docker resources on ${serverHostname}`);
    await dockerClient.prune();

    logger.verboseLog(
      `Service ${serviceEntry.name} deployed successfully to ${serverHostname}`
    );
  } catch (serverError) {
    logger.error(
      `Failed to deploy service ${serviceEntry.name} to ${serverHostname}`,
      serverError
    );
    throw serverError;
  }
}

/**
 * Establishes an SSH connection to a server using configured credentials
 */
async function establishSSHConnection(
  serverHostname: string,
  config: LumaConfig,
  secrets: LumaSecrets,
  verbose: boolean = false
): Promise<SSHClient> {
  const sshCreds = await getSSHCredentials(
    serverHostname,
    config,
    secrets,
    verbose
  );
  if (!sshCreds.host) sshCreds.host = serverHostname;
  const sshClient = await SSHClient.create(sshCreds as SSHClientOptions);
  await sshClient.connect();
  logger.verboseLog(`SSH connection established to ${serverHostname}`);
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

  logger.verboseLog(`Pulling image ${imageToPull}...`);
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
    logger.verboseLog(`Successfully logged into registry`);
  } catch (loginError) {
    const errorMessage = String(loginError);
    if (
      errorMessage.includes("WARNING! Your password will be stored unencrypted")
    ) {
      logger.verboseLog(`Successfully logged into registry`);
    } else {
      logger.error(`Failed to login to registry`, loginError);
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
  projectName: string,
  verbose: boolean = false
): Promise<void> {
  if (!appEntry.proxy?.hosts?.length) return;

  logger.verboseLog(`Configuring luma-proxy for ${appEntry.name}`);

  const proxyClient = new LumaProxyClient(
    dockerClient,
    serverHostname,
    verbose
  );
  const hosts = appEntry.proxy.hosts;
  const appPort = appEntry.proxy.app_port || 80;
  const healthPath = appEntry.health_check?.path || "/up";

  for (const host of hosts) {
    try {
      const configSuccess = await proxyClient.configureProxy(
        host,
        appEntry.name,
        appPort,
        projectName,
        healthPath
      );

      if (!configSuccess) {
        logger.error(`Failed to configure proxy for host ${host}`);
      } else {
        logger.verboseLog(
          `Configured proxy for ${host} → ${appEntry.name}:${appPort} (health: ${healthPath})`
        );
      }
    } catch (proxyError) {
      logger.error(`Error configuring proxy for host ${host}`, proxyError);
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
  const containerName = `${context.projectName}-${serviceEntry.name}`;

  try {
    await dockerClient.stopContainer(containerName);
    await dockerClient.removeContainer(containerName);
  } catch (e) {
    logger.warn(
      `Error stopping/removing old service container on ${serverHostname}: ${e}`
    );
  }

  const serviceContainerOptions = serviceEntryToContainerOptions(
    serviceEntry,
    context.secrets,
    context.projectName
  );

  logger.verboseLog(
    `Starting new service container ${containerName} on ${serverHostname}`
  );
  const createSuccess = await dockerClient.createContainer(
    serviceContainerOptions
  );

  if (!createSuccess) {
    throw new Error(`Failed to create container ${containerName}`);
  }
}

/**
 * Compares desired state with current state and determines required actions
 */
async function planStateReconciliation(
  context: DeploymentContext,
  dockerClient: DockerClient,
  serverHostname: string
): Promise<{
  servicesToRemove: string[]; // service names to remove
  servicesToDeploy: string[]; // service names to deploy/update
}> {
  logger.verboseLog(`Planning state reconciliation for ${serverHostname}...`);

  // Get current state from server
  const currentState = await dockerClient.getProjectCurrentState(
    context.projectName
  );

  // Determine desired services for this server
  const configuredServices = normalizeConfigEntries(context.config.services);
  const desiredServices = new Set<string>();

  configuredServices.forEach((service) => {
    if (service.servers && service.servers.includes(serverHostname)) {
      desiredServices.add(service.name);
    }
  });

  // Determine what to remove (services that exist but are not in config)
  const servicesToRemove: string[] = [];
  Object.keys(currentState.services).forEach((serviceName) => {
    if (!desiredServices.has(serviceName)) {
      servicesToRemove.push(serviceName);
    }
  });

  // Determine what to deploy (all desired services - deploy will handle updates)
  const servicesToDeploy = Array.from(desiredServices);

  logger.verboseLog(
    `State reconciliation plan for ${serverHostname}:
    - Services to remove: ${
      servicesToRemove.length > 0 ? servicesToRemove.join(", ") : "none"
    }
    - Services to deploy: ${
      servicesToDeploy.length > 0 ? servicesToDeploy.join(", ") : "none"
    }`
  );

  return {
    servicesToRemove,
    servicesToDeploy,
  };
}

/**
 * Removes orphaned services that are no longer in the configuration
 */
async function removeOrphanedServices(
  servicesToRemove: string[],
  dockerClient: DockerClient,
  serverHostname: string,
  projectName: string
): Promise<void> {
  if (servicesToRemove.length === 0) {
    return;
  }

  logger.verboseLog(
    `Removing ${servicesToRemove.length} orphaned service(s) from ${serverHostname}...`
  );

  for (const serviceName of servicesToRemove) {
    const containerName = `${projectName}-${serviceName}`;

    try {
      logger.verboseLog(`Removing orphaned service: ${serviceName}`);

      // Stop the container gracefully
      await dockerClient.stopContainer(containerName);

      // Remove the container
      await dockerClient.removeContainer(containerName);

      logger.verboseLog(
        `Successfully removed orphaned service: ${serviceName}`
      );
    } catch (error) {
      logger.warn(
        `Failed to remove orphaned service ${serviceName} on ${serverHostname}: ${error}`
      );
    }
  }
}

/**
 * Reconciles app state on a specific server - removes orphaned apps
 */
async function reconcileAppsOnServer(
  context: DeploymentContext,
  serverHostname: string
): Promise<void> {
  let sshClient: SSHClient | undefined;

  try {
    sshClient = await establishSSHConnection(
      serverHostname,
      context.config,
      context.secrets,
      context.verboseFlag
    );
    const dockerClient = new DockerClient(
      sshClient,
      serverHostname,
      context.verboseFlag
    );

    logger.verboseLog(`Planning app reconciliation for ${serverHostname}...`);

    // Get current app state from server
    const currentState = await dockerClient.getProjectCurrentState(
      context.projectName
    );

    // Determine desired apps for this server
    const configuredApps = normalizeConfigEntries(context.config.apps);
    const desiredApps = new Set<string>();

    configuredApps.forEach((app) => {
      if (app.servers && app.servers.includes(serverHostname)) {
        desiredApps.add(app.name);
      }
    });

    // Determine what to remove (apps that exist but are not in config)
    const appsToRemove: string[] = [];
    Object.keys(currentState.apps).forEach((appName) => {
      if (!desiredApps.has(appName)) {
        appsToRemove.push(appName);
      }
    });

    if (appsToRemove.length > 0) {
      logger.verboseLog(
        `Apps to remove from ${serverHostname}: ${appsToRemove.join(", ")}`
      );

      await removeOrphanedApps(
        appsToRemove,
        dockerClient,
        serverHostname,
        context.projectName
      );
    } else {
      logger.verboseLog(`No orphaned apps to remove from ${serverHostname}`);
    }
  } catch (error) {
    logger.error(`Failed to reconcile apps on ${serverHostname}: ${error}`);
    throw error;
  } finally {
    if (sshClient) {
      await sshClient.close();
    }
  }
}

/**
 * Removes orphaned apps that are no longer in the configuration
 */
async function removeOrphanedApps(
  appsToRemove: string[],
  dockerClient: DockerClient,
  serverHostname: string,
  projectName: string
): Promise<void> {
  if (appsToRemove.length === 0) {
    return;
  }

  logger.verboseLog(
    `Removing ${appsToRemove.length} orphaned app(s) from ${serverHostname}...`
  );

  for (const appName of appsToRemove) {
    try {
      logger.verboseLog(`Removing orphaned app: ${appName}`);

      // Find all containers for this app (both blue and green)
      const appContainers = await dockerClient.findContainersByLabel(
        `luma.app=${appName}`
      );

      if (appContainers.length > 0) {
        logger.verboseLog(
          `Found ${
            appContainers.length
          } containers for app ${appName}: ${appContainers.join(", ")}`
        );

        // Stop and remove all containers for this app
        for (const containerName of appContainers) {
          try {
            await dockerClient.stopContainer(containerName);
            await dockerClient.removeContainer(containerName);
            logger.verboseLog(`Removed container: ${containerName}`);
          } catch (containerError) {
            logger.warn(
              `Failed to remove container ${containerName}: ${containerError}`
            );
          }
        }
      }

      logger.verboseLog(`Successfully removed orphaned app: ${appName}`);
    } catch (error) {
      logger.warn(
        `Failed to remove orphaned app ${appName} on ${serverHostname}: ${error}`
      );
    }
  }
}

/**
 * Transfers the image archive to the remote server and loads it
 */
async function transferAndLoadImage(
  appEntry: AppEntry,
  sshClient: any,
  dockerClientRemote: DockerClient,
  context: DeploymentContext,
  imageName: string
): Promise<void> {
  const archivePath = context.imageArchives?.get(appEntry.name);
  if (!archivePath) {
    throw new Error(`No archive found for app ${appEntry.name}`);
  }

  try {
    // Generate remote path for the archive
    const remoteArchivePath = `/tmp/luma-${appEntry.name}-${context.releaseId}.tar`;

    logger.verboseLog(`Transferring image archive to server...`);

    // Get file size for progress bar
    const fileStat = await stat(archivePath);
    const fileSizeKB = Math.round(fileStat.size / 1024);
    const fileSizeMB = (fileStat.size / 1024 / 1024).toFixed(2);

    logger.verboseLog(`File size: ${fileSizeMB} MB`);

    // Create progress bar for this server
    const progressBar = new cliProgress.SingleBar(
      {
        format: `   Uploading |{bar}| {percentage}% | {value}/{total} KB | Speed: {speed} KB/s`,
        barCompleteChar: "█",
        barIncompleteChar: "░",
        hideCursor: true,
        etaBuffer: 10,
      },
      cliProgress.Presets.shades_classic
    );

    let startTime = Date.now();
    let lastTransferred = 0;
    let lastTime = startTime;

    // Start progress bar
    progressBar.start(fileSizeKB, 0, { speed: "0" });

    // Upload with progress tracking
    await sshClient.uploadFile(
      archivePath,
      remoteArchivePath,
      (transferred: number, total: number) => {
        const transferredKB = Math.round(transferred / 1024);
        const currentTime = Date.now();
        const timeDiff = (currentTime - lastTime) / 1000; // seconds

        if (timeDiff > 0.1) {
          // Update speed every 100ms
          const bytesDiff = transferred - lastTransferred;
          const speed = Math.round(bytesDiff / 1024 / timeDiff);

          progressBar.update(transferredKB, { speed: speed.toString() });

          lastTransferred = transferred;
          lastTime = currentTime;
        }
      }
    );

    // Complete the progress bar
    progressBar.update(fileSizeKB, { speed: "Done" });
    progressBar.stop();

    logger.verboseLog(`✓ Upload complete`);

    // Load the image from archive
    logger.verboseLog(`Loading image ${imageName} from archive...`);
    await dockerClientRemote.loadImage(remoteArchivePath);
    logger.verboseLog(`✓ Image loaded successfully`);

    // Clean up remote archive
    await sshClient.exec(`rm -f ${remoteArchivePath}`);

    // Clean up local archive
    try {
      fs.unlinkSync(archivePath);
      // Also try to remove the temp directory if it's empty
      const tempDir = path.dirname(archivePath);
      try {
        fs.rmdirSync(tempDir);
      } catch (e) {
        // Ignore if directory is not empty or already removed
      }
      logger.verboseLog(`Cleaned up local archive ${archivePath}`);
    } catch (cleanupError) {
      logger.verboseLog(
        `Warning: Failed to clean up local archive: ${cleanupError}`
      );
    }
  } catch (error) {
    logger.error(`Failed to transfer and load image ${imageName}`, error);
    throw error;
  }
}

/**
 * Main deployment command that orchestrates the entire deployment process
 */
export async function deployCommand(rawEntryNamesAndFlags: string[]) {
  try {
    const { entryNames, forceFlag, deployServicesFlag, verboseFlag } =
      parseDeploymentArgs(rawEntryNamesAndFlags);

    // Set logger verbose mode
    logger = new Logger({ verbose: verboseFlag });

    // Generate release ID first for the startup message
    const releaseId = await generateReleaseId();
    logger.deploymentStart(releaseId);

    // Check git status
    logger.phase("Configuration loading");
    await checkUncommittedChanges(forceFlag);
    logger.phaseComplete("Configuration loaded");

    logger.phase("Verifying git status");
    const { config, secrets } = await loadConfigurationAndSecrets();
    logger.phaseComplete("Git status verified");

    const targetEntries = identifyTargetEntries(
      entryNames,
      deployServicesFlag,
      config
    );
    if (targetEntries.length === 0) {
      logger.error("No entries selected for deployment");
      return;
    }

    const projectName = config.name;
    const networkName = getProjectNetworkName(projectName);

    // Verify infrastructure
    logger.phase("Checking infrastructure");
    await verifyInfrastructure(
      targetEntries,
      config,
      secrets,
      networkName,
      verboseFlag
    );
    logger.phaseComplete("Infrastructure ready");

    const context: DeploymentContext = {
      config,
      secrets,
      targetEntries,
      releaseId,
      projectName,
      networkName,
      forceFlag,
      deployServicesFlag,
      verboseFlag,
    };

    await deployEntries(context);

    // Collect URLs for final output
    const urls: string[] = [];
    if (!deployServicesFlag) {
      for (const entry of targetEntries) {
        const appEntry = entry as AppEntry;
        if (appEntry.proxy?.hosts) {
          for (const host of appEntry.proxy.hosts) {
            urls.push(`https://${host}`);
          }
        }
      }
    }

    logger.deploymentComplete(urls);
  } catch (error) {
    logger.deploymentFailed(error);
    process.exit(1);
  } finally {
    logger.cleanup();
  }
}
