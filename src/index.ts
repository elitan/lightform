#!/usr/bin/env bun

import { initCommand } from "./commands/init";
import { setupCommand } from "./commands/setup";
import { deployCommand } from "./commands/deploy";
import { statusCommand } from "./commands/status";

async function main() {
  const args = Bun.argv.slice(2); // Remove 'bun' and 'src/index.ts' from args

  if (args.length === 0) {
    console.log("Luma CLI - Please provide a command.");
    console.log(
      "Available commands: init, setup, deploy, status, redeploy, rollback"
    );
    // TODO: Add more detailed help/usage instructions
    return;
  }

  const command = args[0];

  switch (command) {
    case "init":
      await initCommand();
      break;
    case "setup":
      await setupCommand(args.slice(1));
      break;
    case "deploy":
      await deployCommand(args.slice(1));
      break;
    case "status":
      await statusCommand(args.slice(1));
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
