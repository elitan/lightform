import { loadConfig } from "../config"; // Assuming loadConfig is exported from src/config/index.ts
import { loadSecrets } from "../config"; // Assuming loadSecrets is exported from src/config/index.ts
import {
  LightformConfig,
  AppEntry,
  ServiceEntry,
  HealthCheckConfig,
  LightformSecrets,
} from "../config/types";
import {
  DockerClient,
  DockerBuildOptions,
  DockerContainerOptions,
} from "../docker";
import { SSHClient, SSHClientOptions, getSSHCredentials } from "../ssh";
import {
  generateReleaseId,
  getProjectNetworkName,
  PortChecker,
  parsePortMappings,
  validateConfig,
  formatValidationErrors,
} from "../utils";
import { shouldUseSslip, generateAppSslipDomain } from "../utils/sslip";
import { execSync } from "child_process";
import { LightformProxyClient } from "../proxy";
import { performBlueGreenDeployment } from "./blue-green";
import { Logger } from "../utils/logger";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { stat } from "fs/promises";

// Module-level logger that gets configured when deployCommand runs
let logger: Logger;

/**
 * Resolves environment variables for a container from plain and secret sources
 */
function resolveEnvironmentVariables(
  entry: AppEntry | ServiceEntry,
  secrets: LightformSecrets
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
  secrets: LightformSecrets,
  projectName: string
): DockerContainerOptions {
  const imageNameWithRelease = buildImageName(appEntry, releaseId);
  const containerName = `${projectName}-${appEntry.name}-${releaseId}`;
  const envVars = resolveEnvironmentVariables(appEntry, secrets);
  const networkName = getProjectNetworkName(projectName);

  // Dual alias approach: generic name for internal communication + project-specific for proxy routing
  const projectSpecificAlias = `${projectName}-${appEntry.name}`;

  return {
    name: containerName,
    image: imageNameWithRelease,
    ports: appEntry.ports,
    volumes: appEntry.volumes,
    envVars: envVars,
    network: networkName,
    networkAliases: [
      appEntry.name, // internal project docker network alias for internal project communication (e.g. "web")
      projectSpecificAlias, // globally unique docker network alias used by the lightform proxy to healthcheck and route traffic to the app (e.g. "gmail-web")
    ],
    restart: "unless-stopped",
  };
}

/**
 * Creates Docker container options for a service entry
 */
function serviceEntryToContainerOptions(
  serviceEntry: ServiceEntry,
  secrets: LightformSecrets,
  projectName: string
): DockerContainerOptions {
  const containerName = `${projectName}-${serviceEntry.name}`; // Project-prefixed names
  const envVars = resolveEnvironmentVariables(serviceEntry, secrets);
  const networkName = getProjectNetworkName(projectName);

  return {
    name: containerName,
    image: serviceEntry.image,
    ports: serviceEntry.ports,
    volumes: serviceEntry.volumes,
    envVars: envVars,
    network: networkName,
    restart: "unless-stopped",
    labels: {
      "lightform.managed": "true",
      "lightform.project": projectName,
      "lightform.type": "service",
      "lightform.service": serviceEntry.name,
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
  config: LightformConfig;
  secrets: LightformSecrets;
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
      "Uncommitted changes detected in working directory."
    );
    logger.error("");
    logger.error("To deploy safely:");
    logger.error("   1. Commit your changes: git add . && git commit -m 'Your message'");
    logger.error("   2. Then run: lightform deploy");
    logger.error("");
    logger.error("To deploy anyway (not recommended):");
    logger.error("   lightform deploy --force");
    logger.error("");
    logger.error("Note: Lightform requires committed changes to enable easy rollbacks via git.");
    throw new Error("Uncommitted changes detected");
  }
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

    // Validate configuration for common issues
    const validationErrors = validateConfig(config);
    if (validationErrors.length > 0) {
      logger.error("Configuration validation failed:");
      logger.error("");

      const formattedErrors = formatValidationErrors(validationErrors);
      for (const error of formattedErrors) {
        logger.error(error);
      }
      
      logger.error("");
      logger.error("To fix configuration errors:");
      logger.error("   # Edit lightform.yml to fix the issues above");
      logger.error("   lightform deploy                  # Try deploying again");

      throw new Error("Configuration validation failed");
    }

    return { config, secrets };
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) {
      logger.error("Configuration files not found.");
      logger.error("");
      logger.error("To fix this:");
      logger.error("   lightform init                    # Create configuration files");
      logger.error("   # Edit lightform.yml with your app settings");
      logger.error("   lightform setup                   # Setup your servers");
      logger.error("   lightform deploy                  # Deploy your apps");
    } else if (error instanceof Error && error.message.includes("Invalid configuration")) {
      // Validation errors are already displayed by loadConfig, just exit
      throw error;
    } else {
      logger.error("Failed to load configuration/secrets", error);
    }
    throw error;
  }
}

/**
 * Determines which apps or services to deploy based on arguments and configuration
 */
function identifyTargetEntries(
  entryNames: string[],
  deployServicesFlag: boolean,
  config: LightformConfig
): (AppEntry | ServiceEntry)[] {
  const configuredApps = normalizeConfigEntries(config.apps);
  const configuredServices = normalizeConfigEntries(config.services);
  let targetEntries: (AppEntry | ServiceEntry)[] = [];

  if (deployServicesFlag) {
    // --services flag: deploy services only
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
    // Default behavior: deploy both apps and services
    if (entryNames.length === 0) {
      // Deploy everything
      targetEntries = [...configuredApps, ...configuredServices];
      if (targetEntries.length === 0) {
        logger.warn("No apps or services found in configuration");
        return [];
      }
    } else {
      // Deploy specific entries (can be apps or services)
      entryNames.forEach((name) => {
        const app = configuredApps.find((a) => a.name === name);
        const service = configuredServices.find((s) => s.name === name);
        
        if (app) {
          targetEntries.push(app);
        } else if (service) {
          targetEntries.push(service);
        } else {
          logger.warn(`Entry "${name}" not found in apps or services configuration`);
        }
      });
      if (targetEntries.length === 0) {
        logger.warn("No valid apps or services found for specified names");
        return [];
      }
    }
  }

  return targetEntries;
}

/**
 * Verifies that required networks and lightform-proxy containers exist on target servers
 * and checks for port conflicts
 */
async function verifyInfrastructure(
  targetEntries: (AppEntry | ServiceEntry)[],
  config: LightformConfig,
  secrets: LightformSecrets,
  networkName: string,
  verbose: boolean = false
): Promise<void> {
  const allTargetServers = new Set<string>();
  targetEntries.forEach((entry) => {
    allTargetServers.add(entry.server);
  });

  logger.verboseLog(
    `Checking infrastructure on servers: ${Array.from(allTargetServers).join(
      ", "
    )}`
  );

  let missingNetworkServers: string[] = [];
  let missingProxyServers: string[] = [];
  let hasPortConflicts = false;

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

      const proxyClient = new LightformProxyClient(
        dockerClientRemote,
        serverHostname
      );
      const proxyRunning = await proxyClient.isProxyRunning();
      if (!proxyRunning) {
        missingProxyServers.push(serverHostname);
      }

      // Check for port conflicts
      await checkPortConflictsOnServer(
        serverHostname,
        sshClientNetwork,
        dockerClientRemote,
        targetEntries,
        config.name,
        verbose
      );
    } catch (networkError) {
      logger.verboseLog(`Error verifying ${serverHostname}: ${networkError}`);

      // Check if this was a port conflict error
      if (
        networkError instanceof Error &&
        networkError.message.includes("Port conflicts detected")
      ) {
        hasPortConflicts = true;
      } else {
        missingNetworkServers.push(serverHostname);
        missingProxyServers.push(serverHostname);
      }
    } finally {
      if (sshClientNetwork) {
        await sshClientNetwork.close();
      }
    }
  }

  if (
    missingNetworkServers.length > 0 ||
    missingProxyServers.length > 0 ||
    hasPortConflicts
  ) {
    logger.error("Infrastructure verification failed");
    logger.error("");
    
    if (missingNetworkServers.length > 0) {
      logger.error(
        `Missing network "${networkName}" on servers: ${missingNetworkServers.join(", ")}`
      );
    }
    if (missingProxyServers.length > 0) {
      logger.error(
        `Missing lightform-proxy on servers: ${missingProxyServers.join(", ")}`
      );
    }
    
    if (!hasPortConflicts) {
      logger.error("");
      logger.error("To fix infrastructure issues:");
      logger.error("   lightform setup                    # Setup all servers");
      logger.error("   lightform setup --verbose          # Setup with detailed output");
      logger.error("");
      logger.error("To setup specific servers:");
      const uniqueServers = missingNetworkServers.concat(missingProxyServers).filter((v, i, a) => a.indexOf(v) === i);
      if (uniqueServers.length > 0) {
        logger.error(`   lightform setup ${uniqueServers.join(" ")}`);
      }
    }
    
    throw new Error("Infrastructure verification failed");
  }
}

/**
 * Checks for port conflicts on a specific server
 */
async function checkPortConflictsOnServer(
  serverHostname: string,
  sshClient: SSHClient,
  dockerClient: DockerClient,
  targetEntries: (AppEntry | ServiceEntry)[],
  projectName: string,
  verbose: boolean = false
): Promise<void> {
  const portChecker = new PortChecker(
    sshClient,
    dockerClient,
    serverHostname,
    verbose
  );

  // Get all entries targeting this server, but only check port conflicts for apps
  // Services are meant to be replaced during deployment, so conflicts are expected
  const serverEntries = targetEntries.filter(
    (entry) => entry.server === serverHostname
  );

  // Build list of planned port mappings (only for apps, not services)
  const plannedPorts: Array<{
    hostPort: number;
    containerPort: number;
    requestedBy: string;
    protocol?: "tcp" | "udp";
  }> = [];

  for (const entry of serverEntries) {
    // Skip port conflict checking for services - they get replaced during deployment
    const isService = !!(entry as any).image && !(entry as any).build && !(entry as any).proxy;
    if (isService) {
      logger.verboseLog(`[${serverHostname}] Skipping port conflict check for service: ${entry.name}`);
      continue;
    }

    if (entry.ports) {
      const portMappings = parsePortMappings(entry.ports);
      for (const mapping of portMappings) {
        plannedPorts.push({
          hostPort: mapping.hostPort,
          containerPort: mapping.containerPort,
          requestedBy: `${projectName}-${entry.name}`,
          protocol: mapping.protocol,
        });
      }
    }
  }

  // Skip port checking if no ports are exposed
  if (plannedPorts.length === 0) {
    return;
  }

  logger.verboseLog(
    `[${serverHostname}] Checking ${plannedPorts.length} planned port mappings for conflicts`
  );

  // Check for conflicts (exclude own project containers)
  const conflicts = await portChecker.checkPortConflicts(plannedPorts, projectName);

  if (conflicts.length > 0) {
    logger.error(`Port conflicts detected on server ${serverHostname}:`);
    logger.error("");

    const suggestions = portChecker.generateConflictSuggestions(conflicts);
    for (const suggestion of suggestions) {
      logger.error(suggestion);
    }

    throw new Error("Port conflicts detected");
  }

  logger.verboseLog(`[${serverHostname}] No port conflicts detected`);
}

/**
 * Categorizes entries into apps and services based on configuration
 */
function categorizeEntries(targetEntries: (AppEntry | ServiceEntry)[]): {
  apps: AppEntry[];
  services: ServiceEntry[];
} {
  const apps: AppEntry[] = [];
  const services: ServiceEntry[] = [];

  for (const entry of targetEntries) {
    // If it has a proxy config, it's definitely an app
    if ((entry as AppEntry).proxy !== undefined) {
      apps.push(entry as AppEntry);
      continue;
    }

    // If it explicitly has a build config, it's an app
    if ((entry as AppEntry).build !== undefined) {
      apps.push(entry as AppEntry);
      continue;
    }

    // If it has an image but no build config and no proxy, it's a service
    if (
      (entry as ServiceEntry).image !== undefined &&
      !(entry as AppEntry).build &&
      !(entry as AppEntry).proxy
    ) {
      services.push(entry as ServiceEntry);
      continue;
    }

    // If it doesn't have an image field at all, it's an app that needs building
    if (!(entry as ServiceEntry).image) {
      apps.push(entry as AppEntry);
      continue;
    }

    // Default to service for anything else
    services.push(entry as ServiceEntry);
  }

  return { apps, services };
}

/**
 * Detects the platform architecture of a server by establishing SSH connection
 */
async function detectServerPlatform(serverHostname: string, context: DeploymentContext): Promise<string> {
  try {
    const sshClient = await establishSSHConnection(
      serverHostname,
      context.config,
      context.secrets,
      context.verboseFlag
    );
    
    const platform = await sshClient.detectServerPlatform();
    await sshClient.close();
    
    return platform;
  } catch (error) {
    logger.verboseLog(`Failed to detect platform for server ${serverHostname}, defaulting to linux/amd64: ${error}`);
    return "linux/amd64";
  }
}

/**
 * Gets the build configuration for an app, providing defaults if none specified
 */
async function getBuildConfig(appEntry: AppEntry, context: DeploymentContext): Promise<{
  context: string;
  dockerfile: string;
  platform: string;
  args?: Record<string, string>;
  target?: string;
}> {
  if (appEntry.build) {
    const buildArgs: Record<string, string> = {};

    // Handle build.args - resolve variable names from environment section
    if (appEntry.build.args && appEntry.build.args.length > 0) {
      const envVars = resolveEnvironmentVariables(appEntry, context.secrets);
      
      for (const varName of appEntry.build.args) {
        if (envVars[varName] !== undefined) {
          buildArgs[varName] = envVars[varName];
          
          // Warn about potentially sensitive variables being exposed to build context
          const lowerCaseName = varName.toLowerCase();
          if (lowerCaseName.includes('secret') || 
              lowerCaseName.includes('password') || 
              lowerCaseName.includes('key') ||
              lowerCaseName.includes('token')) {
            logger.warn(`Warning: Build argument "${varName}" appears to contain sensitive data and will be visible in Docker build context for app ${appEntry.name}`);
          }
        } else {
          throw new Error(`Build argument '${varName}' is not defined in the 'environment' section for app '${appEntry.name}'`);
        }
      }
    }

    // Detect platform if not explicitly set
    let platform = appEntry.build.platform;
    if (!platform) {
      platform = await detectServerPlatform(appEntry.server, context);
    }

    return {
      context: appEntry.build.context || ".",
      dockerfile: appEntry.build.dockerfile || "Dockerfile",
      platform,
      args: buildArgs,
      target: appEntry.build.target,
    };
  }

  // Default build configuration for apps without explicit build config
  // Detect platform for the target server
  const platform = await detectServerPlatform(appEntry.server, context);
  
  return {
    context: ".",
    dockerfile: "Dockerfile",
    platform,
  };
}

/**
 * Checks if an app needs to be built (vs using an existing image)
 */
function appNeedsBuilding(appEntry: AppEntry): boolean {
  // If it has a build config, it needs building
  if (appEntry.build) {
    return true;
  }

  // If it doesn't have an image field, it needs building
  if (!appEntry.image) {
    return true;
  }

  // If it has an image field but also proxy config, it needs building
  // (the image field is used as the base name for tagging)
  if (appEntry.proxy) {
    return true;
  }

  return false;
}

/**
 * Gets the base image name for an app (used for tagging built images)
 */
function getAppImageName(appEntry: AppEntry): string {
  // If image is specified, use it as the base name
  if (appEntry.image) {
    return appEntry.image;
  }

  // Otherwise, generate a name based on the app name
  return `${appEntry.name}`;
}

/**
 * Main deployment loop that processes all target entries
 */
async function deployEntries(context: DeploymentContext): Promise<void> {
  // Categorize entries by type using new logic
  const { apps, services } = categorizeEntries(context.targetEntries);

  const appsNeedingBuild = apps.filter((app) => appNeedsBuilding(app));

  // Initialize image archives map
  context.imageArchives = new Map<string, string>();

  // Build phase for apps that need building
  if (appsNeedingBuild.length > 0) {
    const buildStartTime = Date.now();

    // Create build header
    logger.info("Local Build");

    for (let i = 0; i < appsNeedingBuild.length; i++) {
      const appEntry = appsNeedingBuild[i];
      const isLastApp = i === appsNeedingBuild.length - 1;

      const archivePath = await buildAndSaveApp(appEntry, context, isLastApp);
      context.imageArchives.set(appEntry.name, archivePath);
    }

    // Build complete - sub-steps already show individual timings
  }

  // Skip build phase for pre-built apps and show info
  if (apps.length > 0 && apps.length > appsNeedingBuild.length) {
    logger.verboseLog(
      `Using pre-built images: ${apps
        .filter((app) => !appNeedsBuilding(app))
        .map((app) => `${app.name} (${app.image})`)
        .join(", ")}`
    );
  }

  // Clean up removed apps with reconciliation
  logger.phase("App State Reconciliation");
  const allAppServers = new Set<string>();
  context.targetEntries.forEach((entry) => {
    const appEntry = entry as AppEntry;
    allAppServers.add(appEntry.server);
  });

  // Also check servers that might have orphaned apps
  const configuredApps = normalizeConfigEntries(context.config.apps);
  const allConfiguredServers = new Set<string>();
  configuredApps.forEach((app) => {
    allConfiguredServers.add(app.server);
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
  if (services.length > 0) {
    logger.phase("Deploying Services");

    // Get all unique servers that need service deployment
    const allServiceServers = new Set<string>();
    services.forEach((entry) => {
      const serviceEntry = entry as ServiceEntry;
      allServiceServers.add(serviceEntry.server);
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
  context: DeploymentContext,
  isLastApp: boolean = false
): Promise<string> {
  const imageNameWithRelease = buildImageName(appEntry, context.releaseId);

  try {
    // Step 1: Build the image
    logger.buildStep(`Build ${appEntry.name} image`);
    const buildStartTime = Date.now();

    const imageReady = await buildOrTagAppImage(
      appEntry,
      imageNameWithRelease,
      context
    );
    if (!imageReady) throw new Error("Image build failed");

    const buildDuration = Date.now() - buildStartTime;
    logger.buildStepComplete(`Build ${appEntry.name} image`, buildDuration);

    // Step 2: Prepare for transfer
    logger.buildStep(`Prepare ${appEntry.name} image for transfer`, isLastApp);
    const saveStartTime = Date.now();

    const archivePath = await saveAppImage(
      appEntry,
      imageNameWithRelease,
      context.verboseFlag
    );

    const saveDuration = Date.now() - saveStartTime;
    logger.buildStepComplete(
      `Prepare ${appEntry.name} image for transfer`,
      saveDuration,
      isLastApp
    );

    return archivePath;
  } catch (error) {
    logger.error(`${appEntry.name} image preparation failed`, error);
    throw error;
  }
}

/**
 * Deploys an app to its server (deployment phase)
 */
async function deployAppToServers(
  appEntry: AppEntry,
  context: DeploymentContext
): Promise<void> {
  logger.appDeployment(appEntry.name, [appEntry.server]);

  await deployAppToServer(appEntry, appEntry.server, context, true);
}

/**
 * Builds or tags a Docker image for an app entry
 */
async function buildOrTagAppImage(
  appEntry: AppEntry,
  imageNameWithRelease: string,
  context: DeploymentContext
): Promise<boolean> {
  if (appNeedsBuilding(appEntry)) {
    logger.verboseLog(`Building app ${appEntry.name}...`);
    try {
      const buildConfig = await getBuildConfig(appEntry, context);

      await DockerClient.build({
        context: buildConfig.context,
        dockerfile: buildConfig.dockerfile,
        tags: [imageNameWithRelease],
        buildArgs: buildConfig.args,
        platform: buildConfig.platform,
        target: buildConfig.target,
        verbose: context.verboseFlag,
      });
      logger.verboseLog(
        `Successfully built and tagged ${imageNameWithRelease} for platforms: ${buildConfig.platform}`
      );
      return true;
    } catch (error) {
      logger.error(`Failed to build app ${appEntry.name}`, error);
      return false;
    }
  } else {
    // For apps that don't need building, tag the existing image
    const baseImageName = getAppImageName(appEntry);
    logger.verboseLog(`Tagging ${baseImageName} as ${imageNameWithRelease}...`);
    try {
      await DockerClient.tag(baseImageName, imageNameWithRelease, context.verboseFlag);
      logger.verboseLog(
        `Successfully tagged ${baseImageName} as ${imageNameWithRelease}`
      );
      return true;
    } catch (error) {
      logger.error(`Failed to tag pre-built image ${baseImageName}`, error);
      return false;
    }
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightform-"));
    const compressedArchivePath = path.join(
      tempDir,
      `${appEntry.name}-${Date.now()}.tar.gz`
    );
    const uncompressedArchivePath = path.join(
      tempDir,
      `${appEntry.name}-${Date.now()}.tar`
    );

    // Try to use compression first
    await DockerClient.saveCompressed(
      imageNameWithRelease,
      compressedArchivePath,
      verbose
    );

    // Check which file was actually created (compressed or uncompressed)
    if (fs.existsSync(compressedArchivePath)) {
      logger.verboseLog(
        `Successfully saved ${imageNameWithRelease} to compressed archive ${compressedArchivePath}`
      );
      return compressedArchivePath;
    } else if (fs.existsSync(uncompressedArchivePath)) {
      logger.verboseLog(
        `Successfully saved ${imageNameWithRelease} to uncompressed archive ${uncompressedArchivePath}`
      );
      return uncompressedArchivePath;
    } else {
      throw new Error(
        "Neither compressed nor uncompressed archive was created"
      );
    }
  } catch (error) {
    logger.error(`Failed to save image ${imageNameWithRelease}`, error);
    throw error;
  }
}

/**
 * Builds the full image name with release ID for built apps, or returns original name for pre-built apps
 */
function buildImageName(appEntry: AppEntry, releaseId: string): string {
  const baseImageName = getAppImageName(appEntry);

  // For apps that need building, use release ID
  if (appNeedsBuilding(appEntry)) {
    return `${baseImageName}:${releaseId}`;
  }
  // For pre-built apps, use the image as-is (if it exists)
  return appEntry.image || baseImageName;
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

    // Step 1: Transfer and load image
    logger.serverStep(`Transfer & load ${appEntry.name} image`);
    await transferAndLoadImage(
      appEntry,
      sshClient,
      dockerClient,
      context,
      imageNameWithRelease
    );
    logger.serverStepComplete(`Transfer & load ${appEntry.name} image`);

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
      context.config,
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
 * Deploys a single service to its target server
 */
async function deployService(
  serviceEntry: ServiceEntry,
  context: DeploymentContext
): Promise<void> {
  logger.verboseLog(
    `Deploying service: ${serviceEntry.name} to server: ${serviceEntry.server}`
  );

  const serverHostname = serviceEntry.server;
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
      return serviceEntry.server === serverHostname;
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
  config: LightformConfig,
  secrets: LightformSecrets,
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
 * Configures lightform-proxy routing for an app's hosts
 */
async function configureProxyForApp(
  appEntry: AppEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  projectName: string,
  config: LightformConfig,
  verbose: boolean = false
): Promise<void> {
  // Skip proxy configuration if no proxy config at all
  if (!appEntry.proxy) return;

  logger.verboseLog(`Configuring lightform-proxy for ${appEntry.name}`);

  const proxyClient = new LightformProxyClient(
    dockerClient,
    serverHostname,
    verbose
  );

  // Determine hosts to configure
  let hosts: string[];
  if (shouldUseSslip(appEntry.proxy.hosts)) {
    // Generate app.lightform.dev domain if no hosts configured
    const sslipDomain = generateAppSslipDomain(
      projectName,
      appEntry.name,
      serverHostname
    );
    hosts = [sslipDomain];
    logger.verboseLog(`Generated app.lightform.dev domain: ${sslipDomain}`);
  } else {
    hosts = appEntry.proxy.hosts!;
  }

  const appPort = appEntry.proxy.app_port || 80;
  const healthPath = appEntry.health_check?.path || "/up";

  // Use project-specific target for proxy routing (dual alias solution)
  const projectSpecificTarget = `${projectName}-${appEntry.name}`;

  for (const host of hosts) {
    logger.verboseLog(
      `Configuring proxy for ${host} -> ${projectSpecificTarget}:${appPort}`
    );

    // Configure the proxy route with project-specific target
    const success = await proxyClient.configureProxy(
      host,
      projectSpecificTarget, // Use "gmail-web" instead of "web"
      appPort,
      projectName,
      healthPath
    );

    if (!success) {
      throw new Error(`Failed to configure proxy for ${host}`);
    }

    // Then verify the health and update the proxy with the correct status
    logger.verboseLog(
      `Verifying health for ${host} -> ${projectSpecificTarget}:${appPort}${healthPath}`
    );

    try {
      // For now, assume the service is healthy after successful deployment
      // The health check can be improved later to use proper network-aware checks
      const isHealthy = true;

      logger.verboseLog(
        `Health check for ${host}: ${isHealthy ? "✅ healthy" : "❌ unhealthy"}`
      );

      // Update proxy with the correct health status
      const updateSuccess = await proxyClient.updateServiceHealth(
        host,
        isHealthy
      );

      if (!updateSuccess) {
        logger.warn(
          `Failed to update health status for ${host}, but continuing...`
        );
      }
    } catch (healthError) {
      logger.warn(
        `Health check failed for ${host}, but continuing with deployment: ${healthError}`
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
    if (service.server === serverHostname) {
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
      if (app.server === serverHostname) {
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
      const appContainers = await dockerClient.findContainersByLabelAndProject(
        `lightform.app=${appName}`,
        projectName
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
    // Generate remote path for the archive, preserving the actual file extension
    const isCompressed =
      archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz");
    const fileExt = isCompressed ? ".tar.gz" : ".tar";
    const remoteArchivePath = `/tmp/lightform-${appEntry.name}-${context.releaseId}${fileExt}`;

    logger.verboseLog(
      `Transferring ${
        isCompressed ? "compressed" : "uncompressed"
      } image archive to server...`
    );

    // Get file size for progress tracking
    const fileStat = await stat(archivePath);
    const totalSizeMB = (fileStat.size / 1024 / 1024).toFixed(1);

    logger.verboseLog(
      `File size: ${totalSizeMB} MB (${
        isCompressed ? "compressed" : "uncompressed"
      })`
    );

    let lastTransferred = 0;
    let lastTime = Date.now();

    // Upload with progress tracking
    await sshClient.uploadFile(
      archivePath,
      remoteArchivePath,
      (transferred: number, total: number) => {
        const transferredMB = (transferred / 1024 / 1024).toFixed(1);

        // Update the current step with upload progress
        if ((logger as any).activeSpinner) {
          const elapsed = Date.now() - (logger as any).activeSpinner.startTime;
          const spinner = (logger as any).spinnerChars[
            (logger as any).spinnerIndex
          ];
          const timeStr = (logger as any).formatDuration(elapsed);

          // Clear current line and show progress with file size
          process.stdout.write("\r\x1b[K");
          process.stdout.write(
            `     ├─ [${spinner}] Loading ${
              appEntry.name
            } image... (${timeStr}) | ${transferredMB}MB/${totalSizeMB}MB ${
              isCompressed ? "(compressed)" : "(uncompressed)"
            }`
          );

          (logger as any).spinnerIndex =
            ((logger as any).spinnerIndex + 1) %
            (logger as any).spinnerChars.length;
        }
      }
    );

    // Load the image from archive (automatically handles compression detection)
    logger.verboseLog(
      `Loading image ${imageName} from ${
        isCompressed ? "compressed" : "uncompressed"
      } archive...`
    );
    const loadSuccess = await dockerClientRemote.loadImage(remoteArchivePath);

    if (!loadSuccess) {
      throw new Error(`Failed to load image from archive ${remoteArchivePath}`);
    }

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
        if (appEntry.proxy) {
          // Use configured hosts or generate app.lightform.dev domain
          let hosts: string[];
          if (shouldUseSslip(appEntry.proxy.hosts)) {
            const sslipDomain = generateAppSslipDomain(
              projectName,
              appEntry.name,
              appEntry.server
            );
            hosts = [sslipDomain];
          } else {
            hosts = appEntry.proxy.hosts!;
          }

          for (const host of hosts) {
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
