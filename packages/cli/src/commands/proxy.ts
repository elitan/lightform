import { loadConfig, loadSecrets } from "../config";
import { LightformConfig, LightformSecrets } from "../config/types";
import { SSHClient, getSSHCredentials } from "../ssh";
import { DockerClient } from "../docker";
import { setupLightformProxy, LIGHTFORM_PROXY_NAME } from "../setup-proxy/index";
import { LightformProxyClient } from "../proxy";
import { Logger } from "../utils/logger";
import {
  checkProxyStatus,
  formatProxyStatus,
  ProxyStatus,
} from "../utils/proxy-checker";

// Module-level logger that gets configured when proxy commands run
let logger: Logger;

interface ProxyContext {
  config: LightformConfig;
  secrets: LightformSecrets;
  verboseFlag: boolean;
}

interface ParsedProxyArgs {
  subcommand: string;
  verboseFlag: boolean;
  host?: string;
  lines?: number;
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
 * Parses command line arguments for proxy command
 */
function parseProxyArgs(args: string[]): ParsedProxyArgs {
  const verboseFlag = args.includes("--verbose");
  
  let host: string | undefined;
  let lines: number | undefined;
  
  const cleanArgs: string[] = [];
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--verbose") {
      continue;
    } else if (args[i] === "--host" && i + 1 < args.length) {
      host = args[i + 1];
      i++; // Skip the next argument since it's the host value
    } else if (args[i] === "--lines" && i + 1 < args.length) {
      lines = parseInt(args[i + 1], 10);
      i++; // Skip the next argument since it's the lines value
    } else {
      cleanArgs.push(args[i]);
    }
  }

  const subcommand = cleanArgs[0] || "";

  return {
    subcommand,
    verboseFlag,
    host,
    lines,
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
    logger.error("Failed to load configuration/secrets", error);
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
 * Establishes SSH connection to a server
 */
async function establishSSHConnection(
  serverHostname: string,
  context: ProxyContext
): Promise<SSHClient> {
  const sshCredentials = await getSSHCredentials(
    serverHostname,
    context.config,
    context.secrets,
    context.verboseFlag
  );

  if (!sshCredentials.username) {
    throw new Error("Could not determine SSH username");
  }

  logger.verboseLog(`Connecting to ${serverHostname}...`);

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

  const sshClient = await SSHClient.create(sshClientOptions);
  await sshClient.connect();

  return sshClient;
}

/**
 * Gets current proxy image digest from the server
 */
async function getCurrentProxyImageDigest(
  sshClient: SSHClient,
  serverHostname: string
): Promise<string | null> {
  try {
    // Get the image digest of the running proxy container
    const inspectCmd = `docker inspect ${LIGHTFORM_PROXY_NAME} --format='{{.Image}}'`;
    const currentImageId = await sshClient.exec(inspectCmd);

    // Get the full digest
    const digestCmd = `docker images --digests --no-trunc | grep ${currentImageId.trim()} | awk '{print $3}'`;
    const digest = await sshClient.exec(digestCmd);

    return digest.trim() || null;
  } catch (error) {
    logger.verboseLog(
      `Could not get current proxy image digest on ${serverHostname}: ${error}`
    );
    return null;
  }
}

/**
 * Gets latest proxy image digest from registry
 */
async function getLatestProxyImageDigest(
  sshClient: SSHClient,
  proxyImage: string
): Promise<string | null> {
  try {
    // Pull the latest image to get its digest
    const pullCmd = `docker pull ${proxyImage}`;
    await sshClient.exec(pullCmd);

    // Get the digest of the latest pulled image
    const inspectCmd = `docker inspect ${proxyImage} --format='{{index .RepoDigests 0}}'`;
    const digest = await sshClient.exec(inspectCmd);

    return digest.trim() || null;
  } catch (error) {
    logger.verboseLog(`Could not get latest proxy image digest: ${error}`);
    return null;
  }
}

/**
 * Checks if proxy needs update by comparing image digests
 */
async function checkProxyNeedsUpdate(
  sshClient: SSHClient,
  serverHostname: string,
  proxyImage: string
): Promise<{
  needsUpdate: boolean;
  currentDigest?: string;
  latestDigest?: string;
}> {
  logger.verboseLog(`Checking if proxy needs update on ${serverHostname}...`);

  const currentDigest = await getCurrentProxyImageDigest(
    sshClient,
    serverHostname
  );
  const latestDigest = await getLatestProxyImageDigest(sshClient, proxyImage);

  if (!currentDigest || !latestDigest) {
    logger.verboseLog(
      "Could not determine image digests, assuming update needed"
    );
    return {
      needsUpdate: true,
      currentDigest: currentDigest || undefined,
      latestDigest: latestDigest || undefined,
    };
  }

  const needsUpdate = currentDigest !== latestDigest;
  logger.verboseLog(`Current digest: ${currentDigest}`);
  logger.verboseLog(`Latest digest: ${latestDigest}`);
  logger.verboseLog(`Update needed: ${needsUpdate}`);

  return { needsUpdate, currentDigest, latestDigest };
}

/**
 * Status subcommand - shows proxy status on all servers
 */
async function proxyStatusSubcommand(context: ProxyContext): Promise<void> {
  logger.phase("Checking proxy status");

  const targetServers = collectAllServers(context.config);

  if (targetServers.size === 0) {
    logger.info("No servers found in configuration.");
    return;
  }

  const proxyStatuses: ProxyStatus[] = [];

  for (const serverHostname of targetServers) {
    let sshClient: SSHClient | undefined;

    try {
      logger.verboseLog(`Checking proxy on ${serverHostname}...`);
      sshClient = await establishSSHConnection(serverHostname, context);

      const proxyStatus = await checkProxyStatus(
        serverHostname,
        sshClient,
        context.verboseFlag
      );

      proxyStatuses.push(proxyStatus);

      // If proxy is running, check if it needs update
      if (proxyStatus.running) {
        const proxyImage =
          context.config.proxy?.image || "elitan/lightform-proxy:latest";
        const updateCheck = await checkProxyNeedsUpdate(
          sshClient,
          serverHostname,
          proxyImage
        );

        if (updateCheck.needsUpdate) {
          logger.info(`Proxy on ${serverHostname} can be updated`);
        } else {
          logger.verboseLog(`Proxy on ${serverHostname} is up to date`);
        }
      }
    } catch (error) {
      logger.verboseLog(`Failed to check proxy on ${serverHostname}: ${error}`);
      proxyStatuses.push({
        running: false,
        containerName: LIGHTFORM_PROXY_NAME,
        serverId: serverHostname,
        ports: [],
        error: `Failed to connect: ${error}`,
      });
    } finally {
      if (sshClient) {
        await sshClient.close();
      }
    }
  }

  // Display status for all servers
  logger.phaseComplete("Proxy status check complete");

  console.log(`\nProxy Statuses (${proxyStatuses.length}):`);

  for (const status of proxyStatuses) {
    const formattedLines = formatProxyStatus(status);
    for (const line of formattedLines) {
      console.log(line);
    }
    console.log(); // Add spacing between proxy statuses
  }
}

/**
 * Update subcommand - updates proxy on all servers
 */
async function proxyUpdateSubcommand(
  context: ProxyContext
): Promise<void> {
  logger.phase("Updating proxy");

  const targetServers = collectAllServers(context.config);

  if (targetServers.size === 0) {
    logger.info("No servers found in configuration.");
    return;
  }

  let updatedCount = 0;
  let skippedCount = 0;

  for (const serverHostname of targetServers) {
    let sshClient: SSHClient | undefined;

    try {
      logger.server(serverHostname);
      sshClient = await establishSSHConnection(serverHostname, context);

      const proxyImage =
        context.config.proxy?.image || "elitan/lightform-proxy:latest";

      // Check if update is needed
      const updateCheck = await checkProxyNeedsUpdate(
        sshClient,
        serverHostname,
        proxyImage
      );

      if (!updateCheck.needsUpdate) {
        logger.verboseLog(`Proxy is already up to date on ${serverHostname}`);
        skippedCount++;
        continue;
      }

      logger.serverStep("Updating Lightform Proxy");

      const updateResult = await setupLightformProxy(
        serverHostname,
        sshClient,
        context.verboseFlag,
        true // Force update for proxy command
      );

      if (updateResult) {
        logger.serverStepComplete("Proxy updated successfully");
        updatedCount++;
      } else {
        logger.serverStepError("Failed to update proxy", undefined);
      }
    } catch (error) {
      logger.serverStepError(`Failed to update proxy`, error);
    } finally {
      if (sshClient) {
        await sshClient.close();
      }
    }
  }

  logger.phaseComplete("Proxy update complete");
  console.log(`\nUpdate Summary:`);
  console.log(`   Updated: ${updatedCount} server(s)`);
  console.log(`   Skipped: ${skippedCount} server(s) (already up to date)`);

  if (updatedCount > 0) {
    console.log(`\nProxy successfully updated on ${updatedCount} server(s)!`);
  }
}

/**
 * Delete-host subcommand - removes a host from proxy configuration
 */
async function proxyDeleteHostSubcommand(
  context: ProxyContext,
  host: string
): Promise<void> {
  if (!host) {
    logger.error("Host is required for delete-host command. Use --host <hostname>");
    return;
  }

  logger.phase(`Deleting host: ${host}`);

  const targetServers = collectAllServers(context.config);

  if (targetServers.size === 0) {
    logger.info("No servers found in configuration.");
    return;
  }

  let deletedCount = 0;
  let notFoundCount = 0;

  for (const serverHostname of targetServers) {
    let sshClient: SSHClient | undefined;

    try {
      logger.server(serverHostname);
      sshClient = await establishSSHConnection(serverHostname, context);

      // Check if proxy is running
      const proxyStatus = await checkProxyStatus(
        serverHostname,
        sshClient,
        context.verboseFlag
      );

      if (!proxyStatus.running) {
        logger.verboseLog(`Proxy not running on ${serverHostname}, skipping`);
        continue;
      }

      logger.serverStep(`Deleting host: ${host}`);

      // Use the proxy CLI to delete the host
      const deleteCmd = `docker exec ${LIGHTFORM_PROXY_NAME} /usr/local/bin/lightform-proxy delete-host ${host}`;
      const result = await sshClient.exec(deleteCmd);

      if (result.includes("Host deleted successfully") || result.includes("deleted")) {
        logger.serverStepComplete(`Host ${host} deleted successfully`);
        deletedCount++;
      } else if (result.includes("not found") || result.includes("does not exist")) {
        logger.verboseLog(`Host ${host} not found on ${serverHostname}`);
        notFoundCount++;
      } else {
        logger.serverStepError(`Unexpected response: ${result}`, undefined);
      }
    } catch (error) {
      logger.serverStepError(`Failed to delete host ${host}`, error);
    } finally {
      if (sshClient) {
        await sshClient.close();
      }
    }
  }

  logger.phaseComplete("Host deletion complete");
  console.log(`\nDeletion Summary:`);
  console.log(`   Deleted: ${deletedCount} server(s)`);
  console.log(`   Not found: ${notFoundCount} server(s)`);

  if (deletedCount > 0) {
    console.log(`\nHost ${host} successfully deleted from ${deletedCount} server(s)!`);
  }
}

/**
 * Logs subcommand - shows proxy logs from all servers
 */
async function proxyLogsSubcommand(
  context: ProxyContext,
  lines: number = 50
): Promise<void> {
  logger.phase(`Showing proxy logs (${lines} lines)`);

  const targetServers = collectAllServers(context.config);

  if (targetServers.size === 0) {
    logger.info("No servers found in configuration.");
    return;
  }

  for (const serverHostname of targetServers) {
    let sshClient: SSHClient | undefined;

    try {
      logger.server(serverHostname);
      sshClient = await establishSSHConnection(serverHostname, context);

      // Check if proxy is running
      const proxyStatus = await checkProxyStatus(
        serverHostname,
        sshClient,
        context.verboseFlag
      );

      if (!proxyStatus.running) {
        logger.info(`Proxy not running on ${serverHostname}`);
        continue;
      }

      logger.serverStep(`Fetching logs (${lines} lines)`);

      // Get proxy logs
      const logsCmd = `docker logs --tail ${lines} ${LIGHTFORM_PROXY_NAME}`;
      const logs = await sshClient.exec(logsCmd);

      console.log(`\n=== Proxy Logs from ${serverHostname} ===`);
      if (logs.trim()) {
        console.log(logs);
      } else {
        console.log("No logs available");
      }
      console.log(`=== End logs from ${serverHostname} ===\n`);

      logger.serverStepComplete("Logs fetched successfully");
    } catch (error) {
      logger.serverStepError(`Failed to fetch logs`, error);
    } finally {
      if (sshClient) {
        await sshClient.close();
      }
    }
  }

  logger.phaseComplete("Log retrieval complete");
}

/**
 * Shows help for proxy command
 */
function showProxyHelp(): void {
  console.log("Lightform Proxy Management");
  console.log("====================");
  console.log("");
  console.log("USAGE:");
  console.log("  lightform proxy <subcommand> [flags]");
  console.log("");
  console.log("SUBCOMMANDS:");
  console.log("  status          Show proxy status on all servers (default)");
  console.log("  update          Update proxy to latest version on all servers");
  console.log("  delete-host     Remove a host from proxy configuration");
  console.log("  logs            Show proxy logs from all servers");
  console.log("");
  console.log("FLAGS:");
  console.log("  --verbose       Show detailed output");
  console.log("  --host <host>   Target specific host (for delete-host)");
  console.log("  --lines <n>     Number of log lines to show (for logs, default: 50)");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  lightform proxy status                      # Check status on all servers");
  console.log("  lightform proxy update --verbose            # Update proxy on all servers with details");
  console.log("  lightform proxy delete-host --host api.example.com  # Remove a specific host");
  console.log("  lightform proxy logs --lines 100            # Show last 100 log lines from all servers");
}

/**
 * Main proxy command that handles subcommands
 */
export async function proxyCommand(args: string[]): Promise<void> {
  try {
    const parsedArgs = parseProxyArgs(args);

    // Show help for help subcommand, empty args, or unknown commands
    if (
      parsedArgs.subcommand === "help" ||
      parsedArgs.subcommand === "" ||
      ![
        "status",
        "update",
        "delete-host",
        "logs"
      ].includes(parsedArgs.subcommand)
    ) {
      showProxyHelp();
      return;
    }

    // Initialize logger with verbose flag
    logger = new Logger({ verbose: parsedArgs.verboseFlag });

    // Load configuration and secrets
    const { config, secrets } = await loadConfigurationAndSecrets();

    const context: ProxyContext = {
      config,
      secrets,
      verboseFlag: parsedArgs.verboseFlag,
    };

    // Handle subcommands
    switch (parsedArgs.subcommand) {
      case "status":
        await proxyStatusSubcommand(context);
        break;
      case "update":
        await proxyUpdateSubcommand(context);
        break;
      case "delete-host":
        if (!parsedArgs.host) {
          logger.error("Host is required for delete-host command. Use --host <hostname>");
          return;
        }
        await proxyDeleteHostSubcommand(context, parsedArgs.host);
        break;
      case "logs":
        await proxyLogsSubcommand(context, parsedArgs.lines || 50);
        break;
    }
  } catch (error) {
    logger.error("Proxy command failed", error);
    process.exit(1);
  } finally {
    if (logger) {
      logger.cleanup();
    }
  }
}
