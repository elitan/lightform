import fs from "node:fs/promises";
import path from "path";
import yaml from "js-yaml";
import {
  LightformConfigSchema,
  LightformSecretsSchema,
  LightformConfig,
  LightformSecrets,
} from "./types";

const LIGHTFORM_DIR = ".lightform";
const CONFIG_FILE = "lightform.yml";
const SECRETS_FILE = "secrets";

export async function loadConfig(): Promise<LightformConfig> {
  try {
    const configFile = await fs.readFile(CONFIG_FILE, "utf-8");
    const rawConfig = yaml.load(configFile);

    // Validate and parse using Zod schema
    const validationResult = LightformConfigSchema.safeParse(rawConfig);
    if (!validationResult.success) {
      console.error(`Invalid configuration in ${CONFIG_FILE}:`);

      // Enhanced error messages with more helpful guidance
      validationResult.error.errors.forEach((err) => {
        const path = err.path.join(".");
        let message = err.message;

        // Enhanced error handling with self-contained actionable fixes
        if (path === "name" && message.includes("Required")) {
          console.error(`  ERROR: Missing required 'name' field`);
          console.error(`  FIX: Add this to the top of lightform.yml:`);
          console.error(`     name: my-project-name`);
        } else if (path === "name" && message.includes("String must contain at least 1")) {
          console.error(`  ERROR: Project name cannot be empty`);
          console.error(`  FIX: Set a valid project name:`);
          console.error(`     name: my-project-name`);
        } else if (path === "project_name") {
          console.error(`  ERROR: 'project_name' field is not recognized`);
          console.error(`  FIX: Change 'project_name' to 'name':`);
          console.error(`     name: your-project-name`);
        } else if (path.includes("server") && message.includes("Required")) {
          const appName = path.split('.')[1] || 'app';
          console.error(`  ERROR: Missing required 'server' field for ${appName}`);
          console.error(`  FIX: Add server IP or hostname:`);
          console.error(`     apps:`);
          console.error(`       ${appName}:`);
          console.error(`         server: 192.168.1.100    # Your server IP`);
          console.error(`         # or server: myserver.com  # Your domain`);
        } else if (path.includes("build.context") && message.includes("Required")) {
          console.error(`  ERROR: Missing 'context' in build configuration`);
          console.error(`  FIX: Add build context (directory containing Dockerfile):`);
          console.error(`     build:`);
          console.error(`       context: .                 # Current directory`);
          console.error(`       dockerfile: Dockerfile     # Optional, defaults to Dockerfile`);
        } else if (path.includes("proxy.app_port")) {
          console.error(`  ERROR: 'app_port' must be a number, not a string`);
          console.error(`  FIX: Remove quotes around the port number:`);
          console.error(`     proxy:`);
          console.error(`       app_port: 3000             # Number without quotes`);
        } else if (path.includes("app_port") && message.includes("Expected number")) {
          console.error(`  ERROR: 'app_port' must be a valid port number`);
          console.error(`  FIX: Use a port between 1-65535:`);
          console.error(`     proxy:`);
          console.error(`       app_port: 3000             # Port your app listens on`);
        } else if (path === "apps" && message.includes("Expected")) {
          console.error(`  ERROR: Invalid 'apps' section format`);
          console.error(`  FIX: Use this structure:`);
          console.error(`     apps:`);
          console.error(`       web:                       # Your app name`);
          console.error(`         build:`);
          console.error(`           context: .`);
          console.error(`         server: your-server-ip`);
          console.error(`         proxy:`);
          console.error(`           app_port: 3000`);
        } else if (path === "services" && message.includes("Expected")) {
          console.error(`  ERROR: Invalid 'services' section format`);
          console.error(`  FIX: Use this structure:`);
          console.error(`     services:`);
          console.error(`       db:                        # Your service name`);
          console.error(`         image: postgres:15`);
          console.error(`         server: your-server-ip`);
          console.error(`         environment:`);
          console.error(`           secret:`);
          console.error(`             - POSTGRES_PASSWORD`);
        } else if (path.includes("image") && message.includes("Required")) {
          const serviceName = path.split('.')[1] || 'service';
          console.error(`  ERROR: Missing required 'image' field for service '${serviceName}'`);
          console.error(`  FIX: Add a Docker image with tag:`);
          console.error(`     services:`);
          console.error(`       ${serviceName}:`);
          console.error(`         image: postgres:15       # Image name with version`);
        } else if (path.includes("environment") && message.includes("Expected")) {
          console.error(`  ERROR: Invalid environment variables format`);
          console.error(`  FIX: Use array format with KEY=VALUE:`);
          console.error(`     environment:`);
          console.error(`       plain:`);
          console.error(`         - NODE_ENV=production    # Plain text variables`);
          console.error(`         - PORT=3000`);
          console.error(`       secret:`);
          console.error(`         - DATABASE_URL           # Secret variables (stored in .lightform/secrets)`);
        } else if (path.includes("ssh.username") && message.includes("Expected string")) {
          console.error(`  ERROR: SSH username must be a string`);
          console.error(`  FIX: Set your SSH username:`);
          console.error(`     ssh:`);
          console.error(`       username: lightform        # Your SSH user`);
        } else if (path.includes("ports") && message.includes("Expected")) {
          console.error(`  ERROR: Invalid ports format`);
          console.error(`  FIX: Use array of port mappings:`);
          console.error(`     ports:`);
          console.error(`       - "3000:3000"              # host:container format`);
          console.error(`       - "80:8080"`);
        } else if (path.includes("volumes") && message.includes("Expected")) {
          console.error(`  ERROR: Invalid volumes format`);
          console.error(`  FIX: Use array of volume mappings:`);
          console.error(`     volumes:`);
          console.error(`       - "./data:/app/data"       # host:container format`);
          console.error(`       - "myvolume:/var/lib/data"`);
        } else if (path.includes("health_check.path") && message.includes("Expected string")) {
          console.error(`  ERROR: Health check path must be a string`);
          console.error(`  FIX: Set a valid health check endpoint:`);
          console.error(`     health_check:`);
          console.error(`       path: /api/health          # Your health endpoint`);
        } else {
          console.error(`  ERROR: Configuration error at: ${path}`);
          console.error(`  ISSUE: ${message}`);
          
          // Provide context-specific guidance based on path
          if (path.includes("apps.")) {
            console.error(`  FIX: Check your app configuration structure`);
          } else if (path.includes("services.")) {
            console.error(`  FIX: Check your service configuration structure`);
          } else if (path.includes("ssh.")) {
            console.error(`  FIX: Check your SSH configuration`);
          } else {
            console.error(`  FIX: Run 'lightform init' to create a valid configuration template`);
          }
        }
      });

      console.error(`\nNeed help? Run: lightform init --help`);

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

export async function loadSecrets(): Promise<LightformSecrets> {
  const secretsPath = path.join(LIGHTFORM_DIR, SECRETS_FILE);
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
    const validationResult = LightformSecretsSchema.safeParse(parsedSecrets);
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
      return LightformSecretsSchema.parse({}); // Return validated empty secrets
    }
    if (error instanceof Error && error.message.startsWith("Invalid secrets")) {
      throw error; // Re-throw Zod validation error for secrets
    }
    console.error(`Error loading or parsing ${secretsPath}:`, error);
    throw error;
  }
}
