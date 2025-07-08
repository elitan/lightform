import fs from "node:fs/promises";
import path from "path";
import yaml from "js-yaml";
import {
  LumaConfigSchema,
  LumaSecretsSchema,
  LumaConfig,
  LumaSecrets,
} from "./types";

const LUMA_DIR = ".luma";
const CONFIG_FILE = "luma.yml";
const SECRETS_FILE = "secrets";

export async function loadConfig(): Promise<LumaConfig> {
  try {
    const configFile = await fs.readFile(CONFIG_FILE, "utf-8");
    const rawConfig = yaml.load(configFile);

    // Validate and parse using Zod schema
    const validationResult = LumaConfigSchema.safeParse(rawConfig);
    if (!validationResult.success) {
      console.error(`Invalid configuration in ${CONFIG_FILE}:`);

      // Enhanced error messages with more helpful guidance
      validationResult.error.errors.forEach((err) => {
        const path = err.path.join(".");
        let message = err.message;

        // Special handling for common configuration issues
        if (path === "name" && message.includes("Required")) {
          console.error(`  Error: Missing required 'name' field`);
          console.error(
            `  Help: Add 'name: your-project-name' to the top of luma.yml`
          );
          console.error(
            `  Note: The project name is used for network naming and other identifiers.`
          );
        } else if (path === "project_name") {
          console.error(`  Error: 'project_name' field is not recognized`);
          console.error(
            `  Help: Use 'name' instead of 'project_name' at the top of luma.yml`
          );
        } else if (path === "apps" && message.includes("Expected")) {
          console.error(`  Error: Issue with the 'apps' section format`);
          console.error(`  Required format:    Where each key is an app name`);
          console.error(`    apps:`);
          console.error(
            `      web:            <-- Object format using app name as key`
          );
          console.error(`        image: ...`);
          console.error(`        servers:`);
          console.error(`          - hostname1`);
        } else if (path === "services" && message.includes("Expected")) {
          console.error(`  Error: Issue with the 'services' section format`);
          console.error(
            `  Required format:    Where each key is a service name`
          );
          console.error(`    services:`);
          console.error(
            `      db:             <-- Object format using service name as key`
          );
          console.error(`        image: ...`);
          console.error(`        servers:`);
          console.error(`          - hostname1`);
        } else if (
          path.includes("environment.plain") &&
          message.includes("Expected")
        ) {
          console.error(
            `  Error: Environment variables should be in array format with '='`
          );
          console.error(`  Required format:`);
          console.error(`    environment:`);
          console.error(`      plain:`);
          console.error(
            `        - KEY=VALUE   <-- Array format with KEY=VALUE format`
          );
          console.error(`        - PORT=8080`);
        } else {
          console.error(`  Path: ${path}, Message: ${message}`);
        }
      });

      throw new Error(`Invalid configuration in ${CONFIG_FILE}.`);
    }
    return validationResult.data;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Invalid configuration")
    ) {
      throw error; // Re-throw Zod validation error
    }
    console.error(`Error loading or parsing ${CONFIG_FILE}:`, error);
    throw error; // Re-throw other errors (e.g., file not found)
  }
}

export async function loadSecrets(): Promise<LumaSecrets> {
  const secretsPath = path.join(LUMA_DIR, SECRETS_FILE);
  try {
    const secretsFile = await fs.readFile(secretsPath, "utf-8");
    const parsedSecrets: Record<string, string> = {};
    secretsFile.split("\n").forEach((line) => {
      line = line.trim();
      if (line && !line.startsWith("#")) {
        const [key, ...valueParts] = line.split("=");
        if (key && valueParts.length > 0) {
          parsedSecrets[key.trim()] = valueParts
            .join("=")
            .trim()
            .replace(/^["']|["']$/g, "");
        } else {
          console.warn(`Skipping malformed line in secrets file: ${line}`);
        }
      }
    });

    // Validate and parse secrets using Zod schema
    const validationResult = LumaSecretsSchema.safeParse(parsedSecrets);
    if (!validationResult.success) {
      console.error(`Invalid secrets in ${secretsPath}:`);
      validationResult.error.errors.forEach((err) => {
        console.error(`  Key: ${err.path.join(".")}, Message: ${err.message}`);
      });
      throw new Error(`Invalid secrets in ${secretsPath}.`);
    }
    return validationResult.data;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      console.warn(`${secretsPath} not found. Proceeding with empty secrets.`);
      return LumaSecretsSchema.parse({}); // Return validated empty secrets
    }
    if (error instanceof Error && error.message.startsWith("Invalid secrets")) {
      throw error; // Re-throw Zod validation error for secrets
    }
    console.error(`Error loading or parsing ${secretsPath}:`, error);
    throw error;
  }
}
