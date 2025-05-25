import { loadConfig, loadSecrets } from "../config";
import {
  LumaConfig,
  AppEntry,
  ServiceEntry,
  LumaSecrets,
} from "../config/types";
import { DockerClient } from "../docker";
import { SSHClient, getSSHCredentials } from "../ssh";
import { Logger } from "../utils/logger";

// Module-level logger
let logger: Logger;

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
 * Gets status information for a single app on a specific server
 */
async function getAppStatusOnServer(
  appEntry: AppEntry,
  serverHostname: string,
  config: LumaConfig,
  secrets: LumaSecrets
): Promise<{
  activeColor: "blue" | "green" | null;
  blueContainers: string[];
  greenContainers: string[];
  runningContainers: string[];
}> {
  let sshClient: SSHClient | undefined;

  try {
    const sshCreds = await getSSHCredentials(
      serverHostname,
      config,
      secrets,
      logger.verbose
    );
    if (!sshCreds.host) sshCreds.host = serverHostname;
    sshClient = await SSHClient.create(sshCreds);
    await sshClient.connect();

    const dockerClient = new DockerClient(
      sshClient,
      serverHostname,
      logger.verbose
    );

    // Get active color
    const activeColor = await dockerClient.getCurrentActiveColor(appEntry.name);

    // Get all containers for this app
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
      activeColor,
      blueContainers,
      greenContainers,
      runningContainers,
    };
  } catch (error) {
    logger.verboseLog(
      `Failed to get status for ${appEntry.name} on ${serverHostname}: ${error}`
    );
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
 * Gets comprehensive status for an app across all its servers
 */
async function getAppStatus(
  appEntry: AppEntry,
  config: LumaConfig,
  secrets: LumaSecrets
): Promise<AppStatus> {
  const serverStatuses = await Promise.all(
    appEntry.servers.map((server) =>
      getAppStatusOnServer(appEntry, server, config, secrets)
    )
  );

  // Aggregate status across all servers
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
    name: appEntry.name,
    status,
    activeColor,
    replicas: {
      total: totalBlue + totalGreen,
      running: totalRunning,
      blue: totalBlue,
      green: totalGreen,
    },
    servers: appEntry.servers,
  };
}

/**
 * Displays status information in a formatted way
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
 * Main status command function
 */
export async function statusCommand(
  args: string[],
  verbose: boolean = false
): Promise<void> {
  try {
    // Initialize logger with verbose flag
    logger = new Logger({ verbose });

    logger.phase("Checking deployment status");

    const config = await loadConfig();
    const secrets = await loadSecrets();

    // Get apps to check status for
    const apps = normalizeConfigEntries(config.apps) as AppEntry[];
    const services = normalizeConfigEntries(config.services) as ServiceEntry[];

    if (args.length > 0) {
      // Filter to specific apps/services requested
      const requestedNames = args;
      const filteredApps = apps.filter((app) =>
        requestedNames.includes(app.name)
      );
      const filteredServices = services.filter((service) =>
        requestedNames.includes(service.name)
      );

      if (filteredApps.length === 0 && filteredServices.length === 0) {
        logger.error(
          `No apps or services found with names: ${requestedNames.join(", ")}`
        );
        return;
      }

      // Show status for requested apps
      if (filteredApps.length > 0) {
        console.log(`Apps (${filteredApps.length}):`);
        for (const app of filteredApps) {
          const appStatus = await getAppStatus(app, config, secrets);
          displayAppStatus(appStatus);
        }
      }

      // Show status for requested services
      if (filteredServices.length > 0) {
        console.log(`Services (${filteredServices.length}):`);
        for (const service of filteredServices) {
          displayServiceStatus(service);
        }
      }
    } else {
      // Show status for all apps
      if (apps.length === 0) {
        logger.info("No apps configured.");
      } else {
        console.log(`Apps (${apps.length}):`);
        for (const app of apps) {
          const appStatus = await getAppStatus(app, config, secrets);
          displayAppStatus(appStatus);
        }
      }

      // Show basic service info
      if (services.length > 0) {
        console.log(`Services (${services.length}):`);
        for (const service of services) {
          displayServiceStatus(service);
        }
      }

      if (apps.length === 0 && services.length === 0) {
        logger.info("No apps or services configured.");
        return;
      }
    }

    logger.phaseComplete("Checking deployment status");
    console.log("[✓] Status check complete!");
  } catch (error) {
    logger.error("Failed to get status", error);
    process.exit(1);
  } finally {
    logger.cleanup();
  }
}
