import { loadConfig, loadSecrets } from "../config";
import {
  LumaConfig,
  AppEntry,
  ServiceEntry,
  LumaSecrets,
} from "../config/types";
import { DockerClient } from "../docker";
import { SSHClient, getSSHCredentials, SSHClientOptions } from "../ssh";
import { Logger } from "../utils/logger";

// Module-level logger that gets configured when statusCommand runs
let logger: Logger;

interface StatusContext {
  config: LumaConfig;
  secrets: LumaSecrets;
  verboseFlag: boolean;
  verboseMessages: string[]; // Store verbose messages for later display
}

interface ParsedStatusArgs {
  entryNames: string[];
  verboseFlag: boolean;
}

interface AppStatus {
  name: string;
  status: "running" | "stopped" | "mixed" | "unknown";
  activeColor: "blue" | "green" | null;
  replicas: {
    total: number;
    running: number;
    blue: number;
    green: number;
  };
  lastDeployed?: string;
  servers: string[];
}

interface ServerAppStatus {
  activeColor: "blue" | "green" | null;
  blueContainers: string[];
  greenContainers: string[];
  runningContainers: string[];
}

/**
 * Parses command line arguments for status command
 */
function parseStatusArgs(
  args: string[],
  verbose: boolean = false
): ParsedStatusArgs {
  return {
    entryNames: args || [],
    verboseFlag: verbose,
  };
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
 * Normalizes configuration entries from object/array format to array format
 */
function normalizeConfigEntries(
  entries: Record<string, any> | Array<any> | undefined
): Array<any> {
  if (!entries) return [];
  if (Array.isArray(entries)) return entries;
  return Object.entries(entries).map(([name, entry]) => ({ ...entry, name }));
}

/**
 * Establishes SSH connection to a server for status checking
 */
async function establishSSHConnection(
  serverHostname: string,
  context: StatusContext
): Promise<SSHClient> {
  const sshCreds = await getSSHCredentials(
    serverHostname,
    context.config,
    context.secrets,
    context.verboseFlag
  );

  const sshOptions: SSHClientOptions = {
    ...sshCreds,
    host: sshCreds.host || serverHostname,
    username: sshCreds.username || "root",
    port: sshCreds.port || 22,
  };

  const sshClient = await SSHClient.create(sshOptions);
  await sshClient.connect();

  // Store verbose message instead of logging immediately
  if (context.verboseFlag) {
    context.verboseMessages.push(
      `SSH connection established to ${serverHostname}`
    );
  }
  return sshClient;
}

/**
 * Gets container information for an app on a specific server
 */
async function getAppContainersOnServer(
  appEntry: AppEntry,
  dockerClient: DockerClient
): Promise<{
  allContainers: string[];
  blueContainers: string[];
  greenContainers: string[];
  runningContainers: string[];
}> {
  const allContainers = await dockerClient.findContainersByLabel(
    `luma.app=${appEntry.name}`
  );

  const blueContainers: string[] = [];
  const greenContainers: string[] = [];
  const runningContainers: string[] = [];

  for (const containerName of allContainers) {
    const isRunning = await dockerClient.containerIsRunning(containerName);
    if (isRunning) {
      runningContainers.push(containerName);
    }

    const labels = await dockerClient.getContainerLabels(containerName);
    const color = labels["luma.color"];

    if (color === "blue") {
      blueContainers.push(containerName);
    } else if (color === "green") {
      greenContainers.push(containerName);
    }
  }

  return {
    allContainers,
    blueContainers,
    greenContainers,
    runningContainers,
  };
}

/**
 * Gets status information for a single app on a specific server
 */
async function getAppStatusOnServer(
  appEntry: AppEntry,
  serverHostname: string,
  context: StatusContext
): Promise<ServerAppStatus> {
  let sshClient: SSHClient | undefined;

  try {
    sshClient = await establishSSHConnection(serverHostname, context);
    const dockerClient = new DockerClient(
      sshClient,
      serverHostname,
      context.verboseFlag
    );

    // Get active color
    const activeColor = await dockerClient.getCurrentActiveColor(appEntry.name);

    // Get container information
    const containerInfo = await getAppContainersOnServer(
      appEntry,
      dockerClient
    );

    return {
      activeColor,
      blueContainers: containerInfo.blueContainers,
      greenContainers: containerInfo.greenContainers,
      runningContainers: containerInfo.runningContainers,
    };
  } catch (error) {
    // Store verbose message instead of logging immediately
    if (context.verboseFlag) {
      context.verboseMessages.push(
        `Failed to get status for ${appEntry.name} on ${serverHostname}: ${error}`
      );
    }
    return {
      activeColor: null,
      blueContainers: [],
      greenContainers: [],
      runningContainers: [],
    };
  } finally {
    if (sshClient) {
      await sshClient.close();
    }
  }
}

/**
 * Aggregates server statuses to determine overall app status
 */
function aggregateAppStatus(
  appEntry: AppEntry,
  serverStatuses: ServerAppStatus[]
): {
  totalRunning: number;
  totalBlue: number;
  totalGreen: number;
  activeColor: "blue" | "green" | null;
  status: "running" | "stopped" | "mixed" | "unknown";
} {
  let totalRunning = 0;
  let totalBlue = 0;
  let totalGreen = 0;
  let activeColors: ("blue" | "green" | null)[] = [];

  for (const serverStatus of serverStatuses) {
    totalRunning += serverStatus.runningContainers.length;
    totalBlue += serverStatus.blueContainers.length;
    totalGreen += serverStatus.greenContainers.length;
    activeColors.push(serverStatus.activeColor);
  }

  // Determine overall active color (should be consistent across servers)
  const uniqueActiveColors = [
    ...new Set(activeColors.filter((c) => c !== null)),
  ];
  const activeColor =
    uniqueActiveColors.length === 1 ? uniqueActiveColors[0] : null;

  // Determine overall status
  const expectedReplicas = (appEntry.replicas || 1) * appEntry.servers.length;
  let status: "running" | "stopped" | "mixed" | "unknown";

  if (totalRunning === 0) {
    status = "stopped";
  } else if (totalRunning >= expectedReplicas) {
    status = "running";
  } else {
    status = "mixed";
  }

  return {
    totalRunning,
    totalBlue,
    totalGreen,
    activeColor,
    status,
  };
}

/**
 * Gets comprehensive status for an app across all its servers
 */
async function getAppStatus(
  appEntry: AppEntry,
  context: StatusContext
): Promise<AppStatus> {
  const serverStatuses = await Promise.all(
    appEntry.servers.map((server) =>
      getAppStatusOnServer(appEntry, server, context)
    )
  );

  const aggregated = aggregateAppStatus(appEntry, serverStatuses);

  return {
    name: appEntry.name,
    status: aggregated.status,
    activeColor: aggregated.activeColor,
    replicas: {
      total: aggregated.totalBlue + aggregated.totalGreen,
      running: aggregated.totalRunning,
      blue: aggregated.totalBlue,
      green: aggregated.totalGreen,
    },
    servers: appEntry.servers,
  };
}

/**
 * Displays status information for an app in a formatted way
 */
function displayAppStatus(appStatus: AppStatus): void {
  const statusIcon = {
    running: "[✓]",
    stopped: "[✗]",
    mixed: "[!]",
    unknown: "[?]",
  }[appStatus.status];

  const versionDisplay = appStatus.activeColor
    ? `(${appStatus.activeColor} active)`
    : "(no active version)";

  console.log(`  └─ App: ${appStatus.name}`);
  console.log(
    `     ├─ Status: ${statusIcon} ${appStatus.status.toUpperCase()} ${versionDisplay}`
  );

  if (appStatus.replicas.total > 0) {
    console.log(
      `     ├─ Replicas: ${appStatus.replicas.running}/${appStatus.replicas.total} running`
    );

    if (appStatus.replicas.blue > 0 || appStatus.replicas.green > 0) {
      console.log(
        `     ├─ Versions: ${appStatus.replicas.blue} blue, ${appStatus.replicas.green} green`
      );
    }
  }

  console.log(
    `     ${
      appStatus.lastDeployed ? "├─" : "└─"
    } Servers: ${appStatus.servers.join(", ")}`
  );

  if (appStatus.lastDeployed) {
    console.log(`     └─ Last deployed: ${appStatus.lastDeployed}`);
  }

  console.log(); // Add spacing between apps
}

/**
 * Displays service information in a formatted way
 */
function displayServiceStatus(service: ServiceEntry): void {
  console.log(`  └─ Service: ${service.name}`);
  console.log(`     ├─ Image: ${service.image}`);
  console.log(`     └─ Servers: ${service.servers.join(", ")}`);
  console.log(); // Add spacing between services
}

/**
 * Filters apps and services based on requested entry names
 */
function filterEntriesByNames(
  entryNames: string[],
  apps: AppEntry[],
  services: ServiceEntry[]
): {
  filteredApps: AppEntry[];
  filteredServices: ServiceEntry[];
} {
  if (entryNames.length === 0) {
    return { filteredApps: apps, filteredServices: services };
  }

  const filteredApps = apps.filter((app) => entryNames.includes(app.name));
  const filteredServices = services.filter((service) =>
    entryNames.includes(service.name)
  );

  return { filteredApps, filteredServices };
}

/**
 * Validates that requested entries exist
 */
function validateRequestedEntries(
  entryNames: string[],
  filteredApps: AppEntry[],
  filteredServices: ServiceEntry[]
): boolean {
  if (
    entryNames.length > 0 &&
    filteredApps.length === 0 &&
    filteredServices.length === 0
  ) {
    logger.error(
      `No apps or services found with names: ${entryNames.join(", ")}`
    );
    return false;
  }
  return true;
}

/**
 * Handles the main status checking and display logic
 */
async function checkAndDisplayStatus(
  parsedArgs: ParsedStatusArgs,
  context: StatusContext
): Promise<void> {
  const apps = normalizeConfigEntries(context.config.apps) as AppEntry[];
  const services = normalizeConfigEntries(
    context.config.services
  ) as ServiceEntry[];

  const { filteredApps, filteredServices } = filterEntriesByNames(
    parsedArgs.entryNames,
    apps,
    services
  );

  if (
    !validateRequestedEntries(
      parsedArgs.entryNames,
      filteredApps,
      filteredServices
    )
  ) {
    return;
  }

  // Check if no apps or services are configured
  if (apps.length === 0 && services.length === 0) {
    logger.info("No apps or services configured.");
    return;
  }

  // Collect app statuses first (this is what takes time)
  const appStatuses: AppStatus[] = [];
  for (const app of filteredApps) {
    const appStatus = await getAppStatus(app, context);
    appStatuses.push(appStatus);
  }

  // Complete the checking phase before displaying results
  logger.phaseComplete("Checking deployment status");

  // Display any collected verbose messages
  if (context.verboseFlag && context.verboseMessages.length > 0) {
    for (const message of context.verboseMessages) {
      logger.verboseLog(message);
    }
  }

  // Now display the collected results
  displayCollectedAppsStatus(filteredApps, appStatuses);
  displayServicesStatus(filteredServices);
}

/**
 * Displays status for apps using pre-collected status data
 */
function displayCollectedAppsStatus(
  apps: AppEntry[],
  appStatuses: AppStatus[]
): void {
  if (apps.length === 0) {
    logger.info("No apps configured.");
    return;
  }

  console.log(`Apps (${apps.length}):`);
  for (const appStatus of appStatuses) {
    displayAppStatus(appStatus);
  }
}

/**
 * Displays status for services
 */
function displayServicesStatus(services: ServiceEntry[]): void {
  if (services.length === 0) {
    return;
  }

  console.log(`Services (${services.length}):`);
  for (const service of services) {
    displayServiceStatus(service);
  }
}

/**
 * Main status command that orchestrates the entire status checking process
 */
export async function statusCommand(
  args: string[],
  verbose: boolean = false
): Promise<void> {
  try {
    const parsedArgs = parseStatusArgs(args, verbose);

    // Initialize logger with verbose flag
    logger = new Logger({ verbose: parsedArgs.verboseFlag });

    logger.phase("Checking deployment status");

    // Load configuration and secrets
    const { config, secrets } = await loadConfigurationAndSecrets();

    const context: StatusContext = {
      config,
      secrets,
      verboseFlag: parsedArgs.verboseFlag,
      verboseMessages: [], // Initialize verboseMessages
    };

    // Check and display status (this will complete the phase internally)
    await checkAndDisplayStatus(parsedArgs, context);

    console.log("[✓] Status check complete!");
  } catch (error) {
    logger.error("Failed to get status", error);
    process.exit(1);
  } finally {
    logger.cleanup();
  }
}
