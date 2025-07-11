#!/usr/bin/env node

import { initCommand } from "./commands/init";
import { setupCommand } from "./commands/setup";
import { deployCommand } from "./commands/deploy";
import { statusCommand } from "./commands/status";
import { proxyCommand } from "./commands/proxy";

/**
 * Shows comprehensive help for the Lightform CLI
 */
function showMainHelp(): void {
  console.log("Lightform CLI - Zero-downtime Docker deployments");
  console.log("================================================");
  console.log("");
  console.log("USAGE:");
  console.log("  lightform <command> [flags]");
  console.log("");
  console.log("COMMANDS:");
  console.log("  init      Initialize lightform.yml config and secrets file");
  console.log("  setup     Bootstrap and configure servers with Docker and proxy");
  console.log("  deploy    Deploy apps and services to configured servers");
  console.log("  status    Check deployment status across all servers");
  console.log("  proxy     Manage Lightform proxy (status, update)");
  console.log("");
  console.log("GLOBAL FLAGS:");
  console.log("  --help     Show command help");
  console.log("  --verbose  Show detailed output");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  lightform init                    # Initialize new project");
  console.log("  lightform setup --verbose         # Setup servers with detailed output");
  console.log("  lightform deploy                  # Deploy all apps");
  console.log("  lightform deploy web --force      # Force deploy specific app");
  console.log("  lightform status                  # Check all deployments");
  console.log("  lightform proxy status            # Check proxy status");
  console.log("");
  console.log("GETTING STARTED:");
  console.log("  1. lightform init                 # Create config files");
  console.log("  2. Edit lightform.yml             # Configure your apps and servers");
  console.log("  3. lightform setup                # Bootstrap your servers");
  console.log("  4. lightform deploy               # Deploy your apps");
  console.log("");
  console.log("For command-specific help: lightform <command> --help");
}

/**
 * Shows command-specific help
 */
function showCommandHelp(command: string): void {
  switch (command) {
    case "init":
      console.log("Initialize Lightform project");
      console.log("============================");
      console.log("");
      console.log("USAGE:");
      console.log("  lightform init [flags]");
      console.log("");
      console.log("DESCRIPTION:");
      console.log("  Creates lightform.yml configuration file and .lightform/secrets file.");
      console.log("  Automatically adds secrets file to .gitignore for security.");
      console.log("");
      console.log("FLAGS:");
      console.log("  --help     Show this help message");
      console.log("");
      console.log("EXAMPLES:");
      console.log("  lightform init                    # Interactive setup");
      break;

    case "setup":
      console.log("Setup and configure servers");
      console.log("============================");
      console.log("");
      console.log("USAGE:");
      console.log("  lightform setup [entry-names...] [flags]");
      console.log("");
      console.log("DESCRIPTION:");
      console.log("  Bootstraps fresh servers and configures infrastructure.");
      console.log("  Installs Docker, creates networks, sets up proxy, and starts services.");
      console.log("  For fresh servers (root access), automatically creates lightform user.");
      console.log("");
      console.log("FLAGS:");
      console.log("  --verbose  Show detailed setup progress");
      console.log("  --help     Show this help message");
      console.log("");
      console.log("EXAMPLES:");
      console.log("  lightform setup                   # Setup all servers");
      console.log("  lightform setup web               # Setup servers for 'web' app only");
      console.log("  lightform setup --verbose         # Setup with detailed output");
      console.log("");
      console.log("TROUBLESHOOTING:");
      console.log("  - Ensure SSH access to your servers");
      console.log("  - For fresh servers, ensure root SSH access initially");
      console.log("  - Check lightform.yml has correct server hostnames");
      break;

    case "deploy":
      console.log("Deploy apps and services");
      console.log("========================");
      console.log("");
      console.log("USAGE:");
      console.log("  lightform deploy [app-names...] [flags]");
      console.log("");
      console.log("DESCRIPTION:");
      console.log("  Performs zero-downtime deployment of apps using blue-green strategy.");
      console.log("  Builds images locally, transfers to servers, and switches traffic.");
      console.log("  Services are deployed directly (no blue-green).");
      console.log("");
      console.log("FLAGS:");
      console.log("  --force      Deploy even with uncommitted git changes");
      console.log("  --services   Deploy services instead of apps");
      console.log("  --verbose    Show detailed deployment progress");
      console.log("  --help       Show this help message");
      console.log("");
      console.log("EXAMPLES:");
      console.log("  lightform deploy                  # Deploy all apps");
      console.log("  lightform deploy web api          # Deploy specific apps");
      console.log("  lightform deploy --services       # Deploy all services");
      console.log("  lightform deploy web --force      # Force deploy ignoring git status");
      console.log("");
      console.log("REQUIREMENTS:");
      console.log("  - Run 'lightform setup' first");
      console.log("  - Commit git changes (or use --force)");
      console.log("  - Docker running locally for image builds");
      break;

    case "status":
      console.log("Check deployment status");
      console.log("=======================");
      console.log("");
      console.log("USAGE:");
      console.log("  lightform status [entry-names...] [flags]");
      console.log("");
      console.log("DESCRIPTION:");
      console.log("  Shows comprehensive status of apps, services, and proxy across servers.");
      console.log("  Includes container health, resource usage, and deployment information.");
      console.log("");
      console.log("FLAGS:");
      console.log("  --verbose  Show detailed status information");
      console.log("  --help     Show this help message");
      console.log("");
      console.log("EXAMPLES:");
      console.log("  lightform status                  # Check all deployments");
      console.log("  lightform status web              # Check specific app");
      console.log("  lightform status --verbose        # Detailed status info");
      break;

    case "proxy":
      console.log("Manage Lightform proxy");
      console.log("======================");
      console.log("");
      console.log("USAGE:");
      console.log("  lightform proxy <subcommand> [flags]");
      console.log("");
      console.log("DESCRIPTION:");
      console.log("  Manage the Lightform reverse proxy that handles SSL and routing.");
      console.log("");
      console.log("SUBCOMMANDS:");
      console.log("  status     Show proxy status on all servers");
      console.log("  update     Update proxy to latest version");
      console.log("");
      console.log("FLAGS:");
      console.log("  --verbose  Show detailed output");
      console.log("  --force    Force update (update subcommand only)");
      console.log("  --help     Show this help message");
      break;

    default:
      console.log(`Unknown command: ${command}`);
      console.log("Use 'lightform --help' to see available commands.");
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
  if (error.message.includes("ENOENT") || error.message.includes("lightform.yml")) {
    console.error("\nSuggestion:");
    console.error("   Run 'lightform init' to create configuration files");
  } else if (error.message.includes("SSH") || error.message.includes("connection")) {
    console.error("\nSuggestions:");
    console.error("   - Check server hostname in lightform.yml");
    console.error("   - Verify SSH access to your servers");
    console.error("   - Use --verbose flag for detailed connection info");
  } else if (error.message.includes("Docker")) {
    console.error("\nSuggestions:");
    console.error("   - Ensure Docker is running locally");
    console.error("   - Run 'lightform setup' to install Docker on servers");
  } else if (error.message.includes("git") || error.message.includes("uncommitted")) {
    console.error("\nSuggestions:");
    console.error("   - Commit your changes: git add . && git commit -m 'message'");
    console.error("   - Or use --force flag to deploy anyway");
  }
  
  console.error("\nNeed help? Use 'lightform --help' or 'lightform <command> --help'");
}

async function main() {
  const args = process.argv.slice(2); // Remove 'node' and script path from args

  // Handle global help flags
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    if (args.length === 0) {
      showMainHelp();
    } else if (args[0] && !args[0].startsWith("-")) {
      // Command-specific help: lightform deploy --help
      showCommandHelp(args[0]);
    } else {
      // Global help: lightform --help
      showMainHelp();
    }
    return;
  }

  const command = args[0];
  const commandArgs = args.slice(1);
  const { flags, nonFlagArgs } = parseArgs(commandArgs);
  const verboseFlag = flags.includes("--verbose");
  const helpFlag = flags.includes("--help") || flags.includes("-h");

  // Handle command-specific help
  if (helpFlag) {
    showCommandHelp(command);
    return;
  }

  // Validate command before executing
  const validCommands = ["init", "setup", "deploy", "status", "proxy"];
  if (!validCommands.includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error("");
    console.error("Available commands:");
    validCommands.forEach(cmd => {
      console.error(`   ${cmd}`);
    });
    console.error("");
    console.error("Use 'lightform --help' for more information.");
    process.exit(1);
  }

  try {
    switch (command) {
      case "init":
        await initCommand(commandArgs);
        break;
      case "setup":
        await setupCommand(nonFlagArgs, verboseFlag);
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
    console.error("\nUse 'lightform --help' for usage information.");
  } else {
    console.error("An unexpected error occurred:", error);
  }
  process.exit(1);
});
