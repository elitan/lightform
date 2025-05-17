import path from "path";
import { mkdir } from "node:fs/promises";

// CONFIG_DIR is no longer needed
const LUMA_DIR = ".luma";
const CONFIG_FILE = "luma.yml";
const SECRETS_FILE = "secrets";

const ACTUAL_CONFIG_PATH = CONFIG_FILE; // Config file will be in the root
const ACTUAL_SECRETS_PATH = path.join(LUMA_DIR, SECRETS_FILE);

const MINIMAL_CONFIG_CONTENT = `services:
  image: google/gmail 
  servers:
    - 192.168.0.1
    - 192.168.0.2
  build:
    context: .
    dockerfile: Dockerfile
  ports:
    - "80:80" # Maps host port 80 to container port 80. Adjust if your app uses a different port.
  # environment:
  #   plain:
  #     - VAR_NAME=var_value
  #   secret:
  #     - SECRET_KEY_NAME # Will be sourced from .luma/secrets
`;

export async function initCommand() {
  let configCreated = false;
  let secretsCreated = false;

  try {
    // No longer creating CONFIG_DIR
    await mkdir(LUMA_DIR, { recursive: true });
  } catch (e) {
    const error = e as Error & { code?: string };
    if (error.code !== "EEXIST") {
      console.error(`Error creating directory ${LUMA_DIR}: ${error.message}`);
      // Decide if we should return or try to continue if only .luma dir fails
      // For now, let's return, as secrets file depends on it.
      return;
    }
  }

  // Config file handling
  const actualConfigFile = Bun.file(ACTUAL_CONFIG_PATH);
  const configExistsInitially = await actualConfigFile.exists();

  if (configExistsInitially) {
    console.log(`Configuration file ${ACTUAL_CONFIG_PATH} already exists.`);
  } else {
    try {
      await Bun.write(actualConfigFile, MINIMAL_CONFIG_CONTENT); // Create a minimal config file
      console.log(`Created minimal configuration file: ${ACTUAL_CONFIG_PATH}`);
      configCreated = true;
    } catch (e) {
      const error = e as Error;
      console.error(`Error creating ${ACTUAL_CONFIG_PATH}: ${error.message}`);
    }
  }

  // Secrets file handling
  const actualSecretsFile = Bun.file(ACTUAL_SECRETS_PATH);
  const secretsExistInitially = await actualSecretsFile.exists();

  if (secretsExistInitially) {
    console.log(`Secrets file ${ACTUAL_SECRETS_PATH} already exists.`);
  } else {
    try {
      await Bun.write(actualSecretsFile, ""); // Create an empty secrets file
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
