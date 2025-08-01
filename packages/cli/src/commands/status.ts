import { loadConfig, loadSecrets } from "../config";
import {
  IopConfig,
  ServiceEntry,
  IopSecrets,
} from "../config/types";
import { DockerClient } from "../docker";
import { SSHClient, getSSHCredentials, SSHClientOptions } from "../ssh";
import { Logger } from "../utils/logger";
import {
  checkProxyStatus,
  formatProxyStatus,
  ProxyStatus,
} from "../utils/proxy-checker";

// Module-level logger that gets configured when statusCommand runs
let logger: Logger;

interface StatusContext {
  config: IopConfig;
  secrets: IopSecrets;
  verboseFlag: boolean;
  verboseMessages: string[]; // Store verbose messages for later display
  projectName: string;
}

interface ParsedStatusArgs {
  entryNames: string[];
  verboseFlag: boolean;
}

interface EntryStatus {
  name: string;
  type: "app" | "service";
  status: "running" | "stopped" | "mixed" | "unknown";
  activeColor?: "blue" | "green" | null;
  image?: string;
  replicas: {
    total: number;
    running: number;
    blue?: number;
    green?: number;
  };
  lastDeployed?: string;
  servers: string[];
  // Basic info (always included)
  uptime?: string;
  resourceUsage?: {
    cpu: string;
    memory: string;
  };
  // Additional info (always included)
  additionalInfo?: {
    exactImage: string;
    restartCount: number;
    exitCode?: number;
    ports: string[];
    volumes: Array<{
      source: string;
      destination: string;
      mode?: string;
    }>;
  };
}

interface ServerEntryStatus {
  activeColor?: "blue" | "green" | null;
  blueContainers?: string[];
  greenContainers?: string[];
  runningContainers: string[];
  totalContainers: string[];
  // Container details for running containers
  containerDetails?: Record<
    string,
    {
      uptime: string | null;
      stats: {
        cpuPercent: string;
        memoryUsage: string;
        memoryPercent: string;
      } | null;
      image: string | null;
      createdAt: string | null;
      restartCount: number;
      exitCode: number | null;
      ports: string[];
      volumes: Array<{
        source: string;
        destination: string;
        mode?: string;
      }>;
    }
  >;
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

interface ServiceStatus {
  name: string;
  status: "running" | "stopped" | "mixed" | "unknown";
  image: string;
  replicas: {
    total: number;
    running: number;
  };
  servers: string[];
}

interface ServerAppStatus {
  activeColor: "blue" | "green" | null;
  blueContainers: string[];
  greenContainers: string[];
  runningContainers: string[];
}

interface ServerServiceStatus {
  runningContainers: string[];
  totalContainers: string[];
}

interface ProxyStatusSummary {
  proxyStatuses: ProxyStatus[];
}

/**
 * Parses command line arguments for status command
 */
function parseStatusArgs(
  args: string[],
  verbose: boolean = false
): ParsedStatusArgs {
  const entryNames: string[] = [];

  // Parse arguments, filtering out flags
  for (const arg of args || []) {
    if (!arg.startsWith("-")) {
      entryNames.push(arg);
    }
  }

  return {
    entryNames,
    verboseFlag: verbose,
  };
}

/**
 * Loads and validates iop configuration and secrets files
 */
async function loadConfigurationAndSecrets(): Promise<{
  config: IopConfig;
  secrets: IopSecrets;
}> {
  try {
    const config = await loadConfig();
    const secrets = await loadSecrets();
    return { config, secrets };
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) {
      logger.error("Configuration files not found.");
      logger.error("");
      logger.error("To fix this:");
      logger.error("   iop init                         # Create configuration files");
      logger.error("   # Edit iop.yml with your settings");
      logger.error("   iop status                       # Check status again");
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
 * Gets container information for any entry (app or service) on a specific server
 */
async function getEntryContainersOnServer(
  entry: ServiceEntry,
  entryType: "app" | "service",
  dockerClient: DockerClient,
  projectName: string
): Promise<ServerEntryStatus> {
  const labelKey = entryType === "app" ? "iop.app" : "iop.service";
  const allContainers = await dockerClient.findContainersByLabelAndProject(
    `${labelKey}=${entry.name}`,
    projectName
  );

  const blueContainers: string[] = [];
  const greenContainers: string[] = [];
  const runningContainers: string[] = [];
  const containerDetails: Record<string, any> = {};

  for (const containerName of allContainers) {
    const isRunning = await dockerClient.containerIsRunning(containerName);
    if (isRunning) {
      runningContainers.push(containerName);

      // Always get full container details
      const details = await dockerClient.getContainerDetails(containerName);
      if (details) {
        containerDetails[containerName] = details;
      }
    }

    // Only check for color labels for apps (services don't use blue/green deployment)
    if (entryType === "app") {
      const labels = await dockerClient.getContainerLabels(containerName);
      const color = labels["iop.color"];

      if (color === "blue") {
        blueContainers.push(containerName);
      } else if (color === "green") {
        greenContainers.push(containerName);
      }
    }
  }

  return {
    activeColor: entryType === "app" ? undefined : undefined, // Will be set later for apps
    blueContainers: entryType === "app" ? blueContainers : undefined,
    greenContainers: entryType === "app" ? greenContainers : undefined,
    runningContainers,
    totalContainers: allContainers,
    containerDetails: containerDetails, // Always include container details
  };
}

/**
 * Gets proxy status across all servers
 */
async function getProxyStatusSummary(
  context: StatusContext
): Promise<ProxyStatusSummary> {
  const proxyStatuses: ProxyStatus[] = [];

  // Get unique servers from all services
  const allServers = new Set<string>();

  const services = normalizeConfigEntries(
    context.config.services
  ) as ServiceEntry[];

  services.forEach((service) => allServers.add(service.server));

  if (allServers.size === 0) {
    return { proxyStatuses: [] };
  }

  for (const serverHostname of allServers) {
    let sshClient: SSHClient | undefined;

    try {
      sshClient = await establishSSHConnection(serverHostname, context);

      if (context.verboseFlag) {
        context.verboseMessages.push(
          `Checking proxy status on ${serverHostname}...`
        );
      }

      const proxyStatus = await checkProxyStatus(
        serverHostname,
        sshClient,
        context.verboseFlag
      );

      proxyStatuses.push(proxyStatus);
    } catch (error) {
      if (context.verboseFlag) {
        context.verboseMessages.push(
          `Failed to check proxy status on ${serverHostname}: ${error}`
        );
      }

      // Add error status for this server
      proxyStatuses.push({
        running: false,
        containerName: "iop-proxy",
        serverId: serverHostname,
        ports: [],
        error: `Failed to connect to server: ${error}`,
      });
    } finally {
      if (sshClient) {
        await sshClient.close();
      }
    }
  }

  return { proxyStatuses };
}

/**
 * Gets status information for any entry (app or service) on a specific server
 */
async function getEntryStatusOnServer(
  entry: ServiceEntry,
  entryType: "app" | "service",
  serverHostname: string,
  context: StatusContext
): Promise<ServerEntryStatus> {
  let sshClient: SSHClient | undefined;

  try {
    sshClient = await establishSSHConnection(serverHostname, context);
    const dockerClient = new DockerClient(
      sshClient,
      serverHostname,
      context.verboseFlag
    );

    // Get container information
    const containerInfo = await getEntryContainersOnServer(
      entry,
      entryType,
      dockerClient,
      context.projectName
    );

    // Get active color for apps only
    if (entryType === "app") {
      const activeColor = await dockerClient.getCurrentActiveColorForProject(
        entry.name,
        context.projectName
      );
      containerInfo.activeColor = activeColor;
    }

    return containerInfo;
  } catch (error) {
    // Store verbose message instead of logging immediately
    if (context.verboseFlag) {
      context.verboseMessages.push(
        `Failed to get status for ${entryType} ${entry.name} on ${serverHostname}: ${error}`
      );
    }
    return {
      activeColor: entryType === "app" ? null : undefined,
      blueContainers: entryType === "app" ? [] : undefined,
      greenContainers: entryType === "app" ? [] : undefined,
      runningContainers: [],
      totalContainers: [],
      containerDetails: {},
    };
  } finally {
    if (sshClient) {
      await sshClient.close();
    }
  }
}

/**
 * Aggregates server statuses to determine overall entry status
 */
function aggregateEntryStatus(
  entry: ServiceEntry,
  entryType: "app" | "service",
  serverStatuses: ServerEntryStatus[]
): {
  totalRunning: number;
  totalContainers: number;
  totalBlue: number;
  totalGreen: number;
  activeColor: "blue" | "green" | null;
  status: "running" | "stopped" | "mixed" | "unknown";
  uptime: string | null;
  resourceUsage: { cpu: string; memory: string } | null;
  additionalInfo: {
    exactImage: string;
    restartCount: number;
    exitCode?: number;
    ports: string[];
    volumes: Array<{
      source: string;
      destination: string;
      mode?: string;
    }>;
  } | null;
} {
  let totalRunning = 0;
  let totalContainers = 0;
  let totalBlue = 0;
  let totalGreen = 0;
  let activeColors: ("blue" | "green" | null)[] = [];
  let uptime: string | null = null;
  let resourceUsage: { cpu: string; memory: string } | null = null;
  let additionalInfo: any = null;

  for (const serverStatus of serverStatuses) {
    totalRunning += serverStatus.runningContainers.length;
    totalContainers += serverStatus.totalContainers.length;

    if (
      entryType === "app" &&
      serverStatus.blueContainers &&
      serverStatus.greenContainers
    ) {
      totalBlue += serverStatus.blueContainers.length;
      totalGreen += serverStatus.greenContainers.length;
      if (serverStatus.activeColor !== undefined) {
        activeColors.push(serverStatus.activeColor);
      }
    }

    // Extract uptime and resource usage from first running container
    if (
      !uptime &&
      serverStatus.containerDetails &&
      serverStatus.runningContainers.length > 0
    ) {
      const firstRunningContainer = serverStatus.runningContainers[0];
      const containerDetail =
        serverStatus.containerDetails[firstRunningContainer];

      if (containerDetail) {
        uptime = containerDetail.uptime;
        if (containerDetail.stats) {
          resourceUsage = {
            cpu: containerDetail.stats.cpuPercent,
            memory: containerDetail.stats.memoryUsage,
          };
        }

        // Extract additional info
        additionalInfo = {
          exactImage: containerDetail.image || "",
          restartCount: containerDetail.restartCount,
          exitCode: containerDetail.exitCode,
          ports: containerDetail.ports,
          volumes: containerDetail.volumes,
        };
      }
    }
  }

  // Determine overall active color (should be consistent across servers)
  const uniqueActiveColors = [
    ...new Set(activeColors.filter((c) => c !== null)),
  ];
  const activeColor =
    entryType === "app" && uniqueActiveColors.length === 1
      ? uniqueActiveColors[0]
      : null;

  // Determine overall status
  // Services don't have replicas property, so default to 1
  const expectedReplicas = (entry as any).replicas || 1;
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
    totalContainers,
    totalBlue,
    totalGreen,
    activeColor,
    status,
    uptime,
    resourceUsage,
    additionalInfo,
  };
}

/**
 * Gets comprehensive status for any entry (app or service) across all its servers
 */
async function getEntryStatus(
  entry: ServiceEntry,
  entryType: "app" | "service",
  context: StatusContext
): Promise<EntryStatus> {
  const serverStatuses = await Promise.all(
    [entry.server].map((server) =>
      getEntryStatusOnServer(entry, entryType, server, context)
    )
  );

  const aggregated = aggregateEntryStatus(entry, entryType, serverStatuses);

  const baseStatus: EntryStatus = {
    name: entry.name,
    type: entryType,
    status: aggregated.status,
    replicas: {
      total:
        entryType === "app"
          ? aggregated.totalBlue + aggregated.totalGreen
          : aggregated.totalContainers,
      running: aggregated.totalRunning,
    },
    servers: [entry.server],
    uptime: aggregated.uptime || undefined,
    resourceUsage: aggregated.resourceUsage || undefined,
  };

  if (entryType === "app") {
    baseStatus.activeColor = aggregated.activeColor;
    baseStatus.replicas.blue = aggregated.totalBlue;
    baseStatus.replicas.green = aggregated.totalGreen;
  } else {
    baseStatus.image = (entry as ServiceEntry).image;
  }

  // Add additional info
  if (aggregated.additionalInfo) {
    baseStatus.additionalInfo = aggregated.additionalInfo;
  }

  return baseStatus;
}

/**
 * Displays status information for any entry (app or service) in a formatted way
 */
function displayEntryStatus(entryStatus: EntryStatus): void {
  const statusIcon = {
    running: "[✓]",
    stopped: "[✗]",
    mixed: "[!]",
    unknown: "[?]",
  }[entryStatus.status];

  const entryTypeCapitalized =
    entryStatus.type.charAt(0).toUpperCase() + entryStatus.type.slice(1);

  console.log(`  └─ ${entryTypeCapitalized}: ${entryStatus.name}`);

  if (entryStatus.type === "app") {
    const versionDisplay = entryStatus.activeColor
      ? `(${entryStatus.activeColor} active)`
      : "(no active version)";
    console.log(
      `     ├─ Status: ${statusIcon} ${entryStatus.status.toUpperCase()} ${versionDisplay}`
    );
  } else {
    console.log(
      `     ├─ Status: ${statusIcon} ${entryStatus.status.toUpperCase()}`
    );
  }

  if (entryStatus.replicas.total > 0) {
    console.log(
      `     ├─ Replicas: ${entryStatus.replicas.running}/${entryStatus.replicas.total} running`
    );
  }

  // Show uptime and resource usage (always included)
  if (entryStatus.uptime) {
    console.log(`     ├─ Uptime: ${entryStatus.uptime}`);
  }

  if (entryStatus.resourceUsage) {
    console.log(`     ├─ Resources:`);
    console.log(`     │  ├─ CPU: ${entryStatus.resourceUsage.cpu}`);
    console.log(`     │  └─ Memory: ${entryStatus.resourceUsage.memory}`);
  }

  // Show additional info (always included)
  if (entryStatus.additionalInfo) {
    const info = entryStatus.additionalInfo;
    console.log(`     ├─ Image: ${info.exactImage}`);

    if (info.restartCount > 0) {
      console.log(`     ├─ Restarts: ${info.restartCount}`);
    }

    if (
      info.exitCode !== null &&
      info.exitCode !== undefined &&
      info.exitCode !== 0
    ) {
      console.log(`     ├─ Exit Code: ${info.exitCode}`);
    }

    if (info.ports.length > 0) {
      // Remove duplicates and format ports for better readability
      const uniquePorts = [...new Set(info.ports)];
      const formattedPorts = uniquePorts.map((port) => {
        // Handle format like "5433:5432/tcp"
        if (port.includes(":")) {
          const [hostPort, containerPortWithProtocol] = port.split(":");
          const [containerPort, protocol] =
            containerPortWithProtocol.split("/");
          const protocolDisplay = protocol ? `/${protocol}` : "";
          return `${hostPort} → ${containerPort}${protocolDisplay}`;
        }
        return port;
      });

      if (formattedPorts.length === 1) {
        console.log(`     ├─ Port: ${formattedPorts[0]} (host → container)`);
      } else {
        console.log(`     ├─ Ports (${formattedPorts.length}):`);
        for (const port of formattedPorts) {
          console.log(`     │  ├─ ${port} (host → container)`);
        }
      }
    }

    if (info.volumes.length > 0) {
      console.log(`     ├─ Volumes (${info.volumes.length}):`);
      for (const volume of info.volumes) {
        const modeDisplay = volume.mode ? ` (${volume.mode})` : "";
        console.log(
          `     │  ├─ ${volume.source} → ${volume.destination}${modeDisplay}`
        );
      }
    }
  }

  console.log(`     └─ Servers: ${entryStatus.servers.join(", ")}`);
  console.log(); // Add spacing between entries
}

/**
 * Filters apps and services based on requested entry names
 */
function filterEntriesByNames(
  entryNames: string[],
  apps: ServiceEntry[],
  services: ServiceEntry[]
): {
  filteredApps: ServiceEntry[];
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
  filteredApps: ServiceEntry[],
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
  const services = normalizeConfigEntries(
    context.config.services
  ) as ServiceEntry[];

  const { filteredApps, filteredServices } = filterEntriesByNames(
    parsedArgs.entryNames,
    [],
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

  // Check if no services are configured
  if (services.length === 0) {
    logger.info("No services configured.");
    return;
  }

  // Collect service statuses and proxy status in parallel
  const [serviceStatuses, proxyStatusSummary] = await Promise.all([
    Promise.all(
      filteredServices.map((service) =>
        getEntryStatus(service, "service", context)
      )
    ),
    getProxyStatusSummary(context),
  ]);

  // Complete the checking phase before displaying results
  logger.phaseComplete("Checking deployment status");

  // Display any collected verbose messages
  if (context.verboseFlag && context.verboseMessages.length > 0) {
    for (const message of context.verboseMessages) {
      logger.verboseLog(message);
    }
  }

  // Now display the collected results
  displayCollectedEntryStatuses(filteredServices, serviceStatuses, "Services");
  displayProxyStatus(proxyStatusSummary);
}

/**
 * Displays status for entries using pre-collected status data
 */
function displayCollectedEntryStatuses(
  entries: (ServiceEntry)[],
  entryStatuses: EntryStatus[],
  sectionTitle: string
): void {
  if (entries.length === 0) {
    return;
  }

  console.log(`${sectionTitle} (${entries.length}):`);
  for (const entryStatus of entryStatuses) {
    displayEntryStatus(entryStatus);
  }
}

/**
 * Displays proxy status information
 */
function displayProxyStatus(proxyStatusSummary: ProxyStatusSummary): void {
  const proxyStatuses = proxyStatusSummary.proxyStatuses;

  if (proxyStatuses.length === 0) {
    logger.info("No proxy statuses found.");
    return;
  }

  console.log(`Proxy Statuses (${proxyStatuses.length}):`);
  for (const proxyStatus of proxyStatuses) {
    displayProxyStatusInfo(proxyStatus);
  }
}

/**
 * Displays proxy status information for a single proxy status
 */
function displayProxyStatusInfo(proxyStatus: ProxyStatus): void {
  const formattedLines = formatProxyStatus(proxyStatus);
  for (const line of formattedLines) {
    console.log(line);
  }
  console.log(); // Add spacing between proxy statuses
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
      projectName: config.name,
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
