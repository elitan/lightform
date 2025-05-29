import path from "path";
import { mkdir, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "readline";

const LUMA_DIR = ".luma";
const CONFIG_FILE = "luma.yml";
const SECRETS_FILE = "secrets";

const ACTUAL_CONFIG_PATH = CONFIG_FILE; // Config file will be in the root
const ACTUAL_SECRETS_PATH = path.join(LUMA_DIR, SECRETS_FILE);

interface ConfigPrompts {
  projectName: string;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptForConfig(): Promise<ConfigPrompts> {
  console.log("Let's set up your Luma configuration!\n");

  const projectName =
    (await prompt("Project name (my-project): ")) || "my-project";

  return { projectName };
}

function generateConfigContent(config: ConfigPrompts): string {
  return `name: ${config.projectName}

ssh:
  username: your-ssh-username

apps:
  web:
    servers:
      - your-server-ip
    proxy:
      hosts:
        - your-domain.com
      app_port: 3000
`;
}

export async function initCommand(nonInteractive: boolean = false) {
  let configCreated = false;
  let secretsCreated = false;

  try {
    await mkdir(LUMA_DIR, { recursive: true });
  } catch (e) {
    const error = e as Error & { code?: string };
    if (error.code !== "EEXIST") {
      console.error(`Error creating directory ${LUMA_DIR}: ${error.message}`);
      return;
    }
  }

  // Config file handling
  let configExistsInitially = false;
  try {
    await access(ACTUAL_CONFIG_PATH, constants.F_OK);
    configExistsInitially = true;
  } catch {
    // File doesn't exist
  }

  if (configExistsInitially) {
    console.log(`Configuration file ${ACTUAL_CONFIG_PATH} already exists.`);
  } else {
    try {
      const configData = nonInteractive
        ? { projectName: "test-project" }
        : await promptForConfig();
      const configContent = generateConfigContent(configData);

      await writeFile(ACTUAL_CONFIG_PATH, configContent, "utf8");
      console.log(`\nCreated configuration file: ${ACTUAL_CONFIG_PATH}`);
      configCreated = true;
    } catch (e) {
      const error = e as Error;
      console.error(`Error creating ${ACTUAL_CONFIG_PATH}: ${error.message}`);
    }
  }

  // Secrets file handling
  let secretsExistInitially = false;
  try {
    await access(ACTUAL_SECRETS_PATH, constants.F_OK);
    secretsExistInitially = true;
  } catch {
    // File doesn't exist
  }

  if (secretsExistInitially) {
    console.log(`Secrets file ${ACTUAL_SECRETS_PATH} already exists.`);
  } else {
    try {
      await writeFile(ACTUAL_SECRETS_PATH, "", "utf8");
      console.log(`Created empty secrets file: ${ACTUAL_SECRETS_PATH}`);
      secretsCreated = true;
    } catch (e) {
      const error = e as Error;
      console.error(`Error creating ${ACTUAL_SECRETS_PATH}: ${error.message}`);
    }
  }

  // Final status messages for files that were attempted to be created but failed
  if (!configCreated && !configExistsInitially) {
    console.log(
      `Configuration file ${ACTUAL_CONFIG_PATH} could not be created. Check errors above.`
    );
  }
  if (!secretsCreated && !secretsExistInitially) {
    console.log(
      `Secrets file ${ACTUAL_SECRETS_PATH} could not be created. Check errors above.`
    );
  }
}
