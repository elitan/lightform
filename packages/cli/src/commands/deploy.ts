import { loadConfig } from "../config"; // Assuming loadConfig is exported from src/config/index.ts
import { loadSecrets } from "../config"; // Assuming loadSecrets is exported from src/config/index.ts
import {
  IopConfig,
  AppEntry,
  ServiceEntry,
  HealthCheckConfig,
  IopSecrets,
} from "../config/types";
import {
  appNeedsBuilding,
  getAppImageName,
  buildImageName,
} from "../utils/image-utils";
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
  processVolumes,
  ensureProjectDirectories,
  sanitizeFolderName,
} from "../utils";
import { shouldUseSslip, generateAppSslipDomain } from "../utils/sslip";
import { setupIopProxy } from "../setup-proxy/index";
import { IopProxyClient } from "../proxy";
import { performBlueGreenDeployment } from "./blue-green";
import { Logger } from "../utils/logger";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { stat } from "fs/promises";

// Module-level logger that gets configured when deployCommand runs
let logger: Logger;

/**
 * Creates a config hash for a service entry (Docker Compose style)
 */
function createServiceConfigHash(serviceEntry: ServiceEntry): string {
  const configForHash = {
    image: serviceEntry.image,
    environment: {
      plain: serviceEntry.environment?.plain?.sort() || [],
      secret: serviceEntry.environment?.secret?.sort() || [],
    },
    ports: serviceEntry.ports?.sort() || [],
    volumes: serviceEntry.volumes?.sort() || [],
  };
  return require("crypto")
    .createHash("sha256")
    .update(JSON.stringify(configForHash))
    .digest("hex")
    .substring(0, 12);
}

/**
 * Resolves environment variables for a container from plain and secret sources
 */
function resolveEnvironmentVariables(
  entry: AppEntry | ServiceEntry,
  secrets: IopSecrets
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
 * Creates Docker container options for a service entry
 */
function serviceEntryToContainerOptions(
  serviceEntry: ServiceEntry,
  secrets: IopSecrets,
  projectName: string
): DockerContainerOptions {
  const containerName = `${projectName}-${serviceEntry.name}`; // Project-prefixed names
  const envVars = resolveEnvironmentVariables(serviceEntry, secrets);
  const networkName = getProjectNetworkName(projectName);
  const configHash = createServiceConfigHash(serviceEntry);

  return {
    name: containerName,
    image: serviceEntry.image,
    ports: serviceEntry.ports,
    volumes: processVolumes(serviceEntry.volumes, projectName),
    envVars: envVars,
    network: networkName,
    networkAliases: [serviceEntry.name], // Allow other containers to reach this service by name (e.g. "db", "meilisearch")
    restart: "unless-stopped",
    configHash, // Add for comparison
    labels: {
      "iop.managed": "true",
      "iop.project": projectName,
      "iop.type": "service",
      "iop.service": serviceEntry.name,
      "iop.config-hash": configHash, // Docker Compose style config tracking
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
  config: IopConfig;
  secrets: IopSecrets;
  targetApps: AppEntry[];
  targetServices: ServiceEntry[];
  releaseId: string;
  projectName: string;
  networkName: string;
  deployServicesFlag: boolean;
  verboseFlag: boolean;
  imageArchives?: Map<string, string>; // app name -> archive path
}

interface ParsedArgs {
  entryNames: string[];
  deployServicesFlag: boolean;
  verboseFlag: boolean;
}

/**
 * Parses command line arguments and extracts flags and entry names
 */
function parseDeploymentArgs(rawEntryNamesAndFlags: string[]): ParsedArgs {
  const deployServicesFlag = rawEntryNamesAndFlags.includes("--services");
  const verboseFlag = rawEntryNamesAndFlags.includes("--verbose");

  const entryNames = rawEntryNamesAndFlags.filter(
    (name) => name !== "--services" && name !== "--verbose"
  );

  return { entryNames, deployServicesFlag, verboseFlag };
}

/**
 * Loads and validates IOP configuration and secrets files
 */
async function loadConfigurationAndSecrets(): Promise<{
  config: IopConfig;
  secrets: IopSecrets;
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
      logger.error("   # Edit iop.yml to fix the issues above");
      logger.error("   iop deploy                  # Try deploying again");

      throw new Error("Configuration validation failed");
    }

    return { config, secrets };
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) {
      logger.error("Configuration files not found.");
      logger.error("");
      logger.error("To fix this:");
      logger.error(
        "   iop init                    # Create configuration files"
      );
      logger.error("   # Edit iop.yml with your app settings");
      logger.error("   iop setup                   # Setup your servers");
      logger.error("   iop deploy                  # Deploy your apps");
    } else if (
      error instanceof Error &&
      error.message.includes("Invalid configuration")
    ) {
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
  config: IopConfig
): { apps: AppEntry[]; services: ServiceEntry[] } {
  const configuredApps = normalizeConfigEntries(config.apps);
  const configuredServices = normalizeConfigEntries(config.services);
  let targetApps: AppEntry[] = [];
  let targetServices: ServiceEntry[] = [];

  if (deployServicesFlag) {
    // --services flag: deploy services only
    if (entryNames.length === 0) {
      targetServices = [...configuredServices];
      if (targetServices.length === 0) {
        logger.warn("No services found in configuration");
      }
    } else {
      entryNames.forEach((name) => {
        const service = configuredServices.find((s) => s.name === name);
        if (service) {
          targetServices.push(service);
        } else {
          logger.warn(`Service "${name}" not found in configuration`);
        }
      });
      if (targetServices.length === 0) {
        logger.warn("No valid services found for specified names");
      }
    }
  } else {
    // Default behavior: deploy both apps and services
    if (entryNames.length === 0) {
      // Deploy everything
      targetApps = [...configuredApps];
      targetServices = [...configuredServices];
      if (targetApps.length === 0 && targetServices.length === 0) {
        logger.warn("No apps or services found in configuration");
      }
    } else {
      // Deploy specific entries (can be apps or services)
      entryNames.forEach((name) => {
        const app = configuredApps.find((a) => a.name === name);
        const service = configuredServices.find((s) => s.name === name);

        if (app) {
          targetApps.push(app);
        } else if (service) {
          targetServices.push(service);
        } else {
          logger.warn(
            `Entry "${name}" not found in apps or services configuration`
          );
        }
      });
      if (targetApps.length === 0 && targetServices.length === 0) {
        logger.warn("No valid apps or services found for specified names");
      }
    }
  }

  logger.verboseLog(
    `Selected: ${targetApps.length} apps [${targetApps
      .map((a) => a.name)
      .join(", ")}], ${targetServices.length} services [${targetServices
      .map((s) => s.name)
      .join(", ")}]`
  );
  return { apps: targetApps, services: targetServices };
}

/**
 * Verifies that required networks and iop-proxy containers exist on target servers
 * and checks for port conflicts
 */
async function verifyInfrastructure(
  targetEntries: (AppEntry | ServiceEntry)[],
  config: IopConfig,
  secrets: IopSecrets,
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

      const proxyClient = new IopProxyClient(
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
        `Missing network "${networkName}" on servers: ${missingNetworkServers.join(
          ", "
        )}`
      );
    }
    if (missingProxyServers.length > 0) {
      logger.error(
        `Missing iop-proxy on servers: ${missingProxyServers.join(", ")}`
      );
    }

    if (!hasPortConflicts) {
      logger.error("");
      logger.error("To fix infrastructure issues:");
      logger.error("   iop setup                    # Setup all servers");
      logger.error(
        "   iop setup --verbose          # Setup with detailed output"
      );
      logger.error("");
      logger.error("To setup specific servers:");
      const uniqueServers = missingNetworkServers
        .concat(missingProxyServers)
        .filter((v, i, a) => a.indexOf(v) === i);
      if (uniqueServers.length > 0) {
        logger.error(`   iop setup ${uniqueServers.join(" ")}`);
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
  // Simple solution: Get existing project container ports and exclude them
  logger.verboseLog(
    `[${serverHostname}] Getting existing project containers...`
  );

  try {
    const projectContainerPorts = new Set<number>();

    // Get all containers from this project
    const containerOutput = await sshClient.exec(
      `docker ps --filter "name=${projectName}-" --format "{{.Ports}}"`
    );

    const portLines = containerOutput.split("\n").filter((line) => line.trim());
    for (const line of portLines) {
      // Extract host ports from format like "0.0.0.0:9002->5432/tcp, [::]:9002->5432/tcp"
      // Simple approach: find all ":PORT->" patterns
      const hostPortMatches = line.match(/:(\d+)->/g);
      if (hostPortMatches) {
        for (const portMatch of hostPortMatches) {
          // Extract just the port number from ":9002->"
          const port = parseInt(portMatch.replace(/[:->]/g, ""));
          if (port > 0) {
            projectContainerPorts.add(port);
            logger.verboseLog(
              `[${serverHostname}] Excluding existing project port: ${port}`
            );
          }
        }
      }
    }

    // Get all entries targeting this server
    const serverEntries = targetEntries.filter(
      (entry) => entry.server === serverHostname
    );

    // Build list of planned port mappings, excluding existing project ports
    const plannedPorts: Array<{
      hostPort: number;
      containerPort: number;
      requestedBy: string;
      protocol?: "tcp" | "udp";
    }> = [];

    for (const entry of serverEntries) {
      if (entry.ports) {
        const portMappings = parsePortMappings(entry.ports);
        for (const mapping of portMappings) {
          // Skip if this port is already used by our project
          if (projectContainerPorts.has(mapping.hostPort)) {
            logger.verboseLog(
              `[${serverHostname}] Skipping conflict check for port ${mapping.hostPort} - used by existing project container`
            );
            continue;
          }

          plannedPorts.push({
            hostPort: mapping.hostPort,
            containerPort: mapping.containerPort,
            requestedBy: `${projectName}-${entry.name}`,
            protocol: mapping.protocol,
          });
        }
      }
    }

    // Skip port checking if no ports need to be checked
    if (plannedPorts.length === 0) {
      logger.verboseLog(
        `[${serverHostname}] No new ports to check for conflicts`
      );
      return;
    }

    logger.verboseLog(
      `[${serverHostname}] Checking ${plannedPorts.length} new port mappings for conflicts`
    );

    // Use simple port checker (don't need the complex project filtering anymore)
    const portChecker = new PortChecker(
      sshClient,
      dockerClient,
      serverHostname,
      verbose
    );
    const conflicts = await portChecker.checkPortConflicts(plannedPorts);

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
  } catch (error) {
    if (error instanceof Error && error.message === "Port conflicts detected") {
      throw error;
    }
    logger.verboseLog(
      `[${serverHostname}] Warning: Could not check existing containers: ${error}`
    );
    // Continue with normal port checking if we can't get existing containers
  }
}

/**
 * Detects the platform architecture of a server by establishing SSH connection
 */
async function detectServerPlatform(
  serverHostname: string,
  context: DeploymentContext
): Promise<string> {
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
    logger.verboseLog(
      `Failed to detect platform for server ${serverHostname}, defaulting to linux/amd64: ${error}`
    );
    return "linux/amd64";
  }
}

/**
 * Gets the build configuration for an app, providing defaults if none specified
 */
async function getBuildConfig(
  appEntry: AppEntry,
  context: DeploymentContext
): Promise<{
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
          if (
            lowerCaseName.includes("secret") ||
            lowerCaseName.includes("password") ||
            lowerCaseName.includes("key") ||
            lowerCaseName.includes("token")
          ) {
            logger.warn(
              `Warning: Build argument "${varName}" appears to contain sensitive data and will be visible in Docker build context for app ${appEntry.name}`
            );
          }
        } else {
          throw new Error(
            `Build argument '${varName}' is not defined in the 'environment' section for app '${appEntry.name}'`
          );
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
 * Main deployment loop that processes all target entries
 */
async function deployEntries(context: DeploymentContext): Promise<void> {
  // Use apps and services directly from context
  const apps = context.targetApps;
  const services = context.targetServices;

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
  context.targetApps.forEach((entry) => {
    allAppServers.add(entry.server);
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
      await DockerClient.tag(
        baseImageName,
        imageNameWithRelease,
        context.verboseFlag
      );
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "iop-"));
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

    // Step 1: Ensure image is available
    if (appNeedsBuilding(appEntry)) {
      // For built apps, transfer and load the image
      logger.serverStep(`Transfer & load ${appEntry.name} image`);
      await transferAndLoadImage(
        appEntry,
        sshClient,
        dockerClient,
        context,
        imageNameWithRelease
      );
      logger.serverStepComplete(`Transfer & load ${appEntry.name} image`);
    } else {
      // For pre-built apps, pull the image from registry
      logger.serverStep(`Pull ${appEntry.name} image`);
      await authenticateAndPullImage(
        appEntry,
        dockerClient,
        context,
        imageNameWithRelease
      );
      logger.serverStepComplete(`Pull ${appEntry.name} image`);
    }

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
    const servicesToDeploy = context.targetServices.filter((entry) => {
      return entry.server === serverHostname;
    });

    // Deploy services sequentially to handle potential dependencies
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
    // Check if service needs updating before pulling image
    const needsUpdate = await serviceNeedsUpdate(
      serviceEntry,
      dockerClient,
      context
    );

    if (!needsUpdate) {
      logger.verboseLog(
        `✓ Service ${serviceEntry.name} is up-to-date, skipping recreation`
      );
      return;
    }

    // Only pull image if service needs updating
    logger.verboseLog(
      `↻ Service ${serviceEntry.name} needs update, pulling image...`
    );
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
      `✓ Service ${serviceEntry.name} deployed successfully to ${serverHostname}`
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
  config: IopConfig,
  secrets: IopSecrets,
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
 * Configures iop-proxy routing for an app's hosts
 */
async function configureProxyForApp(
  appEntry: AppEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  projectName: string,
  config: IopConfig,
  verbose: boolean = false
): Promise<void> {
  // Skip proxy configuration if no proxy config at all
  if (!appEntry.proxy) return;

  logger.verboseLog(`Configuring iop-proxy for ${appEntry.name}`);

  const proxyClient = new IopProxyClient(
    dockerClient,
    serverHostname,
    verbose
  );

  // Determine hosts to configure
  let hosts: string[];
  if (shouldUseSslip(appEntry.proxy.hosts)) {
    // Generate app.iop.run domain if no hosts configured
    const sslipDomain = generateAppSslipDomain(
      projectName,
      appEntry.name,
      serverHostname
    );
    hosts = [sslipDomain];
    logger.verboseLog(`Generated app.iop.run domain: ${sslipDomain}`);
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
/**
 * Pure function to check if service configuration has changed
 */
export function checkServiceConfigChanges(
  currentConfig: any,
  desiredConfig: any,
  containerName: string
): { hasChanges: boolean; reason?: string } {
  // Docker Compose approach: Compare config hashes (primary method)
  const currentConfigHash = currentConfig.Config?.Labels?.["iop.config-hash"];
  const desiredConfigHash = desiredConfig.configHash;

  if (currentConfigHash && desiredConfigHash) {
    // Both have hashes - this is the reliable comparison
    if (currentConfigHash !== desiredConfigHash) {
      return {
        hasChanges: true,
        reason: `Configuration changed (hash: ${currentConfigHash} → ${desiredConfigHash})`,
      };
    }
    // Hashes match - no changes needed
    return { hasChanges: false };
  } else {
    // Fallback for existing containers without config hash: upgrade them to hash-based tracking
    if (logger) {
      logger.verboseLog(
        `Service ${containerName} missing config hash, upgrading to hash-based tracking`
      );
    }
    return {
      hasChanges: true,
      reason: `Upgrading to hash-based configuration tracking`,
    };
  }
}

/**
 * Checks if a service container needs to be updated based on configuration changes
 */
export async function serviceNeedsUpdate(
  serviceEntry: ServiceEntry,
  dockerClient: DockerClient,
  context: DeploymentContext
): Promise<boolean> {
  const containerName = `${context.projectName}-${serviceEntry.name}`;

  try {
    // Check if container exists
    const containerExists = await dockerClient.containerExists(containerName);
    if (!containerExists) {
      logger.verboseLog(
        `Container ${containerName} does not exist, needs creation`
      );
      return true;
    }

    // Get current container configuration
    const currentConfig = await dockerClient.inspectContainer(containerName);

    if (!currentConfig) {
      logger.verboseLog(
        `Could not inspect ${containerName}, assuming needs update`
      );
      return true;
    }

    // Build desired configuration
    const desiredConfig = serviceEntryToContainerOptions(
      serviceEntry,
      context.secrets,
      context.projectName
    );

    // Check for changes
    const result = checkServiceConfigChanges(
      currentConfig,
      desiredConfig,
      containerName
    );

    if (result.hasChanges) {
      logger.verboseLog(
        `↻ Service ${containerName} needs update: ${result.reason}`
      );
      return true;
    }

    return false;
  } catch (error) {
    logger.verboseLog(
      `Error checking if ${containerName} needs update: ${error}, assuming needs update`
    );
    return true;
  }
}

async function replaceServiceContainer(
  serviceEntry: ServiceEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  context: DeploymentContext
): Promise<void> {
  const containerName = `${context.projectName}-${serviceEntry.name}`;

  // Note: needsUpdate check is now done before calling this function
  logger.verboseLog(
    `↻ Service ${serviceEntry.name} needs update, recreating container`
  );

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
        `iop.app=${appName}`,
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
    const remoteArchivePath = `/tmp/iop-${appEntry.name}-${context.releaseId}${fileExt}`;

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
 * Bootstrap a fresh server by connecting as root and setting up the iop user
 */
async function bootstrapFreshServer(
  serverHostname: string,
  config: IopConfig,
  secrets: IopSecrets,
  verbose: boolean = false
): Promise<void> {
  logger.verboseLog(`Attempting to bootstrap fresh server: ${serverHostname}`);

  // Try to connect as root
  const rootConfig = {
    ...config,
    ssh: { ...config.ssh, username: "root" },
  };

  const rootSshClient = await establishSSHConnection(
    serverHostname,
    rootConfig,
    secrets,
    verbose
  );

  try {
    await rootSshClient.connect();
    logger.verboseLog(`Connected to ${serverHostname} as root for bootstrap`);

    const dockerClient = new DockerClient(
      rootSshClient,
      serverHostname,
      verbose
    );

    // Install Docker and dependencies
    logger.verboseLog("Installing Docker and dependencies...");
    const installSuccess = await dockerClient.install();
    if (!installSuccess) {
      throw new Error("Failed to install Docker");
    }

    // Create iop user
    const username = config.ssh?.username || "iop";
    logger.verboseLog(`Creating user: ${username}`);

    try {
      await rootSshClient.exec(`useradd -m -s /bin/bash ${username}`);
    } catch (error) {
      // User might already exist, check if it does
      try {
        await rootSshClient.exec(`id ${username}`);
        logger.verboseLog(`User ${username} already exists`);
      } catch {
        throw new Error(`Failed to create user ${username}: ${error}`);
      }
    }

    // Add user to docker group
    await rootSshClient.exec(`usermod -aG docker ${username}`);

    // Set up SSH directory and authorized_keys
    await rootSshClient.exec(`mkdir -p /home/${username}/.ssh`);
    await rootSshClient.exec(
      `chown ${username}:${username} /home/${username}/.ssh`
    );
    await rootSshClient.exec(`chmod 700 /home/${username}/.ssh`);

    // Copy root's authorized_keys to the new user (if it exists)
    try {
      await rootSshClient.exec(
        `cp /root/.ssh/authorized_keys /home/${username}/.ssh/authorized_keys`
      );
      await rootSshClient.exec(
        `chown ${username}:${username} /home/${username}/.ssh/authorized_keys`
      );
      await rootSshClient.exec(
        `chmod 600 /home/${username}/.ssh/authorized_keys`
      );
      logger.verboseLog(`SSH keys copied to ${username}`);
    } catch (error) {
      logger.verboseLog(`No root SSH keys to copy: ${error}`);
    }

    // Add user to sudoers
    await rootSshClient.exec(
      `echo "${username} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${username}`
    );

    logger.verboseLog(`Fresh server ${serverHostname} bootstrap completed`);
  } finally {
    await rootSshClient.close();
  }
}

/**
 * Performs intelligent setup checks and auto-setup if needed
 * This replaces the need for a separate 'iop setup' command
 */
async function ensureInfrastructureReady(
  config: IopConfig,
  secrets: IopSecrets,
  servers: string[],
  verbose: boolean = false
): Promise<void> {
  logger.step("Ensuring infrastructure is ready");

  const startTime = Date.now();

  for (const server of servers) {
    let sshClient: SSHClient;
    let dockerClient: DockerClient;
    let isConnected = false;

    // Step 1: Try connecting as configured user
    try {
      sshClient = await establishSSHConnection(
        server,
        config,
        secrets,
        verbose
      );
      await sshClient.connect();
      isConnected = true;
      logger.verboseLog(`Connected to ${server} as configured user`);
    } catch (error) {
      logger.verboseLog(
        `Failed to connect as configured user to ${server}, attempting fresh server bootstrap`
      );

      // Step 2: Try bootstrap as root for fresh server
      try {
        await bootstrapFreshServer(server, config, secrets, verbose);
        logger.verboseLog(`Fresh server ${server} bootstrapped successfully`);

        // Step 3: Try connecting as configured user again after bootstrap
        sshClient = await establishSSHConnection(
          server,
          config,
          secrets,
          verbose
        );
        await sshClient.connect();
        isConnected = true;
        logger.verboseLog(
          `Connected to ${server} as configured user after bootstrap`
        );
      } catch (bootstrapError) {
        throw new Error(
          `Failed to bootstrap server ${server}: ${bootstrapError}`
        );
      }
    }

    if (!isConnected) {
      throw new Error(`Could not establish connection to ${server}`);
    }

    dockerClient = new DockerClient(sshClient);

    try {
      // Fast checks first (parallel where possible)
      const [networkExists, proxyRunning, directoriesExist] = await Promise.all(
        [
          dockerClient.networkExists(getProjectNetworkName(config.name!)),
          dockerClient.containerExists("iop-proxy"),
          checkProjectDirectoriesExist(sshClient, config.name!),
        ]
      );

      // Only do work that's actually needed
      const tasks = [];

      if (!networkExists) {
        tasks.push(() =>
          dockerClient.createNetwork({
            name: getProjectNetworkName(config.name!),
          })
        );
      }

      if (!directoriesExist) {
        tasks.push(() => ensureProjectDirectories(sshClient, config.name!));
      }

      if (!proxyRunning) {
        tasks.push(() => setupIopProxy(server, sshClient, false));
      }

      // Always ensure proxy is connected to project network (needed for health checks)
      const projectNetworkName = getProjectNetworkName(config.name!);
      tasks.push(async () => {
        const isProxyConnected =
          await dockerClient.isContainerConnectedToNetwork(
            "iop-proxy",
            projectNetworkName
          );
        if (!isProxyConnected) {
          logger.verboseLog(`Connecting iop-proxy to ${projectNetworkName}`);
          await dockerClient.connectContainerToNetwork(
            "iop-proxy",
            projectNetworkName
          );
        }
      });

      // Execute only needed tasks
      if (tasks.length > 0) {
        logger.verboseLog(
          `Infrastructure needs ${tasks.length} updates for ${server}`
        );
        for (const task of tasks) {
          await task();
        }
      } else {
        logger.verboseLog(`Infrastructure already ready for ${server}`);
      }
    } finally {
      await sshClient.close();
    }
  }

  const elapsed = Date.now() - startTime;
  logger.stepComplete(`Infrastructure ready (${elapsed}ms)`);
}

async function checkProjectDirectoriesExist(
  sshClient: SSHClient,
  projectName: string
): Promise<boolean> {
  try {
    const sanitizedName = sanitizeFolderName(projectName);
    await sshClient.exec(`test -d ~/.iop/projects/${sanitizedName}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Main deployment command that orchestrates the entire deployment process
 */
export async function deployCommand(rawEntryNamesAndFlags: string[]) {
  try {
    const { entryNames, deployServicesFlag, verboseFlag } = parseDeploymentArgs(
      rawEntryNamesAndFlags
    );

    // Set logger verbose mode
    logger = new Logger({ verbose: verboseFlag });

    // Generate release ID first for the startup message
    const releaseId = await generateReleaseId();
    logger.deploymentStart(releaseId);

    // Load configuration
    logger.phase("Configuration loading");

    const { config, secrets } = await loadConfigurationAndSecrets();
    logger.phaseComplete("Configuration loaded");

    const { apps: targetApps, services: targetServices } =
      identifyTargetEntries(entryNames, deployServicesFlag, config);
    if (targetApps.length === 0 && targetServices.length === 0) {
      logger.error("No entries selected for deployment");
      return;
    }

    const projectName = config.name;
    const networkName = getProjectNetworkName(projectName);

    // Ensure infrastructure is ready (auto-setup if needed)
    const allTargetServers = new Set<string>();
    [...targetApps, ...targetServices].forEach((entry) => {
      allTargetServers.add(entry.server);
    });

    await ensureInfrastructureReady(
      config,
      secrets,
      Array.from(allTargetServers),
      verboseFlag
    );

    const context: DeploymentContext = {
      config,
      secrets,
      targetApps,
      targetServices,
      releaseId,
      projectName,
      networkName,
      deployServicesFlag,
      verboseFlag,
    };

    await deployEntries(context);

    // Collect URLs for final output
    const urls: string[] = [];
    if (!deployServicesFlag) {
      for (const entry of targetApps) {
        const appEntry = entry;
        if (appEntry.proxy) {
          // Use configured hosts or generate app.iop.run domain
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
