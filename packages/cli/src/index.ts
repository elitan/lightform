#!/usr/bin/env node

import { initCommand } from "./commands/init";
import { deployCommand } from "./commands/deploy";
import { statusCommand } from "./commands/status";
import { proxyCommand } from "./commands/proxy";

/**
 * Shows comprehensive help for the iop CLI
 */
function showMainHelp(): void {
  console.log("iop CLI - Zero-downtime Docker deployments");
  console.log("================================================");
  console.log("");
  console.log("USAGE:");
  console.log("  iop [flags]                 # Deploy (default action)");
  console.log("  iop <command> [flags]       # Run specific command");
  console.log("");
  console.log("COMMANDS:");
  console.log("  init      Initialize iop.yml config and secrets file");
  console.log("  status    Check deployment status across all servers");
  console.log("  proxy     Manage iop proxy (status, update)");
  console.log("");
  console.log("GLOBAL FLAGS:");
  console.log("  --help     Show command help");
  console.log("  --verbose  Show detailed output");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  iop init                    # Initialize new project");
  console.log(
    "  iop                         # Deploy all apps and services"
  );
  console.log(
    "  iop --verbose               # Deploy with detailed output"
  );
  console.log("  iop status                  # Check all deployments");
  console.log("  iop proxy status            # Check proxy status");
  console.log("");
  console.log("GETTING STARTED:");
  console.log("  1. iop init                 # Create config files");
  console.log(
    "  2. Edit iop.yml             # Configure your apps and servers"
  );
  console.log(
    "  3. iop                      # Deploy your apps and services"
  );
  console.log("");
  console.log("For command-specific help: iop <command> --help");
}

/**
 * Shows command-specific help
 */
function showCommandHelp(command: string): void {
  switch (command) {
    case "init":
      console.log("Initialize iop project");
      console.log("============================");
      console.log("");
      console.log("USAGE:");
      console.log("  iop init [flags]");
      console.log("");
      console.log("DESCRIPTION:");
      console.log(
        "  Creates iop.yml configuration file and .iop/secrets file."
      );
      console.log(
        "  Automatically adds secrets file to .gitignore for security."
      );
      console.log("");
      console.log("FLAGS:");
      console.log("  --help     Show this help message");
      console.log("");
      console.log("EXAMPLES:");
      console.log("  iop init                    # Interactive setup");
      break;

    case "deploy":
      console.log("Deploy apps and services (default command)");
      console.log("===========================================");
      console.log("");
      console.log("USAGE:");
      console.log(
        "  iop [entry-names...] [flags]       # Default - no 'deploy' needed"
      );
      console.log(
        "  iop deploy [entry-names...] [flags] # Explicit command"
      );
      console.log("");
      console.log("DESCRIPTION:");
      console.log(
        "  Deploys apps and services to configured servers with zero downtime."
      );
      console.log(
        "  Automatically sets up infrastructure if needed (no separate setup needed)."
      );
      console.log("  Apps use blue-green deployment for zero downtime.");
      console.log("  Services restart briefly during deployment.");
      console.log("");
      console.log("FLAGS:");
      console.log("  --services   Deploy services only (skip apps)");
      console.log("  --verbose    Show detailed deployment progress");
      console.log("  --help       Show this help message");
      console.log("");
      console.log("EXAMPLES:");
      console.log(
        "  iop                         # Deploy all apps and services"
      );
      console.log(
        "  iop web api                 # Deploy specific apps/services"
      );
      console.log("  iop --services              # Deploy only services");
      console.log(
        "  iop --verbose               # Deploy with detailed output"
      );
      console.log("");
      console.log("NOTES:");
      console.log(
        "  - Infrastructure setup is automatic (no separate setup command)"
      );
      console.log(
        "  - Commit git changes before deploying"
      );
      console.log("  - Requires Docker running locally for image builds");
      console.log(
        "  - App/service names cannot be: init, status, proxy (reserved)"
      );
      break;

    case "status":
      console.log("Check deployment status");
      console.log("=======================");
      console.log("");
      console.log("USAGE:");
      console.log("  iop status [entry-names...] [flags]");
      console.log("");
      console.log("DESCRIPTION:");
      console.log(
        "  Shows comprehensive status of apps, services, and proxy across servers."
      );
      console.log(
        "  Includes container health, resource usage, and deployment information."
      );
      console.log("");
      console.log("FLAGS:");
      console.log("  --verbose  Show detailed status information");
      console.log("  --help     Show this help message");
      console.log("");
      console.log("EXAMPLES:");
      console.log(
        "  iop status                  # Check all deployments"
      );
      console.log("  iop status web              # Check specific app");
      console.log("  iop status --verbose        # Detailed status info");
      break;

    case "proxy":
      console.log("Manage iop proxy");
      console.log("======================");
      console.log("");
      console.log("USAGE:");
      console.log("  iop proxy <subcommand> [flags]");
      console.log("");
      console.log("DESCRIPTION:");
      console.log(
        "  Manage the iop reverse proxy that handles SSL and routing."
      );
      console.log("");
      console.log("SUBCOMMANDS:");
      console.log("  status     Show proxy status on all servers");
      console.log("  update     Update proxy to latest version");
      console.log("");
      console.log("FLAGS:");
      console.log("  --verbose  Show detailed output");
      console.log("  --help     Show this help message");
      break;

    default:
      console.log(`Unknown command: ${command}`);
      console.log("Use 'iop --help' to see available commands.");
  }
}

/**
 * Parses command line arguments to extract flags and non-flag arguments
 */
function parseArgs(args: string[]): { flags: string[]; nonFlagArgs: string[] } {
  const flags: string[] = [];
  const nonFlagArgs: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("--")) {
      flags.push(arg);
    } else {
      nonFlagArgs.push(arg);
    }
  }

  return { flags, nonFlagArgs };
}

/**
 * Provides helpful error message and suggestions for common CLI issues
 */
function handleCliError(error: Error): void {
  console.error("\nError:", error.message);

  // Provide specific suggestions based on error type
  if (
    error.message.includes("ENOENT") ||
    error.message.includes("iop.yml")
  ) {
    console.error("\nSuggestion:");
    console.error("   Run 'iop init' to create configuration files");
  } else if (
    error.message.includes("SSH") ||
    error.message.includes("connection")
  ) {
    console.error("\nSuggestions:");
    console.error("   - Check server hostname in iop.yml");
    console.error("   - Verify SSH access to your servers");
    console.error("   - Use --verbose flag for detailed connection info");
  } else if (error.message.includes("Docker")) {
    console.error("\nSuggestions:");
    console.error("   - Ensure Docker is running locally");
    console.error("   - Run 'iop setup' to install Docker on servers");
  } else if (
    error.message.includes("git") ||
    error.message.includes("uncommitted")
  ) {
    console.error("\nSuggestions:");
    console.error(
      "   - Commit your changes: git add . && git commit -m 'message'"
    );
  }

  console.error(
    "\nNeed help? Use 'iop --help' or 'iop <command> --help'"
  );
}

async function main() {
  const args = process.argv.slice(2); // Remove 'node' and script path from args

  // Handle help flags and no arguments
  if (args.includes("--help") || args.includes("-h")) {
    if (args[0] && !args[0].startsWith("-")) {
      // Command-specific help: iop deploy --help
      showCommandHelp(args[0]);
    } else {
      // Global help: iop --help
      showMainHelp();
    }
    return;
  }

  // If no command provided (only flags or nothing), default to deploy
  let command = args[0];
  let commandArgs = args.slice(1);

  if (args.length === 0 || (args[0] && args[0].startsWith("--"))) {
    // No command provided, or first arg is a flag - default to deploy
    command = "deploy";
    commandArgs = args; // All args become command args for deploy
  }
  const { flags, nonFlagArgs } = parseArgs(commandArgs);
  const verboseFlag = flags.includes("--verbose");
  const helpFlag = flags.includes("--help") || flags.includes("-h");

  // Handle command-specific help
  if (helpFlag) {
    showCommandHelp(command);
    return;
  }

  // Validate command before executing
  const validCommands = ["init", "deploy", "status", "proxy"];
  if (!validCommands.includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error("");
    console.error("Available commands:");
    validCommands.forEach((cmd) => {
      console.error(`   ${cmd}`);
    });
    console.error("");
    console.error("Use 'iop --help' for more information.");
    process.exit(1);
  }

  try {
    switch (command) {
      case "init":
        await initCommand(commandArgs);
        break;
      case "deploy":
        await deployCommand(commandArgs); // deploy handles its own flag parsing
        break;
      case "status":
        await statusCommand(nonFlagArgs, verboseFlag);
        break;
      case "proxy":
        await proxyCommand(commandArgs);
        break;
    }
  } catch (error) {
    if (error instanceof Error) {
      handleCliError(error);
    } else {
      console.error("An unexpected error occurred:", error);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  if (error instanceof Error) {
    console.error("Fatal error:", error.message);
    console.error("\nUse 'iop --help' for usage information.");
  } else {
    console.error("An unexpected error occurred:", error);
  }
  process.exit(1);
});
