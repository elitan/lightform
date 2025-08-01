import { loadConfig } from "../config"; // Assuming loadConfig is exported from src/config/index.ts
import { loadSecrets } from "../config"; // Assuming loadSecrets is exported from src/config/index.ts
import {
  IopConfig,
  ServiceEntry,
  HealthCheckConfig,
  IopSecrets,
} from "../config/types";
import {
  serviceNeedsBuilding,
  getServiceImageName,
  buildServiceImageName,
} from "../utils/image-utils";
import {
  requiresZeroDowntimeDeployment,
  getDeploymentStrategy,
  getServiceProxyPort,
} from "../utils/service-utils";
import {
  createServiceFingerprint,
  shouldRedeploy,
  ServiceFingerprint,
  enrichFingerprintWithServerInfo,
  isBuiltService,
} from "../utils/service-fingerprint";
import {
  DockerClient,
  DockerBuildOptions,
  DockerContainerOptions,
} from "../docker";

// Deployment result tracking
export interface ServiceDeploymentResult {
  serviceName: string;
  status: 'deployed' | 'skipped';
  reason: string;
  url?: string;
}

export interface DeploymentSummary {
  deployed: ServiceDeploymentResult[];
  skipped: ServiceDeploymentResult[];
}

/**
 * Display comprehensive deployment summary showing all services
 */
function displayDeploymentSummary(results: ServiceDeploymentResult[], logger: Logger): void {
  
  const deployed = results.filter(r => r.status === 'deployed');
  const skipped = results.filter(r => r.status === 'skipped');
  const withUrls = results.filter(r => r.url);
  
  // Show deployment summary using consistent formatting
  console.log(`[✓] Deployment summary`);
  
  // Show all services with their status
  results.forEach((result, index) => {
    const isLast = index === results.length - 1;
    const symbol = isLast ? "└─" : "├─";
    const statusIcon = result.status === 'deployed' ? '✓' : '↻';
    const statusText = result.status === 'deployed' ? 'deployed' : 'skipped';
    console.log(`  ${symbol} [${statusIcon}] ${result.serviceName} (${statusText}: ${result.reason})`);
  });
  
  // Show URLs for services with proxy configuration
  if (withUrls.length > 0) {
    const isPlural = withUrls.length > 1;
    const appText = isPlural ? "apps are" : "app is";
    console.log(`\nYour ${appText} live at:`);
    withUrls.forEach((result, index) => {
      const isLast = index === withUrls.length - 1;
      const symbol = isLast ? "└─" : "├─";
      console.log(`  ${symbol} ${result.serviceName} → ${result.url}`);
    });
  }
}
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

// Removed: Now using enhanced fingerprinting from service-fingerprint.ts

/**
 * Resolves environment variables for a container from plain and secret sources
 */
function resolveEnvironmentVariables(
  entry: ServiceEntry,
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
  projectName: string,
  releaseId?: string,
  fingerprint?: ServiceFingerprint
): DockerContainerOptions {
  const containerName = `${projectName}-${serviceEntry.name}`; // Project-prefixed names
  const envVars = resolveEnvironmentVariables(serviceEntry, secrets);
  const networkName = getProjectNetworkName(projectName);
  
  // Get config hash from fingerprint if available
  const configHash = fingerprint?.configHash || "";

  // Determine the correct image name based on whether the service needs building
  let imageName: string;
  if (serviceNeedsBuilding(serviceEntry) && releaseId) {
    // For built services, use the release-tagged image name
    imageName = buildServiceImageName(serviceEntry, releaseId);
  } else {
    // For pre-built services, use the configured image
    imageName = serviceEntry.image!;
  }

  return {
    name: containerName,
    image: imageName,
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
      "iop.config-hash": configHash,
      // Add fingerprint labels if provided
      ...(fingerprint ? {
        "iop.fingerprint-type": fingerprint.type,
        "iop.secrets-hash": fingerprint.secretsHash,
        ...(fingerprint.type === 'built' ? {
          ...(fingerprint.localImageHash && { "iop.local-image-hash": fingerprint.localImageHash }),
          ...(fingerprint.serverImageHash && { "iop.server-image-hash": fingerprint.serverImageHash }),
        } : {
          ...(fingerprint.imageReference && { "iop.image-reference": fingerprint.imageReference }),
        }),
      } : {}),
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
  targetServices: ServiceEntry[]; // Unified: all entries are services
  releaseId: string;
  projectName: string;
  networkName: string;
  verboseFlag: boolean;
  imageArchives?: Map<string, string>; // service name -> archive path
  serviceFingerprints?: Map<string, ServiceFingerprint>; // service name -> fingerprint
}

interface ParsedArgs {
  entryNames: string[];
  verboseFlag: boolean;
}

/**
 * Parses command line arguments and extracts flags and entry names
 */
function parseDeploymentArgs(rawEntryNamesAndFlags: string[]): ParsedArgs {
  const verboseFlag = rawEntryNamesAndFlags.includes("--verbose");

  const entryNames = rawEntryNamesAndFlags.filter(
    (name) => name !== "--verbose"
  );

  return { entryNames, verboseFlag };
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
 * Determines which services to deploy based on arguments and configuration
 * Now uses unified services model (both apps and services are treated as services)
 */
function identifyTargetServices(
  entryNames: string[],
  config: IopConfig
): ServiceEntry[] {
  // Get all configured services
  const allServices = normalizeConfigEntries(config.services);
  
  let targetServices: ServiceEntry[] = [];

  if (entryNames.length === 0) {
    // Deploy all services
    targetServices = [...allServices];
    if (targetServices.length === 0) {
      logger.warn("No services found in configuration");
    }
  } else {
    // Deploy specific services by name
    entryNames.forEach((name) => {
      const service = allServices.find((s) => s.name === name);
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

  // Categorize services by deployment strategy
  const zeroDowntimeServices = targetServices.filter(s => requiresZeroDowntimeDeployment(s));
  const stopStartServices = targetServices.filter(s => !requiresZeroDowntimeDeployment(s));

  logger.verboseLog(
    `Selected: ${targetServices.length} services total - ${zeroDowntimeServices.length} zero-downtime [${zeroDowntimeServices
      .map((s) => s.name)
      .join(", ")}], ${stopStartServices.length} stop-start [${stopStartServices
      .map((s) => s.name)
      .join(", ")}]`
  );
  
  return targetServices;
}

/**
 * Verifies that required networks and iop-proxy containers exist on target servers
 * and checks for port conflicts
 */
async function verifyInfrastructure(
  targetEntries: ServiceEntry[],
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
  targetEntries: ServiceEntry[],
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
 * Gets the build configuration for a service, providing defaults if none specified
 */
async function getBuildConfig(
  serviceEntry: ServiceEntry,
  context: DeploymentContext
): Promise<{
  context: string;
  dockerfile: string;
  platform: string;
  args?: Record<string, string>;
  target?: string;
}> {
  return getServiceBuildConfig(serviceEntry, context);
}

/**
 * Main deployment loop that processes all target services with unified logic
 */
async function deployServices(context: DeploymentContext): Promise<ServiceDeploymentResult[]> {
  const services = context.targetServices;

  // Separate services by build requirements
  const servicesNeedingBuild = services.filter((service) => serviceNeedsBuilding(service));
  const preBuiltServices = services.filter((service) => !serviceNeedsBuilding(service));

  // Initialize image archives map
  context.imageArchives = new Map<string, string>();

  // Build phase for services that need building
  if (servicesNeedingBuild.length > 0) {
    const buildStartTime = Date.now();

    // Create build header
    logger.phaseStart("Building locally");

    // Build all services that need building
    for (let i = 0; i < servicesNeedingBuild.length; i++) {
      const serviceEntry = servicesNeedingBuild[i];
      const isLastBuild = i === servicesNeedingBuild.length - 1;

      const archivePath = await buildAndSaveService(serviceEntry, context, isLastBuild);
      context.imageArchives.set(serviceEntry.name, archivePath);
    }

    // Build complete - show checkmark
    logger.phaseEnd("Building locally");
  }

  // Show info about pre-built services
  if (preBuiltServices.length > 0) {
    logger.verboseLog(
      `Using pre-built images: ${preBuiltServices
        .map((service) => `${service.name} (${service.image})`)
        .join(", ")}`
    );
  }

  // Reconciliation phase - clean up orphaned services
  logger.phase("Reconciling state");
  const allServers = new Set<string>();
  services.forEach((service) => {
    allServers.add(service.server);
  });

  // Also check servers that might have orphaned services from config
  const configuredServices = normalizeConfigEntries(context.config.services);
  configuredServices.forEach((service) => {
    allServers.add(service.server);
  });

  for (const serverHostname of Array.from(allServers)) {
    await reconcileServicesOnServer(context, serverHostname);
  }
  logger.phaseComplete("Reconciling state");

  // Deployment phase - deploy services with appropriate strategy
  logger.phaseStart("Deploying services");
  
  // Group services by server for efficient deployment
  const servicesByServer = new Map<string, ServiceEntry[]>();
  for (const service of services) {
    if (!servicesByServer.has(service.server)) {
      servicesByServer.set(service.server, []);
    }
    servicesByServer.get(service.server)!.push(service);
  }

  // Deploy to each server and collect results
  const allResults: ServiceDeploymentResult[] = [];
  for (const [serverHostname, serverServices] of servicesByServer) {
    const serverResults = await deployServicesToServer(serverServices, context, serverHostname);
    allResults.push(...serverResults);
  }

  logger.phaseEnd("Deploying services");
  
  return allResults;
}

/**
 * Builds a service and saves it to a tar archive for transfer
 */
async function buildAndSaveService(
  serviceEntry: ServiceEntry,
  context: DeploymentContext,
  isLastService: boolean = false
): Promise<string> {
  const imageNameWithRelease = buildServiceImageName(serviceEntry, context.releaseId);

  try {
    // Step 1: Build the image
    logger.buildStep(`Build ${serviceEntry.name} image`);
    const buildStartTime = Date.now();

    const imageReady = await buildOrTagServiceImage(
      serviceEntry,
      imageNameWithRelease,
      context
    );
    if (!imageReady) throw new Error("Image build failed");

    const buildDuration = Date.now() - buildStartTime;
    logger.buildStepComplete(`Build ${serviceEntry.name} image`, buildDuration);

    // Step 2: Prepare for transfer
    logger.buildStep(`Package for transfer`, isLastService);
    const saveStartTime = Date.now();

    const archivePath = await saveServiceImage(
      serviceEntry,
      imageNameWithRelease,
      context.verboseFlag
    );

    const saveDuration = Date.now() - saveStartTime;
    logger.buildStepComplete(
      "Package for transfer",
      saveDuration,
      isLastService
    );

    return archivePath;
  } catch (error) {
    logger.error(`${serviceEntry.name} image preparation failed`, error);
    throw error;
  }
}

// Removed duplicate buildAndSaveService function

/**
 * Builds or tags a service image locally
 */
async function buildOrTagServiceImage(
  serviceEntry: ServiceEntry,
  imageNameWithRelease: string,
  context: DeploymentContext
): Promise<boolean> {
  if (serviceNeedsBuilding(serviceEntry)) {
    logger.verboseLog(`Building service ${serviceEntry.name}...`);
    try {
      const buildConfig = await getServiceBuildConfig(serviceEntry, context);

      // Create both release-specific and :latest tags for fingerprinting
      const baseImageName = getServiceImageName(serviceEntry);
      const latestTag = `${baseImageName}:latest`;
      
      await DockerClient.build({
        context: buildConfig.context,
        dockerfile: buildConfig.dockerfile,
        tags: [imageNameWithRelease, latestTag],
        buildArgs: buildConfig.args,
        platform: buildConfig.platform,
        target: buildConfig.target,
        verbose: context.verboseFlag,
      });
      logger.verboseLog(
        `Successfully built and tagged ${imageNameWithRelease} and ${latestTag} for platforms: ${buildConfig.platform}`
      );
      return true;
    } catch (error) {
      logger.error(`Failed to build service ${serviceEntry.name}`, error);
      return false;
    }
  } else {
    // For services that don't need building, tag the existing image
    const baseImageName = getServiceImageName(serviceEntry);
    const latestTag = `${baseImageName}:latest`;
    logger.verboseLog(`Tagging ${baseImageName} as ${imageNameWithRelease} and ${latestTag}...`);
    try {
      await DockerClient.tag(
        baseImageName,
        imageNameWithRelease,
        context.verboseFlag
      );
      
      // Also create :latest tag for fingerprinting
      await DockerClient.tag(
        baseImageName,
        latestTag,
        context.verboseFlag
      );
      
      logger.verboseLog(
        `Successfully tagged ${baseImageName} as ${imageNameWithRelease} and ${latestTag}`
      );
      return true;
    } catch (error) {
      logger.error(`Failed to tag pre-built image ${baseImageName}`, error);
      return false;
    }
  }
}

/**
 * Saves a service image to a tar archive for transfer
 */
async function saveServiceImage(
  serviceEntry: ServiceEntry,
  imageNameWithRelease: string,
  verbose: boolean = false
): Promise<string> {
  logger.verboseLog(`Saving image ${imageNameWithRelease} to archive...`);
  try {
    // Create a temporary directory for the archive
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "iop-"));
    const compressedArchivePath = path.join(
      tempDir,
      `${serviceEntry.name}-${Date.now()}.tar.gz`
    );
    const uncompressedArchivePath = path.join(
      tempDir,
      `${serviceEntry.name}-${Date.now()}.tar`
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
 * Gets the build configuration for a service, providing defaults if none specified
 */
async function getServiceBuildConfig(
  serviceEntry: ServiceEntry,
  context: DeploymentContext
): Promise<{
  context: string;
  dockerfile: string;
  platform: string;
  args?: Record<string, string>;
  target?: string;
}> {
  if (serviceEntry.build) {
    const buildArgs: Record<string, string> = {};

    // Handle build.args - resolve variable names from environment section
    if (serviceEntry.build.args && serviceEntry.build.args.length > 0) {
      const envVars = resolveEnvironmentVariables(serviceEntry, context.secrets);

      for (const varName of serviceEntry.build.args) {
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
              `Warning: Build argument "${varName}" appears to contain sensitive data and will be visible in Docker build context for service ${serviceEntry.name}`
            );
          }
        } else {
          throw new Error(
            `Build argument '${varName}' is not defined in the 'environment' section for service '${serviceEntry.name}'`
          );
        }
      }
    }

    // Detect platform if not explicitly set
    let platform = serviceEntry.build.platform;
    if (!platform) {
      platform = await detectServerPlatform(serviceEntry.server, context);
    }

    return {
      context: serviceEntry.build.context || ".",
      dockerfile: serviceEntry.build.dockerfile || "Dockerfile",
      platform,
      args: buildArgs,
      target: serviceEntry.build.target,
    };
  }

  // Default build configuration for services without explicit build config
  // Detect platform for the target server
  const platform = await detectServerPlatform(serviceEntry.server, context);

  return {
    context: ".",
    dockerfile: "Dockerfile",
    platform,
  };
}

// Removed: deployAppToServers - now handled by deployServicesToServer

// Removed: buildOrTagAppImage - now uses buildOrTagServiceImage

// Removed: saveAppImage - now uses saveServiceImage

// Removed: deployAppToServer - now handled by deployServiceWithStrategy

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
      sshClient,
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
/**
 * Deploy services to a specific server with unified deployment logic
 */
async function deployServicesToServer(
  services: ServiceEntry[],
  context: DeploymentContext,
  serverHostname: string
): Promise<ServiceDeploymentResult[]> {
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

    // Deploy each service with appropriate strategy and collect results
    const results: ServiceDeploymentResult[] = [];
    for (let i = 0; i < services.length; i++) {
      const service = services[i];
      const isLastService = i === services.length - 1;
      
      const result = await deployServiceWithStrategy(service, context, dockerClient, sshClient, serverHostname, isLastService);
      results.push(result);
    }
    
    return results;

  } finally {
    if (sshClient) {
      await sshClient.close();
    }
  }
}

/**
 * Deploy a single service using the appropriate strategy (zero-downtime vs stop-start)
 */
async function deployServiceWithStrategy(
  service: ServiceEntry,
  context: DeploymentContext,
  dockerClient: DockerClient,
  sshClient: SSHClient,
  serverHostname: string,
  isLastService: boolean = false
): Promise<ServiceDeploymentResult> {
  // Check if service needs redeployment using enhanced fingerprinting
  const currentFingerprint = await getCurrentServiceFingerprint(service, dockerClient, context);
  let desiredFingerprint = context.serviceFingerprints?.get(service.name);
  
  if (!desiredFingerprint) {
    throw new Error(`No fingerprint found for service ${service.name}`);
  }
  
  // Enrich desired fingerprint with server information for better comparison
  desiredFingerprint = await enrichFingerprintWithServerInfo(
    desiredFingerprint,
    service.name,
    context.projectName,
    sshClient
  );

  const redeployDecision = shouldRedeploy(currentFingerprint, desiredFingerprint);
  
  if (!redeployDecision.shouldRedeploy) {
    logger.verboseLog(`✓ Service ${service.name} is up-to-date (${redeployDecision.reason})`);
    logger.serviceDeploymentSkipped(service.name, "up-to-date, skipped", isLastService);
    
    // Generate URL if service has proxy configuration
    let url: string | undefined;
    if (service.proxy) {
      if (shouldUseSslip(service.proxy.hosts)) {
        const sslipDomain = generateAppSslipDomain(
          context.projectName,
          service.name,
          service.server
        );
        url = `https://${sslipDomain}`;
      } else if (service.proxy.hosts && service.proxy.hosts.length > 0) {
        url = `https://${service.proxy.hosts[0]}`;
      }
    }
    
    return {
      serviceName: service.name,
      status: 'skipped',
      reason: redeployDecision.reason,
      url,
    };
  }

  logger.verboseLog(
    `↻ Service ${service.name} needs deployment: ${redeployDecision.reason} (${redeployDecision.priority})`
  );

  // Start service deployment logging
  const strategy = getDeploymentStrategy(service);
  const strategyText = strategy === 'zero-downtime' ? 'zero-downtime deployment' : 'stop-start deployment';
  const deploymentStartTime = Date.now();
  logger.serviceDeploymentStep(service.name, strategyText, isLastService);

  // Ensure image is available
  await ensureServiceImageAvailable(service, context, dockerClient, sshClient);

  // Choose deployment strategy
  if (strategy === 'zero-downtime') {
    await deployServiceWithZeroDowntime(service, context, dockerClient, serverHostname, desiredFingerprint);
  } else {
    await deployServiceWithStopStart(service, context, dockerClient, serverHostname);
  }

  // Configure proxy if needed
  if (service.proxy) {
    await configureProxyForService(service, dockerClient, serverHostname, context);
  }

  // Complete service deployment logging
  const deploymentDuration = Date.now() - deploymentStartTime;
  logger.serviceDeploymentComplete(service.name, strategyText, deploymentDuration, isLastService);
  
  logger.verboseLog(`✓ Service ${service.name} deployed successfully to ${serverHostname}`);
  
  // Generate URL if service has proxy configuration
  let url: string | undefined;
  if (service.proxy) {
    if (shouldUseSslip(service.proxy.hosts)) {
      const sslipDomain = generateAppSslipDomain(
        context.projectName,
        service.name,
        service.server
      );
      url = `https://${sslipDomain}`;
    } else if (service.proxy.hosts && service.proxy.hosts.length > 0) {
      url = `https://${service.proxy.hosts[0]}`;
    }
  }
  
  return {
    serviceName: service.name,
    status: 'deployed',
    reason: redeployDecision.reason,
    url,
  };
}

/**
 * Deploy service using zero-downtime strategy (blue-green)
 */
async function deployServiceWithZeroDowntime(
  service: ServiceEntry,
  context: DeploymentContext,
  dockerClient: DockerClient,
  serverHostname: string,
  fingerprint: ServiceFingerprint
): Promise<void> {
  logger.verboseLog(`🚀 Deploying ${service.name} with zero-downtime strategy`);

  // Use the existing blue-green deployment logic
  const deploymentResult = await performBlueGreenDeployment({
    serviceEntry: service, // Updated to match BlueGreenDeploymentOptions interface
    releaseId: context.releaseId,
    secrets: context.secrets,
    projectName: context.projectName,
    networkName: context.networkName,
    dockerClient,
    serverHostname,
    verbose: context.verboseFlag,
    fingerprint, // Pass fingerprint for container labels
  });

  if (!deploymentResult.success) {
    throw new Error(deploymentResult.error || "Zero-downtime deployment failed");
  }
}

/**
 * Deploy service using stop-start strategy (for infrastructure services)
 */
async function deployServiceWithStopStart(
  service: ServiceEntry,
  context: DeploymentContext,
  dockerClient: DockerClient,
  serverHostname: string
): Promise<void> {
  logger.verboseLog(`🔄 Deploying ${service.name} with stop-start strategy`);

  const containerName = `${context.projectName}-${service.name}`;

  // Stop and remove existing container
  try {
    await dockerClient.stopContainer(containerName);
    await dockerClient.removeContainer(containerName);
    logger.verboseLog(`Stopped and removed existing container ${containerName}`);
  } catch (error) {
    // Container might not exist - that's ok
    logger.verboseLog(`No existing container to remove: ${error}`);
  }

  // Get the fingerprint for this service from context
  const fingerprint = context.serviceFingerprints?.get(service.name);
  if (!fingerprint) {
    throw new Error(`No fingerprint found for service ${service.name}`);
  }

  // Create new container with updated configuration and fingerprint labels
  const containerOptions = serviceEntryToContainerOptions(
    service,
    context.secrets,
    context.projectName,
    context.releaseId,
    fingerprint
  );

  const success = await dockerClient.createContainer(containerOptions);
  if (!success) {
    throw new Error(`Failed to create container ${containerName}`);
  }

  logger.verboseLog(`Created and started new container ${containerName}`);
}

/**
 * Ensure service image is available on the server
 */
async function ensureServiceImageAvailable(
  service: ServiceEntry,
  context: DeploymentContext,
  dockerClient: DockerClient,
  sshClient: SSHClient
): Promise<void> {
  if (serviceNeedsBuilding(service)) {
    // Transfer and load built image
    const imageNameWithRelease = buildServiceImageName(service, context.releaseId);
    await transferAndLoadServiceImage(service, sshClient, dockerClient, context, imageNameWithRelease);
  } else {
    // Pull pre-built image
    const imageName = service.image!;
    await authenticateAndPullImage(service, dockerClient, context, imageName);
  }
}

/**
 * Get current service fingerprint from deployed container
 */
async function getCurrentServiceFingerprint(
  service: ServiceEntry,
  dockerClient: DockerClient,
  context: DeploymentContext
): Promise<ServiceFingerprint | null> {
  try {
    let containerConfig: any = null;
    
    // For services that use zero-downtime deployment, check blue-green containers
    if (requiresZeroDowntimeDeployment(service)) {
      // Try to find active blue or green container
      const blueContainerName = `${context.projectName}-${service.name}-blue`;
      const greenContainerName = `${context.projectName}-${service.name}-green`;
      
      const blueExists = await dockerClient.containerExists(blueContainerName);
      const greenExists = await dockerClient.containerExists(greenContainerName);
      
      if (blueExists) {
        containerConfig = await dockerClient.inspectContainer(blueContainerName);
      } else if (greenExists) {
        containerConfig = await dockerClient.inspectContainer(greenContainerName);
      }
    } else {
      // For regular services, use the standard container name
      const containerName = `${context.projectName}-${service.name}`;
      const containerExists = await dockerClient.containerExists(containerName);
      if (containerExists) {
        containerConfig = await dockerClient.inspectContainer(containerName);
      }
    }
    
    if (!containerConfig) {
      return null; // First deployment
    }

    // Extract fingerprint from container labels
    const labels = containerConfig.Config?.Labels || {};
    const type = labels['iop.fingerprint-type'] as 'built' | 'external' || 'built';
    const configHash = labels['iop.config-hash'] || '';
    const secretsHash = labels['iop.secrets-hash'] || '';
    const localImageHash = labels['iop.local-image-hash'];
    const serverImageHash = labels['iop.server-image-hash'];
    const imageReference = labels['iop.image-reference'];

    if (type === 'built') {
      return {
        type: 'built',
        configHash,
        secretsHash,
        localImageHash,
        serverImageHash,
      };
    } else {
      return {
        type: 'external',
        configHash,
        secretsHash,
        imageReference,
      };
    }
  } catch (error) {
    // If we can't get current fingerprint, assume first deployment
    return null;
  }
}

/**
 * Unified service reconciliation - removes orphaned services
 */
async function reconcileServicesOnServer(
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

    // Get current state
    const currentState = await dockerClient.getProjectCurrentState(context.projectName);

    // Determine desired services from configuration
    const allConfiguredServices = normalizeConfigEntries(context.config.services);
    
    const desiredServices = new Set<string>();
    allConfiguredServices.forEach((service) => {
      if (service.server === serverHostname) {
        desiredServices.add(service.name);
      }
    });

    // Find orphaned services (exist but not in config)
    const servicesToRemove: string[] = [];
    
    // Check both apps and services in current state
    Object.keys(currentState.apps || {}).forEach((serviceName) => {
      if (!desiredServices.has(serviceName)) {
        servicesToRemove.push(serviceName);
      }
    });
    
    Object.keys(currentState.services || {}).forEach((serviceName) => {
      if (!desiredServices.has(serviceName)) {
        servicesToRemove.push(serviceName);
      }
    });

    // Remove orphaned services
    if (servicesToRemove.length > 0) {
      logger.verboseLog(
        `Removing ${servicesToRemove.length} orphaned service(s) from ${serverHostname}: ${servicesToRemove.join(', ')}`
      );

      for (const serviceName of servicesToRemove) {
        await removeOrphanedService(serviceName, dockerClient, serverHostname, context.projectName);
      }
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
  sshClient: SSHClient,
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

    // Handle image availability based on service type
    if (serviceNeedsBuilding(serviceEntry)) {
      // For built services, transfer and load the image
      logger.verboseLog(
        `↻ Service ${serviceEntry.name} needs update, transferring built image...`
      );
      const imageNameWithRelease = buildServiceImageName(serviceEntry, context.releaseId);
      await transferAndLoadServiceImage(
        serviceEntry,
        sshClient,
        dockerClient,
        context,
        imageNameWithRelease
      );
    } else {
      // For pre-built services, pull the image from registry
      logger.verboseLog(
        `↻ Service ${serviceEntry.name} needs update, pulling image...`
      );
      await authenticateAndPullImage(
        serviceEntry,
        dockerClient,
        context,
        serviceEntry.image!
      );
    }

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
  entry: ServiceEntry,
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
 * Remove a single orphaned service
 */
async function removeOrphanedService(
  serviceName: string,
  dockerClient: DockerClient,
  serverHostname: string,
  projectName: string
): Promise<void> {
  try {
    // Find all containers for this service (including blue/green variants)
    const serviceContainers = await dockerClient.findContainersByLabelAndProject(
      `iop.app=${serviceName}`,
      projectName
    );

    // Also check for service-labeled containers
    const serviceContainers2 = await dockerClient.findContainersByLabelAndProject(
      `iop.service=${serviceName}`,
      projectName
    );

    const allContainers = [...new Set([...serviceContainers, ...serviceContainers2])];

    if (allContainers.length > 0) {
      logger.verboseLog(
        `Found ${allContainers.length} containers for service ${serviceName}: ${allContainers.join(', ')}`
      );

      // Stop and remove all containers for this service
      for (const containerName of allContainers) {
        try {
          await dockerClient.stopContainer(containerName);
          await dockerClient.removeContainer(containerName);
          logger.verboseLog(`Removed container: ${containerName}`);
        } catch (containerError) {
          logger.verboseLog(`Failed to remove container ${containerName}: ${containerError}`);
        }
      }
    }

    logger.verboseLog(`Successfully removed orphaned service: ${serviceName}`);
  } catch (error) {
    logger.verboseLog(`Failed to remove orphaned service ${serviceName} on ${serverHostname}: ${error}`);
  }
}

/**
 * Configures iop-proxy routing for a service's hosts
 */
async function configureProxyForService(
  service: ServiceEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  context: DeploymentContext
): Promise<void> {
  // Skip proxy configuration if no proxy config at all
  if (!service.proxy) return;

  logger.verboseLog(`Configuring iop-proxy for ${service.name}`);

  const proxyClient = new IopProxyClient(
    dockerClient,
    serverHostname,
    context.verboseFlag
  );

  // Determine hosts to configure
  let hosts: string[];
  if (shouldUseSslip(service.proxy.hosts)) {
    // Generate app.iop.run domain if no hosts configured
    const sslipDomain = generateAppSslipDomain(
      context.projectName,
      service.name,
      serverHostname
    );
    hosts = [sslipDomain];
    logger.verboseLog(`Generated app.iop.run domain: ${sslipDomain}`);
  } else {
    hosts = service.proxy.hosts!;
  }

  const servicePort = getServiceProxyPort(service) || 80;
  const healthPath = service.health_check?.path || "/up";

  // Use project-specific target for proxy routing
  const projectSpecificTarget = `${context.projectName}-${service.name}`;

  for (const host of hosts) {
    logger.verboseLog(
      `Configuring proxy for ${host} -> ${projectSpecificTarget}:${servicePort}`
    );

    // Configure the proxy route with project-specific target
    const success = await proxyClient.configureProxy(
      host,
      projectSpecificTarget,
      servicePort,
      context.projectName,
      healthPath
    );

    if (!success) {
      throw new Error(`Failed to configure proxy for ${host}`);
    }

    // Verify health and update proxy status
    logger.verboseLog(
      `Verifying health for ${host} -> ${projectSpecificTarget}:${servicePort}${healthPath}`
    );

    try {
      // For now, assume the service is healthy after successful deployment
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
 * Configure proxy settings for a service
 */
async function configureProxyForApp(
  appEntry: ServiceEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  projectName: string,
  config: IopConfig,
  verbose: boolean = false
): Promise<void> {
  const context = { projectName, verboseFlag: verbose } as DeploymentContext;
  await configureProxyForService(appEntry, dockerClient, serverHostname, context);
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
    const fingerprint = context.serviceFingerprints?.get(serviceEntry.name);
    const desiredConfig = serviceEntryToContainerOptions(
      serviceEntry,
      context.secrets,
      context.projectName,
      context.releaseId,
      fingerprint
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

  const fingerprint = context.serviceFingerprints?.get(serviceEntry.name);
  const serviceContainerOptions = serviceEntryToContainerOptions(
    serviceEntry,
    context.secrets,
    context.projectName,
    context.releaseId,
    fingerprint
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
    Object.keys(currentState.apps).forEach((serviceName) => {
      if (!desiredServices.has(serviceName)) {
        servicesToRemove.push(serviceName);
      }
    });

    if (servicesToRemove.length > 0) {
      logger.verboseLog(
        `Services to remove from ${serverHostname}: ${servicesToRemove.join(", ")}`
      );

      await removeOrphanedApps(
        servicesToRemove,
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
  serviceEntry: ServiceEntry,
  sshClient: any,
  dockerClientRemote: DockerClient,
  context: DeploymentContext,
  imageName: string
): Promise<void> {
  return transferAndLoadServiceImage(serviceEntry, sshClient, dockerClientRemote, context, imageName);
}

/**
 * Transfers the service image archive to the remote server and loads it
 */
async function transferAndLoadServiceImage(
  serviceEntry: ServiceEntry,
  sshClient: any,
  dockerClientRemote: DockerClient,
  context: DeploymentContext,
  imageName: string
): Promise<void> {
  const archivePath = context.imageArchives?.get(serviceEntry.name);
  if (!archivePath) {
    throw new Error(`No archive found for service ${serviceEntry.name}`);
  }

  try {
    // Generate remote path for the archive, preserving the actual file extension
    const isCompressed =
      archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz");
    const fileExt = isCompressed ? ".tar.gz" : ".tar";
    const remoteArchivePath = `/tmp/iop-${serviceEntry.name}-${context.releaseId}${fileExt}`;

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
              serviceEntry.name
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

// Removed duplicate transferAndLoadServiceImage function

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
  logger.step("Preparing infrastructure");

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
  logger.stepComplete("Preparing infrastructure", elapsed);
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
    const { entryNames, verboseFlag } = parseDeploymentArgs(rawEntryNamesAndFlags);

    // Set logger verbose mode
    logger = new Logger({ verbose: verboseFlag });

    // Generate release ID first for the startup message
    const releaseId = await generateReleaseId();
    logger.deploymentStart(releaseId);

    // Load configuration
    logger.phase("Loading configuration");

    const { config, secrets } = await loadConfigurationAndSecrets();
    logger.phaseComplete("Loading configuration");

    const targetServices = identifyTargetServices(entryNames, config);
    if (targetServices.length === 0) {
      logger.error("No services selected for deployment");
      return;
    }

    const projectName = config.name;
    const networkName = getProjectNetworkName(projectName);

    // Ensure infrastructure is ready (auto-setup if needed)
    const allTargetServers = new Set<string>();
    targetServices.forEach((service) => {
      allTargetServers.add(service.server);
    });

    await ensureInfrastructureReady(
      config,
      secrets,
      Array.from(allTargetServers),
      verboseFlag
    );

    // Generate service fingerprints for smart redeployment
    const serviceFingerprints = new Map<string, ServiceFingerprint>();
    for (const service of targetServices) {
      const fingerprint = await createServiceFingerprint(service, secrets, config.name);
      serviceFingerprints.set(service.name, fingerprint);
    }

    const context: DeploymentContext = {
      config,
      secrets,
      targetServices,
      releaseId,
      projectName,
      networkName,
      verboseFlag,
      serviceFingerprints,
    };

    const deploymentResults = await deployServices(context);

    // Display deployment summary with all services
    displayDeploymentSummary(deploymentResults, logger);
  } catch (error) {
    logger.deploymentFailed(error);
    process.exit(1);
  } finally {
    logger.cleanup();
  }
}
