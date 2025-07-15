import { LightformConfig, AppEntry, ServiceEntry } from "../config/types";
import { parsePortMappings } from "./port-checker";

export interface ConfigValidationError {
  type: "port_conflict" | "invalid_port" | "configuration_error" | "reserved_name";
  message: string;
  entries: string[];
  server: string;
  port?: number;
  suggestions?: string[];
}

export class ConfigValidator {
  private config: LightformConfig;
  
  // Reserved command names that cannot be used as app/service names
  private static readonly RESERVED_NAMES = ["init", "status", "proxy"];

  constructor(config: LightformConfig) {
    this.config = config;
  }

  /**
   * Validates the entire configuration for common issues
   */
  validate(): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];

    // Check for reserved names
    const reservedNameErrors = this.checkReservedNames();
    errors.push(...reservedNameErrors);

    // Check for port conflicts within the same project
    const portConflicts = this.checkIntraProjectPortConflicts();
    errors.push(...portConflicts);

    // Check for invalid port configurations
    const invalidPorts = this.checkInvalidPorts();
    errors.push(...invalidPorts);

    return errors;
  }

  /**
   * Checks for reserved command names being used as app/service names
   */
  private checkReservedNames(): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];
    const allEntries = this.getAllEntries();

    for (const entry of allEntries) {
      if (ConfigValidator.RESERVED_NAMES.includes(entry.name)) {
        errors.push({
          type: "reserved_name",
          message: `App/service name "${entry.name}" is reserved and cannot be used`,
          entries: [entry.name],
          server: entry.server,
          suggestions: this.generateReservedNameSuggestions(entry.name),
        });
      }
    }

    return errors;
  }

  /**
   * Checks for port conflicts within the same project configuration
   */
  private checkIntraProjectPortConflicts(): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];
    const serverPortUsage = new Map<string, Map<number, string[]>>();

    // Get all entries (apps and services)
    const allEntries = this.getAllEntries();

    // Group port usage by server
    for (const entry of allEntries) {
      if (!entry.ports) continue;

      const serverName = entry.server;
      if (!serverPortUsage.has(serverName)) {
        serverPortUsage.set(serverName, new Map());
      }

      const serverPorts = serverPortUsage.get(serverName)!;

      try {
        const portMappings = parsePortMappings(entry.ports);

        for (const mapping of portMappings) {
          const hostPort = mapping.hostPort;

          if (!serverPorts.has(hostPort)) {
            serverPorts.set(hostPort, []);
          }

          serverPorts.get(hostPort)!.push(entry.name);
        }
      } catch (error) {
        // Handle invalid port format - will be caught by checkInvalidPorts
        continue;
      }
    }

    // Check for conflicts
    for (const [serverName, portMap] of serverPortUsage) {
      for (const [port, entries] of portMap) {
        if (entries.length > 1) {
          errors.push({
            type: "port_conflict",
            message: `Port ${port} is used by multiple services on server ${serverName}`,
            entries,
            server: serverName,
            port,
            suggestions: this.generatePortConflictSuggestions(
              port,
              entries,
              serverName
            ),
          });
        }
      }
    }

    return errors;
  }

  /**
   * Checks for invalid port configurations
   */
  private checkInvalidPorts(): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];
    const allEntries = this.getAllEntries();

    for (const entry of allEntries) {
      if (!entry.ports) continue;

      for (const portSpec of entry.ports) {
        if (!this.isValidPortSpec(portSpec)) {
          errors.push({
            type: "invalid_port",
            message: `Invalid port specification: "${portSpec}" in ${entry.name}`,
            entries: [entry.name],
            server: entry.server,
            suggestions: [
              "Valid port formats:",
              '- "80:80" (host:container)',
              '- "8080:80" (different host and container ports)',
              '- "127.0.0.1:8080:80" (bind to specific IP)',
              '- "80" (same port for host and container)',
              '- "80/tcp" or "80/udp" (specify protocol)',
            ],
          });
        }
      }
    }

    return errors;
  }

  /**
   * Validates a port specification format
   */
  private isValidPortSpec(portSpec: string): boolean {
    // Valid formats:
    // "80", "80/tcp", "80/udp"
    // "80:80", "80:80/tcp", "80:80/udp"
    // "127.0.0.1:80:80", "127.0.0.1:80:80/tcp"

    const patterns = [
      /^(\d+)(?:\/(tcp|udp))?$/, // "80" or "80/tcp"
      /^(\d+):(\d+)(?:\/(tcp|udp))?$/, // "80:80" or "80:80/tcp"
      /^(\d+\.\d+\.\d+\.\d+):(\d+):(\d+)(?:\/(tcp|udp))?$/, // "127.0.0.1:80:80"
    ];

    return patterns.some((pattern) => pattern.test(portSpec));
  }

  /**
   * Gets all entries (apps and services) from the configuration
   */
  private getAllEntries(): Array<AppEntry | ServiceEntry> {
    const entries: Array<AppEntry | ServiceEntry> = [];

    // Add apps
    if (this.config.apps) {
      if (Array.isArray(this.config.apps)) {
        entries.push(...this.config.apps);
      } else {
        // Convert object format to array
        for (const [name, app] of Object.entries(this.config.apps)) {
          entries.push({ ...app, name });
        }
      }
    }

    // Add services
    if (this.config.services) {
      if (Array.isArray(this.config.services)) {
        entries.push(...this.config.services);
      } else {
        // Convert object format to array
        for (const [name, service] of Object.entries(this.config.services)) {
          entries.push({ ...service, name });
        }
      }
    }

    return entries;
  }

  /**
   * Generates suggestions for resolving reserved name conflicts
   */
  private generateReservedNameSuggestions(reservedName: string): string[] {
    const suggestions = [
      `The name "${reservedName}" is reserved for CLI commands.`,
      "",
      "Reserved names: " + ConfigValidator.RESERVED_NAMES.join(", "),
      "",
      "Try using a different name like:",
      `• ${reservedName}-app`,
      `• ${reservedName}-service`,  
      `• web-${reservedName}`,
      `• api-${reservedName}`,
      `• my-${reservedName}`,
      "",
      "Example fix:",
      "# Before:",
      `apps:`,
      `  ${reservedName}:`,
      "    # ... your config",
      "",
      "# After:",
      `apps:`,
      `  ${reservedName}-app:`,
      "    # ... your config",
    ];

    return suggestions;
  }

  /**
   * Generates suggestions for resolving port conflicts
   */
  private generatePortConflictSuggestions(
    port: number,
    conflictingEntries: string[],
    serverName: string
  ): string[] {
    const suggestions = [
      `Port ${port} conflict between: ${conflictingEntries.join(", ")}`,
      "",
      "Solutions:",
      `1. Use different host ports (e.g., ${port + 1000}, ${port + 2000})`,
      "2. Remove port mappings if external access is not needed",
      "3. Deploy conflicting services to different servers",
      "",
      "Example fix:",
      `# Original (conflicting):`,
      `services:`,
      `  ${conflictingEntries[0]}:`,
      `    ports: ["${port}:${port}"]`,
      `  ${conflictingEntries[1]}:`,
      `    ports: ["${port}:${port}"]`,
      "",
      "# Fixed:",
      `services:`,
      `  ${conflictingEntries[0]}:`,
      `    ports: ["${port}:${port}"]`,
      `  ${conflictingEntries[1]}:`,
      `    ports: ["${port + 1000}:${port}"]  # Different host port`,
      "",
      "Or remove external access (recommended for databases):",
      `services:`,
      `  ${conflictingEntries[0]}:`,
      `    # ports: [...]  # Remove for internal-only access`,
      `  ${conflictingEntries[1]}:`,
      `    # ports: [...]  # Remove for internal-only access`,
    ];

    return suggestions;
  }
}

/**
 * Validates a Lightform configuration and returns any errors found
 */
export function validateConfig(config: LightformConfig): ConfigValidationError[] {
  const validator = new ConfigValidator(config);
  return validator.validate();
}

/**
 * Formats validation errors for display
 */
export function formatValidationErrors(
  errors: ConfigValidationError[]
): string[] {
  const formatted: string[] = [];

  if (errors.length === 0) {
    return formatted;
  }

  formatted.push("❌ Configuration validation failed:");
  formatted.push("");

  for (const error of errors) {
    formatted.push(`• ${error.message}`);
    if (error.suggestions) {
      formatted.push("");
      for (const suggestion of error.suggestions) {
        formatted.push(`  ${suggestion}`);
      }
    }
    formatted.push("");
  }

  return formatted;
}
