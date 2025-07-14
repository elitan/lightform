import { SSHClient } from "../ssh";
import { DockerClient } from "../docker";

export interface PortUsage {
  port: number;
  protocol: "tcp" | "udp";
  process?: string;
  pid?: number;
  containerName?: string;
  containerImage?: string;
  isDockerContainer: boolean;
}

export interface PortConflict {
  port: number;
  hostPort: number;
  containerPort: number;
  requestedBy: string; // service/app name
  conflictsWith: PortUsage;
  serverHostname: string;
}

export class PortChecker {
  private sshClient: SSHClient;
  private dockerClient: DockerClient;
  private serverHostname: string;
  private verbose: boolean;

  constructor(
    sshClient: SSHClient,
    dockerClient: DockerClient,
    serverHostname: string,
    verbose: boolean = false
  ) {
    this.sshClient = sshClient;
    this.dockerClient = dockerClient;
    this.serverHostname = serverHostname;
    this.verbose = verbose;
  }

  /**
   * Check what ports are currently in use on the server
   */
  async getPortUsage(): Promise<PortUsage[]> {
    const portUsage: PortUsage[] = [];

    try {
      // Get Docker container port mappings
      const dockerPorts = await this.getDockerPortUsage();
      portUsage.push(...dockerPorts);

      // Get system process port usage (excluding ports already used by Docker)
      const dockerPortNumbers = new Set(dockerPorts.map(dp => dp.port));
      const systemPorts = await this.getSystemPortUsage(dockerPortNumbers);
      portUsage.push(...systemPorts);

      return portUsage;
    } catch (error) {
      if (this.verbose) {
        console.warn(
          `[${this.serverHostname}] Failed to get port usage: ${error}`
        );
      }
      return [];
    }
  }

  /**
   * Get port usage from Docker containers
   */
  private async getDockerPortUsage(): Promise<PortUsage[]> {
    const portUsage: PortUsage[] = [];

    try {
      // Get all running containers with port mappings
      const containerOutput = await this.sshClient.exec(
        `docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}" --no-trunc`
      );

      const lines = containerOutput.split("\n").slice(1); // Skip header

      for (const line of lines) {
        if (!line.trim()) continue;

        const parts = line.split("\t");
        if (parts.length < 3) continue;

        const [containerName, image, ports] = parts;

        // Parse port mappings (e.g., "0.0.0.0:5432->5432/tcp, 0.0.0.0:8080->8080/tcp")
        if (ports && ports !== "") {
          const portMappings = ports.split(",");

          for (const mapping of portMappings) {
            const match = mapping
              .trim()
              .match(/(?:0\.0\.0\.0:)?(\d+)->(\d+)\/(tcp|udp)/);
            if (match) {
              const [, hostPort, containerPort, protocol] = match;

              portUsage.push({
                port: parseInt(hostPort),
                protocol: protocol as "tcp" | "udp",
                containerName: containerName.trim(),
                containerImage: image.trim(),
                isDockerContainer: true,
              });
            }
          }
        }
      }
    } catch (error) {
      if (this.verbose) {
        console.warn(
          `[${this.serverHostname}] Failed to get Docker port usage: ${error}`
        );
      }
    }

    return portUsage;
  }

  /**
   * Get port usage from system processes (non-Docker)
   */
  private async getSystemPortUsage(excludeDockerPorts: Set<number> = new Set()): Promise<PortUsage[]> {
    const portUsage: PortUsage[] = [];

    try {
      // Use netstat to get listening ports
      const netstatOutput = await this.sshClient.exec(
        `netstat -tlnp 2>/dev/null | grep LISTEN || ss -tlnp | grep LISTEN`
      );

      const lines = netstatOutput.split("\n");

      for (const line of lines) {
        if (!line.includes("LISTEN")) continue;

        // Parse different netstat/ss output formats
        const parts = line.trim().split(/\s+/);

        // Try to extract port from address (e.g., "0.0.0.0:5432", ":::80")
        let portMatch: RegExpMatchArray | null = null;
        for (const part of parts) {
          portMatch = part.match(/:(\d+)$/);
          if (portMatch) break;
        }

        if (portMatch) {
          const port = parseInt(portMatch[1]);

          // Skip ports that are already handled by Docker containers
          if (excludeDockerPorts.has(port)) {
            if (this.verbose) {
              console.log(`[${this.serverHostname}] Skipping port ${port} - already handled by Docker`);
            }
            continue;
          }

          // Try to extract process info (last part usually contains PID/process)
          const lastPart = parts[parts.length - 1];
          const processMatch = lastPart.match(/(\d+)\/(.*)/);

          let process = undefined;
          let pid = undefined;

          if (processMatch) {
            pid = parseInt(processMatch[1]);
            process = processMatch[2];
          }

          // Skip if this looks like a Docker process (we already got those)
          if (
            process &&
            (process.includes("docker") || process.includes("containerd"))
          ) {
            continue;
          }

          portUsage.push({
            port,
            protocol: line.includes("tcp") ? "tcp" : "udp",
            process,
            pid,
            isDockerContainer: false,
          });
        }
      }
    } catch (error) {
      if (this.verbose) {
        console.warn(
          `[${this.serverHostname}] Failed to get system port usage: ${error}`
        );
      }
    }

    return portUsage;
  }

  /**
   * Check for port conflicts with planned deployments
   */
  async checkPortConflicts(
    plannedPorts: Array<{
      hostPort: number;
      containerPort: number;
      requestedBy: string;
      protocol?: "tcp" | "udp";
    }>,
    projectName?: string
  ): Promise<PortConflict[]> {
    const currentUsage = await this.getPortUsage();
    const conflicts: PortConflict[] = [];

    for (const planned of plannedPorts) {
      const conflict = currentUsage.find(
        (usage) =>
          usage.port === planned.hostPort &&
          usage.protocol === (planned.protocol || "tcp")
      );

      if (conflict) {
        // If this is a Docker container from the same project, it's not a conflict
        // since we'll replace it during deployment
        if (conflict.isDockerContainer && projectName && conflict.containerName) {
          const isOwnProjectContainer = conflict.containerName.startsWith(`${projectName}-`);
          if (isOwnProjectContainer) {
            if (this.verbose) {
              console.log(
                `[${this.serverHostname}] Port ${planned.hostPort} used by own project container ${conflict.containerName}, will be replaced`
              );
            }
            continue; // Skip this conflict since we'll replace the container
          }
        }

        conflicts.push({
          port: planned.hostPort,
          hostPort: planned.hostPort,
          containerPort: planned.containerPort,
          requestedBy: planned.requestedBy,
          conflictsWith: conflict,
          serverHostname: this.serverHostname,
        });
      }
    }

    return conflicts;
  }

  /**
   * Generate suggestions for resolving port conflicts
   */
  generateConflictSuggestions(conflicts: PortConflict[]): string[] {
    const suggestions: string[] = [];

    if (conflicts.length === 0) {
      return suggestions;
    }

    suggestions.push("Port conflicts detected! Here are some solutions:");
    suggestions.push("");

    for (const conflict of conflicts) {
      suggestions.push(
        `❌ Port ${conflict.port} conflict for ${conflict.requestedBy}:`
      );

      if (conflict.conflictsWith.isDockerContainer) {
        suggestions.push(
          `   Already used by Docker container: ${conflict.conflictsWith.containerName} (${conflict.conflictsWith.containerImage})`
        );
      } else {
        suggestions.push(
          `   Already used by system process: ${
            conflict.conflictsWith.process || "unknown"
          } (PID: ${conflict.conflictsWith.pid || "unknown"})`
        );
      }

      suggestions.push("");
      suggestions.push("   Solutions:");
      suggestions.push(
        `   1. Use a different host port: "${conflict.port + 1000}:${
          conflict.containerPort
        }"`
      );
      suggestions.push(
        `   2. Remove port mapping entirely if external access isn't needed`
      );
      suggestions.push(`   3. Stop the conflicting service if it's not needed`);
      suggestions.push(`   4. Deploy to a different server`);
      suggestions.push("");
    }

    suggestions.push("Examples of fixing port conflicts:");
    suggestions.push("");
    suggestions.push("Option 1 - Use different host ports:");
    suggestions.push("services:");
    suggestions.push("  postgres:");
    suggestions.push("    ports:");
    suggestions.push(
      `      - "${conflicts[0]?.port + 1000 || 6432}:5432"  # Changed from ${
        conflicts[0]?.port || 5432
      }:5432`
    );
    suggestions.push("");
    suggestions.push("Option 2 - Remove external port access (recommended):");
    suggestions.push("services:");
    suggestions.push("  postgres:");
    suggestions.push("    # ports: [...] # Remove this line");
    suggestions.push("    # Access via internal network only");
    suggestions.push("");

    return suggestions;
  }
}

/**
 * Extract port mappings from Docker port specification
 */
export function parsePortMappings(ports: string[]): Array<{
  hostPort: number;
  containerPort: number;
  protocol: "tcp" | "udp";
}> {
  const mappings: Array<{
    hostPort: number;
    containerPort: number;
    protocol: "tcp" | "udp";
  }> = [];

  for (const port of ports) {
    // Handle different port formats:
    // "5432:5432"
    // "5432:5432/tcp"
    // "127.0.0.1:5432:5432"
    // "5432"

    let match = port.match(
      /^(?:\d+\.\d+\.\d+\.\d+:)?(\d+):(\d+)(?:\/(tcp|udp))?$/
    );
    if (match) {
      const [, hostPort, containerPort, protocol = "tcp"] = match;
      mappings.push({
        hostPort: parseInt(hostPort),
        containerPort: parseInt(containerPort),
        protocol: protocol as "tcp" | "udp",
      });
    } else {
      // Handle single port (maps to same port)
      match = port.match(/^(\d+)(?:\/(tcp|udp))?$/);
      if (match) {
        const [, portNum, protocol = "tcp"] = match;
        const portNumber = parseInt(portNum);
        mappings.push({
          hostPort: portNumber,
          containerPort: portNumber,
          protocol: protocol as "tcp" | "udp",
        });
      }
    }
  }

  return mappings;
}
