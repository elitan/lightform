import { SSHClient } from "../ssh";
import { DockerClient } from "../docker";
import { LumaProxyClient } from "../proxy";

export interface ProxyStatus {
  running: boolean;
  containerName: string;
  serverId: string;
  ports: string[];
  certificateQueue?: CertificateQueueEntry[];
  configurations?: string[];
  error?: string;
}

export interface CertificateQueueEntry {
  hostname: string;
  email: string;
  addedAt: string;
  lastAttempt?: string;
  attempts: number;
  status: "pending" | "retrying" | "failed";
}

/**
 * Gets port mappings for the proxy container
 */
async function getProxyPorts(
  sshClient: SSHClient,
  containerName: string,
  verbose: boolean = false
): Promise<string[]> {
  try {
    const inspectOutput = await sshClient.exec(
      `docker inspect ${containerName} --format='{{range $p, $conf := .NetworkSettings.Ports}}{{if $conf}}{{$p}} -> {{(index $conf 0).HostPort}}{{println}}{{end}}{{end}}'`
    );
    return inspectOutput
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.trim());
  } catch (error) {
    if (verbose) {
      console.warn(
        `Failed to get port mappings for ${containerName}: ${error}`
      );
    }
    return [];
  }
}

/**
 * Gets certificate queue status from the proxy
 */
async function getCertificateQueueStatus(
  sshClient: SSHClient,
  verbose: boolean = false
): Promise<CertificateQueueEntry[]> {
  try {
    // Execute the luma-proxy status command inside the container
    const statusOutput = await sshClient.exec(
      `docker exec luma-proxy luma-proxy status 2>/dev/null || echo "PROXY_NOT_AVAILABLE"`
    );

    if (statusOutput.includes("PROXY_NOT_AVAILABLE") || !statusOutput.trim()) {
      return [];
    }

    // Parse the status output to extract certificate queue information
    const entries: CertificateQueueEntry[] = [];
    const lines = statusOutput.split("\n");

    let currentEntry: Partial<CertificateQueueEntry> | null = null;

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Look for hostname entries (lines that start with status emojis)
      if (trimmedLine.match(/^[⏳🔄] (Pending|Retrying)/)) {
        if (currentEntry && currentEntry.hostname) {
          entries.push(currentEntry as CertificateQueueEntry);
        }

        const hostname = trimmedLine.split(" ").pop(); // Get the last word (hostname)
        const status = trimmedLine.includes("Pending") ? "pending" : "retrying";

        currentEntry = {
          hostname: hostname || "",
          status,
          attempts: 0,
          email: "",
          addedAt: "",
        };
      } else if (currentEntry && trimmedLine.startsWith("Email:")) {
        currentEntry.email = trimmedLine.replace("Email:", "").trim();
      } else if (currentEntry && trimmedLine.startsWith("Added:")) {
        currentEntry.addedAt = trimmedLine.replace("Added:", "").trim();
      } else if (currentEntry && trimmedLine.startsWith("Last attempt:")) {
        currentEntry.lastAttempt = trimmedLine
          .replace("Last attempt:", "")
          .trim();
      } else if (currentEntry && trimmedLine.includes("attempt")) {
        // Extract attempt number from status line
        const attemptMatch = trimmedLine.match(/attempt (\d+)/);
        if (attemptMatch) {
          currentEntry.attempts = parseInt(attemptMatch[1]);
        }
      }
    }

    // Add the last entry if exists
    if (currentEntry && currentEntry.hostname) {
      entries.push(currentEntry as CertificateQueueEntry);
    }

    return entries;
  } catch (error) {
    if (verbose) {
      console.warn(`Failed to get certificate queue status: ${error}`);
    }
    return [];
  }
}

/**
 * Checks the overall proxy status for a server
 */
export async function checkProxyStatus(
  serverHostname: string,
  sshClient: SSHClient,
  verbose: boolean = false
): Promise<ProxyStatus> {
  try {
    const dockerClient = new DockerClient(sshClient, serverHostname, verbose);
    const proxyClient = new LumaProxyClient(
      dockerClient,
      serverHostname,
      verbose
    );
    const containerName = "luma-proxy";

    // Use the existing LumaProxyClient to check if proxy is running
    const isRunning = await proxyClient.isProxyRunning();

    // Get port mappings
    const ports = isRunning
      ? await getProxyPorts(sshClient, containerName, verbose)
      : [];

    // Get certificate queue status
    const certificateQueue = isRunning
      ? await getCertificateQueueStatus(sshClient, verbose)
      : [];

    // Get proxy configurations
    let configurations: string[] = [];
    if (isRunning) {
      const configsOutput = await proxyClient.listProxyConfigs();
      if (configsOutput) {
        // Parse the configurations output - this would depend on the actual format
        configurations = configsOutput
          .split("\n")
          .filter((line) => line.trim());
      }
    }

    return {
      running: isRunning,
      containerName,
      serverId: serverHostname,
      ports,
      certificateQueue,
      configurations,
    };
  } catch (error) {
    return {
      running: false,
      containerName: "luma-proxy",
      serverId: serverHostname,
      ports: [],
      error: `Failed to check proxy status: ${error}`,
    };
  }
}

/**
 * Formats proxy status for display
 */
export function formatProxyStatus(proxyStatus: ProxyStatus): string[] {
  const lines: string[] = [];

  const statusIcon = proxyStatus.running ? "[✓]" : "[✗]";
  const statusText = proxyStatus.running ? "RUNNING" : "STOPPED";

  lines.push(`  └─ Proxy: ${proxyStatus.containerName}`);
  lines.push(`     ├─ Status: ${statusIcon} ${statusText}`);
  lines.push(`     ├─ Server: ${proxyStatus.serverId}`);

  if (proxyStatus.running && proxyStatus.ports.length > 0) {
    lines.push(`     ├─ Ports: ${proxyStatus.ports.join(", ")}`);
  }

  if (proxyStatus.configurations && proxyStatus.configurations.length > 0) {
    lines.push(
      `     ├─ Configurations: ${proxyStatus.configurations.length} active`
    );
  }

  if (proxyStatus.certificateQueue && proxyStatus.certificateQueue.length > 0) {
    lines.push(
      `     ├─ Certificate Queue: ${proxyStatus.certificateQueue.length} pending`
    );

    for (const entry of proxyStatus.certificateQueue) {
      const entryStatusIcon = entry.status === "pending" ? "⏳" : "🔄";
      const attemptText =
        entry.attempts > 0 ? ` (attempt ${entry.attempts})` : "";
      lines.push(
        `     │  ├─ ${entryStatusIcon} ${entry.hostname}${attemptText}`
      );
    }
  } else if (proxyStatus.running) {
    lines.push(`     ├─ Certificate Queue: Empty`);
  }

  if (proxyStatus.error) {
    lines.push(`     ├─ Error: ${proxyStatus.error}`);
  }

  return lines;
}
