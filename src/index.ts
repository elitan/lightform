#!/usr/bin/env bun

import { initCommand } from "./commands/init";
import { setupCommand } from "./commands/setup";
import { deployCommand } from "./commands/deploy";
import { statusCommand } from "./commands/status";

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

async function main() {
  const args = Bun.argv.slice(2); // Remove 'bun' and 'src/index.ts' from args

  if (args.length === 0) {
    console.log("Luma CLI - Please provide a command.");
    console.log(
      "Available commands: init, setup, deploy, status, redeploy, rollback"
    );
    console.log("\nFlags:");
    console.log("  --verbose    Show detailed output");
    console.log("  --force      Force operation (deploy only)");
    console.log("  --services   Deploy services instead of apps (deploy only)");
    return;
  }

  const command = args[0];
  const commandArgs = args.slice(1);
  const { flags, nonFlagArgs } = parseArgs(commandArgs);
  const verboseFlag = flags.includes("--verbose");

  switch (command) {
    case "init":
      await initCommand();
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
    // TODO: Add cases for other commands (redeploy, rollback, etc.)
    default:
      console.log(`Unknown command: ${command}`);
      console.log(
        "Available commands: init, setup, deploy, status, redeploy, rollback"
      );
      break;
  }
}

main().catch((error) => {
  console.error("An unexpected error occurred:", error);
  process.exit(1);
});
