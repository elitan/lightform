import { SSHClient } from "../ssh";
import { DockerClient } from "../docker";
import { LightformProxyClient } from "../proxy";

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
    const statusOutput = await sshClient.exec(
      `docker exec lightform-proxy /usr/local/bin/lightform-proxy status 2>/dev/null || echo "PROXY_NOT_AVAILABLE"`
    );

    if (statusOutput.includes("PROXY_NOT_AVAILABLE") || !statusOutput.trim()) {
      return [];
    }

    // Parse the status output to extract certificate queue information
    const entries: CertificateQueueEntry[] = [];
    const lines = statusOutput.split("\n");

    // Look for the specific output format from lightform-proxy status
    let foundCertSection = false;

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Check for "No domains pending certificate provisioning" message
      if (trimmedLine.includes("No domains pending certificate provisioning")) {
        return [];
      }

      // Look for certificate retry queue section
      if (trimmedLine.includes("Certificate Retry Queue")) {
        foundCertSection = true;
        continue;
      }

      // If we're in the certificate section, parse entries
      if (foundCertSection) {
        // Look for status lines with emojis or specific patterns
        if (
          trimmedLine.match(/^[⏳🔄] (Pending|Retrying)/) ||
          trimmedLine.includes("⏳ Pending") ||
          trimmedLine.includes("🔄 Retrying")
        ) {
          // Extract hostname (last word on the line)
          const parts = trimmedLine.split(" ");
          const hostname = parts[parts.length - 1];
          const status = trimmedLine.includes("Retrying")
            ? "retrying"
            : "pending";

          // Extract attempt count if present
          const attemptMatch = trimmedLine.match(/attempt (\d+)/);
          const attempts = attemptMatch ? parseInt(attemptMatch[1]) : 0;

          entries.push({
            hostname,
            status,
            attempts,
            email: "",
            addedAt: "",
          });
        }
      }
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
    const proxyClient = new LightformProxyClient(
      dockerClient,
      serverHostname,
      verbose
    );
    const containerName = "lightform-proxy";

    // Use the existing LightformProxyClient to check if proxy is running
    const isRunning = await proxyClient.isProxyRunning();

    // Get port mappings
    const ports = isRunning
      ? await getProxyPorts(sshClient, containerName, verbose)
      : [];

    // Get certificate queue status
    const certificateQueue = isRunning
      ? await getCertificateQueueStatus(sshClient, verbose)
      : [];

    // Get recent proxy logs to show domain activity and configuration issues
    let configurations: string[] = [];
    let configurationIssues: string[] = [];

    if (isRunning) {
      try {
        // Get more recent logs to analyze domain activity
        const recentLogs = await sshClient.exec(
          `docker logs ${containerName} --tail 10 2>/dev/null`
        );

        if (recentLogs && recentLogs.trim()) {
          const domains = new Set<string>();
          const logLines = recentLogs.split("\n");

          for (const line of logLines) {
            // Look for domain patterns in logs
            const hostMatch = line.match(/Host: ([^,\s)]+)/);
            if (hostMatch) {
              const domain = hostMatch[1];
              if (domain && !domain.match(/^\d+\.\d+\.\d+\.\d+$/)) {
                // Skip IP addresses
                domains.add(domain);
              }
            }

            // Look for configuration issues
            if (line.includes("not configured in Lightform proxy")) {
              const domainMatch = line.match(/domain "([^"]+)" not configured/);
              if (domainMatch) {
                configurationIssues.push(`${domainMatch[1]} not configured`);
              }
            }

            // Look for TLS handshake errors without domain names (general SSL issues)
            if (
              line.includes("TLS handshake error") &&
              line.includes("missing server name")
            ) {
              configurationIssues.push("SSL handshake errors (missing SNI)");
            }
          }

          configurations = Array.from(domains);
        }
      } catch (error) {
        if (verbose) {
          console.warn(`Failed to get proxy activity: ${error}`);
        }
      }
    }

    return {
      running: isRunning,
      containerName,
      serverId: serverHostname,
      ports,
      certificateQueue,
      configurations,
      error:
        configurationIssues.length > 0
          ? configurationIssues.join("; ")
          : undefined,
    };
  } catch (error) {
    return {
      running: false,
      containerName: "lightform-proxy",
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
      `     ├─ Recent Domain Activity: ${proxyStatus.configurations.length} domain(s) detected`
    );
    // Show the domains that have been seen in recent logs
    for (const domain of proxyStatus.configurations) {
      lines.push(`     │  ├─ ${domain}`);
    }
  } else if (proxyStatus.running) {
    lines.push(`     ├─ Recent Domain Activity: No domain traffic detected`);
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
    lines.push(`     ├─ ⚠️  Configuration Issues: ${proxyStatus.error}`);
  }

  return lines;
}
