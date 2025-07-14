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
        currentValue?: any;
      }> = [];

      // Helper function to get current value at path
      function getCurrentValue(obj: any, pathArray: string[]): any {
        let current = obj;
        for (const key of pathArray) {
          if (current && typeof current === 'object' && key in current) {
            current = current[key];
          } else {
            return undefined;
          }
        }
        return current;
      }

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
                received: bestError.received,
                currentValue: getCurrentValue(rawConfig, bestError.path)
              });
            }
          } else {
            allIssues.push({
              path: issue.path.join('.'),
              code: issue.code,
              message: issue.message,
              expected: issue.expected,
              received: issue.received,
              currentValue: getCurrentValue(rawConfig, issue.path)
            });
          }
        });
      }

      collectIssues(validationResult.error.errors);

      // Display world-class error messages
      allIssues.forEach((issue) => {
        const { path, code, message, expected, received, currentValue } = issue;
        // Helper function to format current value for display
        const formatValue = (value: any): string => {
          if (value === undefined || value === null) return 'undefined';
          if (typeof value === 'string') return `"${value}"`;
          if (typeof value === 'object') return JSON.stringify(value);
          return String(value);
        };

        // World-class error messages with current values and precise fixes
        console.error(`\n  Configuration Error in ${path}:`);
        
        if (path === "name" && code === "invalid_type") {
          console.error(`    Missing project name`);
          console.error(`    Add this at the top of lightform.yml:`);
          console.error(`    name: my-project`);
        } else if (path.includes("app_port") && code === "invalid_type" && expected === "number") {
          const appPath = path.split('.').slice(0, 2).join('.');
          console.error(`    Found ${formatValue(currentValue)}, expected a number`);
          console.error(`    Fix in lightform.yml:`);
          console.error(`    ${appPath}:`);
          console.error(`      proxy:`);
          console.error(`        app_port: 3000    # Common ports: 3000, 8000, 8080`);
        } else if (path.includes("server") && code === "invalid_type") {
          const appName = path.split('.')[1];
          console.error(`    Missing server for app "${appName}"`);
          console.error(`    Add your server IP or hostname:`);
          console.error(`    apps:`);
          console.error(`      ${appName}:`);
          console.error(`        server: 192.168.1.100    # Your server IP or domain`);
        } else if (path.includes("build.context") && code === "invalid_type") {
          const appName = path.split('.')[1];
          console.error(`    Missing build context for app "${appName}"`);
          console.error(`    Specify directory containing your Dockerfile:`);
          console.error(`    apps:`);
          console.error(`      ${appName}:`);
          console.error(`        build:`);
          console.error(`          context: .              # Usually current directory`);
        } else if (path.includes("image") && code === "invalid_type") {
          const serviceName = path.split('.')[1];
          console.error(`    Missing Docker image for service "${serviceName}"`);
          console.error(`    Specify a Docker image with tag:`);
          console.error(`    services:`);
          console.error(`      ${serviceName}:`);
          console.error(`        image: postgres:15        # image:tag format`);
        } else if (path.includes("proxy.hosts") && code === "invalid_type") {
          const appName = path.split('.')[1];
          console.error(`    Found ${formatValue(currentValue)}, expected array of domains`);
          console.error(`    Fix in lightform.yml:`);
          console.error(`    apps:`);
          console.error(`      ${appName}:`);
          console.error(`        proxy:`);
          console.error(`          hosts:`);
          console.error(`            - myapp.com`);
          console.error(`            - www.myapp.com`);
        } else if (path.includes("environment.plain") && code === "invalid_type") {
          const entityName = path.split('.')[1];
          console.error(`    Found ${formatValue(currentValue)}, expected array of KEY=VALUE strings`);
          console.error(`    Fix in lightform.yml:`);
          console.error(`    environment:`);
          console.error(`      plain:`);
          console.error(`        - NODE_ENV=production`);
          console.error(`        - PORT=3000`);
        } else if (path.includes("environment.secret") && code === "invalid_type") {
          const entityName = path.split('.')[1];
          console.error(`    Found ${formatValue(currentValue)}, expected array of variable names`);
          console.error(`    Fix in lightform.yml:`);
          console.error(`    environment:`);
          console.error(`      secret:`);
          console.error(`        - DATABASE_URL           # References .lightform/secrets`);
          console.error(`        - API_KEY`);
        } else if (path.includes("ports") && code === "invalid_type") {
          const entityName = path.split('.')[1];
          console.error(`    Found ${formatValue(currentValue)}, expected array of port mappings`);
          console.error(`    Fix in lightform.yml:`);
          console.error(`    ports:`);
          console.error(`      - "3000:3000"             # "host:container" format`);
          console.error(`      - "80:8080"`);
        } else if (path.includes("volumes") && code === "invalid_type") {
          const entityName = path.split('.')[1];
          console.error(`    Found ${formatValue(currentValue)}, expected array of volume mappings`);
          console.error(`    Fix in lightform.yml:`);
          console.error(`    volumes:`);
          console.error(`      - "./data:/app/data"      # "host:container" format`);
          console.error(`      - "myvolume:/var/lib/data"`);
        } else if (path.includes("ssh.username") && code === "invalid_type") {
          console.error(`    Found ${formatValue(currentValue)}, expected string`);
          console.error(`    Fix in lightform.yml:`);
          console.error(`    ssh:`);
          console.error(`      username: lightform        # Your SSH username`);
        } else if (path.includes("ssh.port") && code === "invalid_type" && expected === "number") {
          console.error(`    Found ${formatValue(currentValue)}, expected number`);
          console.error(`    Fix in lightform.yml:`);
          console.error(`    ssh:`);
          console.error(`      port: 22                   # Port number without quotes`);
        } else if (path.includes("health_check.path") && code === "invalid_type") {
          const appName = path.split('.')[1];
          console.error(`    Found ${formatValue(currentValue)}, expected string`);
          console.error(`    Fix in lightform.yml:`);
          console.error(`    apps:`);
          console.error(`      ${appName}:`);
          console.error(`        health_check:`);
          console.error(`          path: /api/health      # Your health endpoint path`);
        } else if (path.includes("ssl") && code === "invalid_type" && expected === "boolean") {
          const appName = path.split('.')[1];
          console.error(`    Found ${formatValue(currentValue)}, expected true or false`);
          console.error(`    Fix in lightform.yml:`);
          console.error(`    apps:`);
          console.error(`      ${appName}:`);
          console.error(`        proxy:`);
          console.error(`          ssl: true              # Enable HTTPS`);
        } else if (code === "unrecognized_keys") {
          console.error(`    Unknown field: ${path}`);
          console.error(`    This field is not supported. Remove it or check documentation.`);
        } else if (code === "too_small" || code === "too_big") {
          console.error(`    Invalid value ${formatValue(currentValue)}: ${message}`);
          console.error(`    Check the valid range for this field.`);
        } else {
          // Enhanced fallback with current value
          console.error(`    Found ${formatValue(currentValue)}`);
          if (expected && received) {
            console.error(`    Expected ${expected}, but received ${received}`);
          } else {
            console.error(`    ${message}`);
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
