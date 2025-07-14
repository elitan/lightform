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
      console.error(`\nInvalid configuration in ${CONFIG_FILE}:`);

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

        // Helper function to show unified error format
        const showError = (description: string, yamlFix: string[]) => {
          console.error(`\n  Configuration Error in ${path}:`);
          console.error(`    ${description}`);
          console.error(`    Fix in lightform.yml:`);
          yamlFix.forEach(line => console.error(`    ${line}`));
        };

        // Helper function to get entity info from path
        const getEntityInfo = (path: string) => {
          const parts = path.split('.');
          return {
            section: parts[0], // apps, services, ssh, etc.
            entity: parts[1],  // web, db, etc.
            field: parts.slice(-1)[0] // app_port, server, etc.
          };
        };
        
        const { section, entity, field } = getEntityInfo(path);

        if (path === "name" && code === "invalid_type") {
          showError(`Missing project name`, [
            `name: my-project`
          ]);
        } else if (path.includes("app_port") && code === "invalid_type" && expected === "number") {
          showError(`Found ${formatValue(currentValue)}, expected a number`, [
            `${section}:`,
            `  ${entity}:`,
            `    proxy:`,
            `      app_port: 3000    # Common ports: 3000, 8000, 8080`
          ]);
        } else if (path.includes("server") && code === "invalid_type") {
          showError(`Missing server for app "${entity}"`, [
            `${section}:`,
            `  ${entity}:`,
            `    server: 192.168.1.100    # Your server IP or domain`
          ]);
        } else if (path.includes("build.context") && code === "invalid_type") {
          showError(`Missing build context for app "${entity}"`, [
            `${section}:`,
            `  ${entity}:`,
            `    build:`,
            `      context: .              # Usually current directory`
          ]);
        // Pattern-based error handling with unified format
        } else if (path.includes("proxy.hosts")) {
          showError(`Found ${formatValue(currentValue)}, expected array of domains`, [
            `${section}:`, `  ${entity}:`, `    proxy:`, `      hosts:`, `        - myapp.com`, `        - www.myapp.com`
          ]);
        } else if (path.includes("environment.plain")) {
          showError(`Found ${formatValue(currentValue)}, expected array of KEY=VALUE strings`, [
            `environment:`, `  plain:`, `    - NODE_ENV=production`, `    - PORT=3000`
          ]);
        } else if (path.includes("environment.secret")) {
          showError(`Found ${formatValue(currentValue)}, expected array of variable names`, [
            `environment:`, `  secret:`, `    - DATABASE_URL           # References .lightform/secrets`, `    - API_KEY`
          ]);
        } else if (path.includes("ports")) {
          showError(`Found ${formatValue(currentValue)}, expected array of port mappings`, [
            `ports:`, `  - "3000:3000"             # "host:container" format`, `  - "80:8080"`
          ]);
        } else if (path.includes("volumes")) {
          showError(`Found ${formatValue(currentValue)}, expected array of volume mappings`, [
            `volumes:`, `  - "./data:/app/data"      # "host:container" format`, `  - "myvolume:/var/lib/data"`
          ]);
        } else if (path.includes("ssh.username")) {
          showError(`Found ${formatValue(currentValue)}, expected string`, [
            `ssh:`, `  username: lightform        # Your SSH username`
          ]);
        } else if (path.includes("ssh.port")) {
          showError(`Found ${formatValue(currentValue)}, expected number`, [
            `ssh:`, `  port: 22                   # Port number without quotes`
          ]);
        } else if (path.includes("ssh.key_file")) {
          showError(`Found ${formatValue(currentValue)}, expected string`, [
            `ssh:`, `  key_file: ~/.ssh/id_rsa   # Path to SSH private key`
          ]);
        } else if (path.includes("health_check.path")) {
          showError(`Found ${formatValue(currentValue)}, expected string`, [
            `${section}:`, `  ${entity}:`, `    health_check:`, `      path: /api/health      # Your health endpoint path`
          ]);
        } else if (path.includes("ssl")) {
          showError(`Found ${formatValue(currentValue)}, expected true or false`, [
            `${section}:`, `  ${entity}:`, `    proxy:`, `      ssl: true              # Enable HTTPS`
          ]);
        } else if (path.includes("replicas")) {
          showError(`Found ${formatValue(currentValue)}, expected positive number`, [
            `${section}:`, `  ${entity}:`, `    replicas: 1              # Number of instances`
          ]);
        } else if (path.includes("build.dockerfile")) {
          showError(`Found ${formatValue(currentValue)}, expected string`, [
            `${section}:`, `  ${entity}:`, `    build:`, `      dockerfile: Dockerfile  # Path to Dockerfile`
          ]);
        } else if (path.includes("build.args")) {
          showError(`Found ${formatValue(currentValue)}, expected array of strings`, [
            `${section}:`, `  ${entity}:`, `    build:`, `      args:`, `        - NODE_ENV            # Environment variable names`, `        - API_URL`
          ]);
        } else if (path.includes("build.target")) {
          showError(`Found ${formatValue(currentValue)}, expected string`, [
            `${section}:`, `  ${entity}:`, `    build:`, `      target: production      # Multi-stage build target`
          ]);
        } else if (path.includes("build.platform")) {
          showError(`Found ${formatValue(currentValue)}, expected string`, [
            `${section}:`, `  ${entity}:`, `    build:`, `      platform: linux/amd64  # Target platform`
          ]);
        } else if (path.includes("docker.registry")) {
          showError(`Found ${formatValue(currentValue)}, expected string`, [
            `docker:`, `  registry: registry.example.com  # Docker registry URL`
          ]);
        } else if (path.includes("docker.username")) {
          showError(`Found ${formatValue(currentValue)}, expected string`, [
            `docker:`, `  username: myuser          # Registry username`
          ]);
        } else if (path.includes("proxy.image")) {
          showError(`Found ${formatValue(currentValue)}, expected string`, [
            `proxy:`, `  image: lightform-proxy:latest  # Custom proxy image`
          ]);
        } else if (path.includes("registry.url")) {
          showError(`Found ${formatValue(currentValue)}, expected string`, [
            `${section}:`, `  ${entity}:`, `    registry:`, `      url: registry.example.com  # Registry URL`
          ]);
        } else if (path.includes("registry.username")) {
          showError(`Found ${formatValue(currentValue)}, expected string`, [
            `${section}:`, `  ${entity}:`, `    registry:`, `      username: myuser        # Registry username`
          ]);
        } else if (path.includes("registry.password_secret")) {
          showError(`Found ${formatValue(currentValue)}, expected string`, [
            `${section}:`, `  ${entity}:`, `    registry:`, `      password_secret: REGISTRY_PASSWORD  # References .lightform/secrets`
          ]);
        } else if (code === "unrecognized_keys") {
          showError(`Unknown field: ${path}`, [
            `# Remove this field - it's not supported`
          ]);
        } else if (code === "too_small" || code === "too_big") {
          showError(`Invalid value ${formatValue(currentValue)}: ${message}`, [
            `# Check the valid range for this field`
          ]);
        } else {
          // Enhanced fallback
          const description = expected && received 
            ? `Found ${formatValue(currentValue)}, expected ${expected}` 
            : `${message}`;
          showError(description, [
            `# Run 'lightform init' for a valid configuration template`
          ]);
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
