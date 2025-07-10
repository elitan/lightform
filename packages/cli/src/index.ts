#!/usr/bin/env node

import { initCommand } from "./commands/init";
import { setupCommand } from "./commands/setup";
import { deployCommand } from "./commands/deploy";
import { statusCommand } from "./commands/status";
import { proxyCommand } from "./commands/proxy";

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
  const args = process.argv.slice(2); // Remove 'node' and script path from args

  if (args.length === 0) {
    console.log("Lightform CLI - Please provide a command.");
    console.log("Available commands: init, setup, deploy, status, proxy");
    console.log("\nProxy Management:");
    console.log("  lightform proxy help  Show proxy command help");
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
    case "proxy":
      await proxyCommand(commandArgs);
      break;
    default:
      console.log(`Unknown command: ${command}`);
      console.log(
        "Available commands: init, setup, deploy, status, proxy, redeploy, rollback"
      );
      break;
  }
}

main().catch((error) => {
  console.error("An unexpected error occurred:", error);
  process.exit(1);
});
