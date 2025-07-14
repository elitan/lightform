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

      // Collect all validation issues including nested union errors
      const allIssues: Array<{
        path: string;
        code: string;
        message: string;
        expected?: string;
        received?: string;
      }> = [];

      function collectIssues(issues: any[]) {
        issues.forEach((issue) => {
          if (issue.code === 'invalid_union' && issue.unionErrors) {
            // For union errors, find the most specific error (longest path) to avoid generic messages
            let bestError: any = null;
            let maxPathLength = 0;
            
            issue.unionErrors.forEach((unionError: any) => {
              if (unionError.issues) {
                unionError.issues.forEach((subIssue: any) => {
                  const pathLength = subIssue.path?.length || 0;
                  if (pathLength > maxPathLength) {
                    maxPathLength = pathLength;
                    bestError = subIssue;
                  }
                });
              }
            });
            
            // Only add the most specific error, ignore generic union failures
            if (bestError && maxPathLength > 0) {
              allIssues.push({
                path: bestError.path.join('.'),
                code: bestError.code,
                message: bestError.message,
                expected: bestError.expected,
                received: bestError.received
              });
            }
          } else {
            allIssues.push({
              path: issue.path.join('.'),
              code: issue.code,
              message: issue.message,
              expected: issue.expected,
              received: issue.received
            });
          }
        });
      }

      collectIssues(validationResult.error.errors);

      // Display world-class error messages
      allIssues.forEach((issue) => {
        const { path, code, message, expected, received } = issue;
        // World-class error messages with precise identification and actionable fixes
        console.error(`\n  Configuration Error:`);
        
        if (path === "name" && code === "invalid_type") {
          console.error(`    Missing project name`);
          console.error(`    Add this at the top of lightform.yml:`);
          console.error(`    name: my-project`);
        } else if (path.includes("app_port") && code === "invalid_type" && expected === "number") {
          const appPath = path.split('.').slice(0, 2).join('.');
          console.error(`    Invalid app_port: must be a number`);
          console.error(`    Change this in lightform.yml:`);
          console.error(`    ${appPath}:`);
          console.error(`      proxy:`);
          console.error(`        app_port: 3000    # Common ports: 3000, 8000, 8080`);
        } else if (path.includes("server") && code === "invalid_type") {
          const appName = path.split('.')[1];
          console.error(`    Missing server for app "${appName}"`);
          console.error(`    Add your server IP or hostname:`);
          console.error(`    apps:`);
          console.error(`      ${appName}:`);
          console.error(`        server: 192.168.1.100    # Your server IP`);
        } else if (path.includes("build.context") && code === "invalid_type") {
          const appName = path.split('.')[1];
          console.error(`    Missing build context for app "${appName}"`);
          console.error(`    Specify where your Dockerfile is located:`);
          console.error(`    apps:`);
          console.error(`      ${appName}:`);
          console.error(`        build:`);
          console.error(`          context: .              # Current directory`);
        } else if (path.includes("image") && code === "invalid_type") {
          const serviceName = path.split('.')[1];
          console.error(`    Missing Docker image for service "${serviceName}"`);
          console.error(`    Specify a Docker image with tag:`);
          console.error(`    services:`);
          console.error(`      ${serviceName}:`);
          console.error(`        image: postgres:15        # Image name:tag`);
        } else if (path.includes("proxy.hosts") && code === "invalid_type") {
          const appName = path.split('.')[1];
          console.error(`    Invalid hosts configuration for app "${appName}"`);
          console.error(`    Use an array of domain names:`);
          console.error(`    apps:`);
          console.error(`      ${appName}:`);
          console.error(`        proxy:`);
          console.error(`          hosts:`);
          console.error(`            - myapp.com`);
          console.error(`            - www.myapp.com`);
        } else if (path.includes("environment.plain") && code === "invalid_type") {
          const entityName = path.split('.')[1];
          console.error(`    Invalid environment variables format for "${entityName}"`);
          console.error(`    Use array format with KEY=VALUE:`);
          console.error(`    environment:`);
          console.error(`      plain:`);
          console.error(`        - NODE_ENV=production`);
          console.error(`        - PORT=3000`);
        } else if (path.includes("environment.secret") && code === "invalid_type") {
          const entityName = path.split('.')[1];
          console.error(`    Invalid secret environment variables for "${entityName}"`);
          console.error(`    Use array format with variable names:`);
          console.error(`    environment:`);
          console.error(`      secret:`);
          console.error(`        - DATABASE_URL           # References .lightform/secrets`);
          console.error(`        - API_KEY`);
        } else if (path.includes("ports") && code === "invalid_type") {
          const entityName = path.split('.')[1];
          console.error(`    Invalid ports configuration for "${entityName}"`);
          console.error(`    Use array of "host:container" port mappings:`);
          console.error(`    ports:`);
          console.error(`      - "3000:3000"`);
          console.error(`      - "80:8080"`);
        } else if (path.includes("volumes") && code === "invalid_type") {
          const entityName = path.split('.')[1];
          console.error(`    Invalid volumes configuration for "${entityName}"`);
          console.error(`    Use array of "host:container" volume mappings:`);
          console.error(`    volumes:`);
          console.error(`      - "./data:/app/data"`);
          console.error(`      - "myvolume:/var/lib/data"`);
        } else if (path.includes("ssh.username") && code === "invalid_type") {
          console.error(`    Invalid SSH username type`);
          console.error(`    Must be a string:`);
          console.error(`    ssh:`);
          console.error(`      username: lightform         # Your SSH user`);
        } else if (path.includes("ssh.port") && code === "invalid_type" && expected === "number") {
          console.error(`    Invalid SSH port: must be a number`);
          console.error(`    Change this in lightform.yml:`);
          console.error(`    ssh:`);
          console.error(`      port: 22                    # Standard SSH port`);
        } else if (path.includes("health_check.path") && code === "invalid_type") {
          const appName = path.split('.')[1];
          console.error(`    Invalid health check path for app "${appName}"`);
          console.error(`    Must be a string:`);
          console.error(`    apps:`);
          console.error(`      ${appName}:`);
          console.error(`        health_check:`);
          console.error(`          path: /api/health       # Your health endpoint`);
        } else if (code === "unrecognized_keys") {
          console.error(`    Unknown configuration field: ${path}`);
          console.error(`    This field is not supported. Check the documentation for valid options.`);
        } else {
          // Fallback for any unhandled cases
          console.error(`    ${message} at: ${path}`);
          if (expected && received) {
            console.error(`    Expected: ${expected}, received: ${received}`);
          }
          console.error(`    Run 'lightform init' for a valid configuration template`);
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
