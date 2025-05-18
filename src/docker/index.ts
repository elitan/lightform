// Docker CLI wrapper logic will go here

import { SSHClient } from "../ssh";
import {
  ServiceEntry,
  AppEntry,
  LumaSecrets,
  LumaConfig,
} from "../config/types";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface DockerNetworkOptions {
  name: string;
}

export interface DockerContainerOptions {
  name: string;
  image: string;
  network?: string;
  ports?: string[];
  volumes?: string[];
  envVars?: Record<string, string>;
  restart?: string;
}

export interface DockerBuildOptions {
  context: string;
  dockerfile?: string;
  tags?: string[];
  buildArgs?: Record<string, string>;
  target?: string;
  platform?: string;
}

export class DockerClient {
  private sshClient?: SSHClient;
  private serverHostname?: string;

  constructor(sshClient?: SSHClient, serverHostname?: string) {
    this.sshClient = sshClient;
    this.serverHostname = serverHostname;
  }

  /**
   * Log a message with server hostname prefix or general log if no server context
   */
  private log(message: string): void {
    if (this.serverHostname) {
      console.log(`[${this.serverHostname}] ${message}`);
    } else {
      console.log(message);
    }
  }

  /**
   * Log an error with server hostname prefix or general error if no server context
   */
  private logError(message: string): void {
    if (this.serverHostname) {
      console.error(`[${this.serverHostname}] ${message}`);
    } else {
      console.error(message);
    }
  }

  /**
   * Execute a Docker command via SSH if sshClient is available
   */
  private async execRemote(command: string): Promise<string> {
    if (!this.sshClient) {
      throw new Error(
        "SSH client is not initialized for remote Docker command."
      );
    }
    try {
      return await this.sshClient.exec(`docker ${command}`);
    } catch (error) {
      // Check if this is a "non-error" Docker message (like image pull progress)
      const errorMessage = String(error);

      // Docker outputs image pull information to stderr, but it's not actually an error
      if (
        errorMessage.includes("Status: Downloaded newer image for") ||
        errorMessage.includes("Status: Image is up to date")
      ) {
        this.log(
          `Docker image pull completed successfully (from stderr): ${errorMessage}`
        );
        // Return a successful response
        return "success";
      }

      this.logError(`Remote Docker command failed: ${error}`);
      throw error;
    }
  }

  /**
   * Execute a command locally
   */
  private static async _runLocalCommand(
    command: string
  ): Promise<{ stdout: string; stderr: string }> {
    console.log(`Executing local command: ${command}`);
    try {
      const { stdout, stderr } = await execAsync(command);
      if (stderr) {
        // Docker often prints non-error info to stderr, so log it but don't always throw
        console.warn(`Local command stderr: ${stderr}`);
      }
      return { stdout, stderr };
    } catch (error) {
      console.error(`Local command failed: ${command}`, error);
      throw error;
    }
  }

  // --- Static methods for Local Docker Operations ---

  static async build(options: DockerBuildOptions): Promise<void> {
    let buildCommand = "docker build";
    if (options.dockerfile) {
      buildCommand += ` -f \"${options.dockerfile}\"`;
    }
    if (options.tags && options.tags.length > 0) {
      options.tags.forEach((tag) => {
        buildCommand += ` -t \"${tag}\"`;
      });
    }
    if (options.buildArgs) {
      Object.entries(options.buildArgs).forEach(([key, value]) => {
        buildCommand += ` --build-arg \"${key}=${value}\"`;
      });
    }
    if (options.target) {
      buildCommand += ` --target \"${options.target}\"`;
    }
    if (options.platform) {
      buildCommand += ` --platform \"${options.platform}\"`;
    }
    buildCommand += ` \"${options.context}\"`;

    console.log(`Attempting to build image with command: ${buildCommand}`);
    await DockerClient._runLocalCommand(buildCommand);
    console.log("Docker build process completed.");
  }

  static async tag(sourceImage: string, targetImage: string): Promise<void> {
    const command = `docker tag \"${sourceImage}\" \"${targetImage}\"`;
    console.log(`Attempting to tag image: ${command}`);
    await DockerClient._runLocalCommand(command);
    console.log(
      `Successfully tagged \"${sourceImage}\" as \"${targetImage}\".`
    );
  }

  static async push(imageName: string, registry?: string): Promise<void> {
    // If a specific registry (not Docker Hub) is provided, the imageName should already include it for push.
    // However, Docker CLI push can take the full image name including registry.
    // Example: my.registry.com/namespace/image:tag
    // If registry param is just hostname, it assumes official library image if no user/org part.
    // For simplicity, ensure imageName is the full path if not Docker Hub.
    const command = `docker push \"${imageName}\"`;
    console.log(`Attempting to push image: ${command}`);
    await DockerClient._runLocalCommand(command);
    console.log(
      `Successfully pushed \"${imageName}\"${
        registry ? " to " + registry : ""
      }.`
    );
  }

  // --- Instance methods for Remote Docker Operations (via SSH) ---

  /**
   * Check if Docker is installed and working on remote server
   */
  async checkInstallation(): Promise<boolean> {
    try {
      await this.execRemote("info");
      this.log("Docker is installed and accessible.");
      return true;
    } catch (error) {
      this.logError(`Docker not found or 'docker info' failed: ${error}`);
      return false;
    }
  }

  /**
   * Install Docker if not already installed on remote server
   */
  async install(): Promise<boolean> {
    if (!this.sshClient)
      throw new Error("SSH client required for remote install.");
    this.log("Installing Docker, curl, and git...");
    try {
      this.log("Running apt update...");
      await this.sshClient.exec("sudo apt update");

      this.log("Running apt upgrade...");
      await this.sshClient.exec("sudo apt upgrade -y");

      this.log("Installing docker.io, curl, git...");
      await this.sshClient.exec("sudo apt install -y docker.io curl git");

      this.log("Adding user to docker group...");
      // Get current SSH username
      const currentUser = await this.sshClient.exec("whoami");
      await this.sshClient.exec(
        `sudo usermod -a -G docker ${currentUser.trim()}`
      );

      this.log("Successfully installed required packages.");
      return true;
    } catch (error) {
      this.logError(`Failed to install Docker and dependencies: ${error}`);
      return false;
    }
  }

  /**
   * Login to Docker registry
   */
  async login(
    registry: string,
    username: string,
    password: string
  ): Promise<boolean> {
    this.log(`Logging into Docker registry: ${registry}...`);
    try {
      if (!this.sshClient) {
        this.logError("SSH client not available for Docker login operation.");
        return false;
      }

      // Create a temporary file with the password on the remote server
      const tempFile = `/tmp/docker_login_${Date.now()}.tmp`;

      // Write password to temporary file without echoing it
      await this.sshClient.exec(`cat > ${tempFile} << 'EOF'
${password}
EOF`);

      // Set restrictive permissions
      await this.sshClient.exec(`chmod 600 ${tempFile}`);

      // Login using the file and immediately remove it
      try {
        await this.sshClient.exec(
          `cat ${tempFile} | docker login ${registry} -u "${username}" --password-stdin && rm -f ${tempFile}`
        );
        this.log(`Successfully logged into Docker registry: ${registry}.`);
        return true;
      } catch (loginError) {
        // Delete the temp file even if login fails
        await this.sshClient.exec(`rm -f ${tempFile}`);

        // Handle the common warning about unencrypted storage
        const errorMessage = String(loginError);
        if (
          errorMessage.includes(
            "WARNING! Your password will be stored unencrypted"
          )
        ) {
          this.log(
            `Login successful to ${registry} (with warning about unencrypted storage).`
          );
          return true;
        }

        // Don't include the error message which might contain sensitive info
        throw new Error("Docker login failed (see server logs for details)");
      }
    } catch (error) {
      const errorStr = String(error);
      // Sanitize any error message to prevent password disclosure
      if (errorStr.includes(password)) {
        this.logError(
          `Failed to log into Docker registry ${registry}: [Password redacted from logs]`
        );
      } else {
        this.logError(
          `Failed to log into Docker registry ${registry}: ${error}`
        );
      }
      return false;
    }
  }

  /**
   * Logout from Docker registry
   */
  async logout(registry: string): Promise<boolean> {
    this.log(`Logging out from Docker registry: ${registry}...`);
    try {
      await this.execRemote(`logout ${registry}`);
      this.log(`Successfully logged out from Docker registry: ${registry}.`);
      return true;
    } catch (error) {
      this.logError(
        `Failed to log out from Docker registry ${registry}: ${error}`
      );
      return false;
    }
  }

  /**
   * Pull a Docker image
   */
  async pullImage(image: string): Promise<boolean> {
    this.log(`Pulling image ${image}...`);
    try {
      await this.execRemote(`pull ${image}`);
      this.log(`Successfully pulled image ${image}.`);
      return true;
    } catch (error) {
      this.logError(`Failed to pull image ${image}: ${error}`);
      return false;
    }
  }

  /**
   * Check if a network exists
   */
  async networkExists(name: string): Promise<boolean> {
    try {
      const result = await this.execRemote(
        `network ls --filter name=${name} --format "{{.Name}}"`
      );
      return result.trim() === name;
    } catch {
      return false;
    }
  }

  /**
   * Create a Docker network
   */
  async createNetwork(options: DockerNetworkOptions): Promise<boolean> {
    try {
      const exists = await this.networkExists(options.name);

      if (exists) {
        this.log(`Docker network ${options.name} already exists.`);
        return true;
      }

      await this.execRemote(`network create ${options.name}`);
      this.log(`Created Docker network: ${options.name}`);
      return true;
    } catch (error) {
      this.logError(`Failed to create Docker network: ${error}`);
      return false;
    }
  }

  /**
   * Check if a container exists
   */
  async containerExists(name: string): Promise<boolean> {
    try {
      const result = await this.execRemote(
        `ps -a --filter "name=${name}" --format "{{.Names}}"`
      );
      return result.trim() === name;
    } catch {
      return false;
    }
  }

  /**
   * Check if a container is running
   */
  async containerIsRunning(name: string): Promise<boolean> {
    try {
      const result = await this.execRemote(
        `ps --filter "name=${name}" --format "{{.Names}}"`
      );
      return result.trim() === name;
    } catch {
      return false;
    }
  }

  /**
   * Start an existing container
   */
  async startContainer(name: string): Promise<boolean> {
    try {
      await this.execRemote(`start ${name}`);
      this.log(`Started container ${name}.`);
      return true;
    } catch (error) {
      this.logError(`Failed to start container ${name}: ${error}`);
      return false;
    }
  }

  /**
   * Stop a container
   */
  async stopContainer(name: string): Promise<boolean> {
    try {
      await this.execRemote(`stop ${name}`);
      this.log(`Stopped container ${name}.`);
      return true;
    } catch (error) {
      this.logError(`Failed to stop container ${name}: ${error}`);
      return false;
    }
  }

  /**
   * Remove a container
   */
  async removeContainer(name: string): Promise<boolean> {
    try {
      await this.execRemote(`rm ${name}`);
      this.log(`Removed container ${name}.`);
      return true;
    } catch (error) {
      this.logError(`Failed to remove container ${name}: ${error}`);
      return false;
    }
  }

  /**
   * Create and run a new container
   */
  async createContainer(options: DockerContainerOptions): Promise<boolean> {
    try {
      // Build the docker run command
      let cmd = `run -d --name ${options.name}`;

      // Add network if specified
      if (options.network) {
        cmd += ` --network ${options.network}`;
      }

      // Add restart policy
      if (options.restart) {
        cmd += ` --restart ${options.restart}`;
      } else {
        cmd += ` --restart unless-stopped`;
      }

      // Add ports
      if (options.ports && options.ports.length > 0) {
        options.ports.forEach((port) => {
          cmd += ` -p ${port}`;
        });
      }

      // Add volumes
      if (options.volumes && options.volumes.length > 0) {
        options.volumes.forEach((volume) => {
          cmd += ` -v ${volume}`;
        });
      }

      // Add environment variables
      if (options.envVars) {
        Object.entries(options.envVars).forEach(([key, value]) => {
          // Escape special characters in value
          const escapedValue = value.replace(/[\$"`\\]/g, "\\$&");
          cmd += ` -e ${key}="${escapedValue}"`;
        });
      }

      // Add the image
      cmd += ` ${options.image}`;

      // Execute the command
      await this.execRemote(cmd);
      this.log(`Created and started container ${options.name}.`);
      return true;
    } catch (error) {
      this.logError(`Failed to create container ${options.name}: ${error}`);
      return false;
    }
  }

  /**
   * Ensure a container is running - creates it if it doesn't exist, starts it if stopped
   */
  async ensureContainer(options: DockerContainerOptions): Promise<boolean> {
    const exists = await this.containerExists(options.name);

    if (exists) {
      const running = await this.containerIsRunning(options.name);

      if (running) {
        this.log(`Container ${options.name} is already running.`);
        return true;
      } else {
        return await this.startContainer(options.name);
      }
    } else {
      return await this.createContainer(options);
    }
  }

  /**
   * Get the health status of a container.
   * Returns 'healthy', 'unhealthy', 'starting', or null if health status is not available.
   */
  async getContainerHealth(containerName: string): Promise<string | null> {
    this.log(`Checking health of container ${containerName}...`);
    try {
      // Verify the container exists before trying to inspect it
      const containerExists = await this.containerExists(containerName);
      if (!containerExists) {
        this.logError(
          `Container ${containerName} does not exist. Cannot perform health check.`
        );
        return null;
      }

      // The --format '{{json .State.Health}}' will output the Health object as a JSON string or an empty string if no health check.
      // If there's no Health object (e.g. container doesn't have a health check configured), it might return GO template error or empty.
      // A more robust way is to get the full state and check for the Health property.
      const inspectOutput = await this.execRemote(`inspect ${containerName}`);
      const inspectJson = JSON.parse(inspectOutput);
      if (
        inspectJson &&
        inspectJson.length > 0 &&
        inspectJson[0].State &&
        inspectJson[0].State.Health
      ) {
        const healthStatus = inspectJson[0].State.Health.Status;
        this.log(`Container ${containerName} health status: ${healthStatus}`);
        return healthStatus; // e.g., "healthy", "unhealthy", "starting"
      }
      this.log(
        `Container ${containerName} does not have health check information.`
      );
      return null; // No health check configured or found
    } catch (error) {
      this.logError(
        `Failed to get health status for container ${containerName}: ${error}`
      );
      // If container doesn't exist, inspect will fail. This should be handled as an error or a specific status.
      // For now, assume an error means we can't determine health.
      return "unhealthy"; // Treat errors in fetching health as unhealthy for safety
    }
  }

  /**
   * Find all containers (running or stopped) whose names match a prefix
   * @param namePrefix The container name prefix to match
   * @returns Array of container names
   */
  async findContainersByPrefix(namePrefix: string): Promise<string[]> {
    try {
      const result = await this.execRemote(
        `ps -a --filter "name=${namePrefix}" --format "{{.Names}}"`
      );
      if (!result.trim()) {
        return [];
      }
      return result.trim().split("\n");
    } catch (error) {
      this.logError(
        `Failed to find containers by prefix ${namePrefix}: ${error}`
      );
      return [];
    }
  }

  /**
   * Check container's health by making an HTTP request to an endpoint using a temporary helper container
   * @param containerName The name of the container to check
   * @param reuseHelper Whether to create the helper container but return a container name for reuse
   * @returns true if the /up endpoint returns 200, false otherwise. When reuseHelper is true, returns [boolean, string] with container name
   */
  async checkContainerEndpoint(
    containerName: string,
    reuseHelper: boolean = false
  ): Promise<boolean | [boolean, string]> {
    // Generate a unique name for the helper container
    const helperName = `healthcheck-${containerName}-${Date.now()}`;

    try {
      // Verify the container exists before trying to inspect it
      const containerExists = await this.containerExists(containerName);
      if (!containerExists) {
        this.logError(
          `Container ${containerName} does not exist. Cannot perform health check.`
        );
        return reuseHelper ? [false, ""] : false;
      }

      // Give the container a moment to initialize its network settings
      this.log(
        `Waiting for container ${containerName} to initialize network settings...`
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Get the network of the target container - use a simpler inspect format to avoid template errors
      const networkInfo = await this.execRemote(
        `inspect -f "{{json .NetworkSettings.Networks}}" ${containerName}`
      );

      // Parse the JSON to extract the first network name
      let network = "";
      try {
        const networkJson = JSON.parse(networkInfo.trim());
        // Get the first network name (object key)
        network = Object.keys(networkJson)[0] || "";

        if (network) {
          this.log(
            `Detected network for container ${containerName}: ${network}`
          );
        } else {
          // If we can't get a network, try default bridge network
          this.log(
            `No specific network detected for ${containerName}, using 'bridge' as default`
          );
          network = "bridge";
        }
      } catch (parseError) {
        this.logError(
          `Cannot parse network info for container ${containerName}: ${parseError}. Using default 'bridge' network.`
        );
        // Default to bridge network if we can't determine the actual network
        network = "bridge";
      }

      this.log(`Using network ${network} for health check of ${containerName}`);

      // Create and start the helper container
      if (reuseHelper) {
        try {
          // First ensure Alpine image is available
          const alpineAvailable = await this.ensureAlpineImage();
          if (!alpineAvailable) {
            this.logError(
              "Cannot proceed with health check: Alpine image is not available"
            );
            return [false, ""];
          }

          // Create a container that keeps running so we can exec into it
          const helperStartCmd = `run -d --name ${helperName} --network ${network} alpine:latest sh -c "apk add --no-cache curl && sleep 3600"`;

          this.log(
            `Starting reusable helper container ${helperName} to check health of ${containerName}`
          );
          await this.execRemote(helperStartCmd);

          // Verify the container was created and is running - retry a few times if needed
          let helperExists = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            this.log(
              `Verifying helper container exists (attempt ${attempt + 1}/3)...`
            );
            helperExists = await this.containerExists(helperName);
            if (helperExists) {
              break;
            }
            // Short wait before retry
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }

          if (!helperExists) {
            this.logError(`Failed to create helper container ${helperName}`);
            return [false, ""];
          }

          this.log(
            `Helper container ${helperName} created successfully. Waiting for curl installation...`
          );

          // Wait for curl installation to complete
          await new Promise((resolve) => setTimeout(resolve, 5000));

          // Create a shell script that loops for 60 seconds, checking the endpoint every second
          this.log(`Running health check loop in container ${helperName}...`);
          const healthCheckScript = `
            #!/bin/sh
            echo "Starting health check loop for ${containerName}:80/up"
            START_TIME=$(date +%s)
            END_TIME=$((START_TIME + 60))
            
            while [ $(date +%s) -lt $END_TIME ]; do
              echo "Checking endpoint ($(date))"
              STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 --max-time 3 http://${containerName}:80/up || echo "failed")
              echo "Response: $STATUS"
              
              if [ "$STATUS" = "200" ]; then
                echo "Success! Endpoint returned 200"
                exit 0
              fi
              
              sleep 1
            done
            
            echo "Timeout after 60 seconds. Health check failed."
            exit 1
          `;

          // Execute the health check script and capture the exit code
          this.log(`Executing health check script in ${helperName}...`);
          try {
            await this
              .execRemote(`exec ${helperName} sh -c 'cat > /tmp/healthcheck.sh << "EOL"
${healthCheckScript}
EOL
chmod +x /tmp/healthcheck.sh
/tmp/healthcheck.sh'`);

            // If we get here, the script exited with code 0 (success)
            this.log(`Health check script succeeded for ${containerName}`);
            return [true, helperName];
          } catch (error) {
            // Script exited with non-zero (failure)
            this.logError(
              `Health check script failed for ${containerName}: ${error}`
            );
            return [false, helperName];
          }
        } catch (error) {
          this.logError(`Error setting up helper container: ${error}`);
          return [false, ""];
        }
      } else {
        // Original implementation - run a one-time check

        // First ensure Alpine image is available
        const alpineAvailable = await this.ensureAlpineImage();
        if (!alpineAvailable) {
          this.logError(
            "Cannot proceed with health check: Alpine image is not available"
          );
          return false;
        }

        const helperCmd = `run --rm --name ${helperName} --network ${network} alpine:latest /bin/sh -c "apk add --no-cache curl && curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 5 http://${containerName}:80/up || echo 'failed'"`;

        this.log(
          `Starting helper container to check health of ${containerName}`
        );
        const statusCode = await this.execRemote(helperCmd);

        // Check the status code
        const cleanStatusCode = statusCode.trim();
        this.log(
          `Health check for ${containerName} returned status: ${cleanStatusCode}`
        );

        return cleanStatusCode === "200";
      }
    } catch (error) {
      this.logError(`Health check failed for ${containerName}: ${error}`);

      // Try to clean up the helper container if it's still running
      try {
        const helperExists = await this.containerExists(helperName);
        if (helperExists) {
          await this.removeContainer(helperName);
        }
      } catch (cleanupError) {
        this.logError(`Failed to clean up helper container: ${cleanupError}`);
      }

      return reuseHelper ? [false, ""] : false;
    }
  }

  /**
   * Run a health check using an existing helper container
   * @param helperName Name of the helper container to use
   * @param targetContainer Name of the container to check
   * @returns true if the /up endpoint returns 200, false otherwise
   */
  async checkHealthWithExistingHelper(
    helperName: string,
    targetContainer: string
  ): Promise<boolean> {
    try {
      if (!helperName) {
        this.logError(
          `Invalid helper container name (${helperName}) provided for health check`
        );
        return false;
      }

      const helperExists = await this.containerExists(helperName);
      if (!helperExists) {
        this.logError(`Helper container ${helperName} does not exist`);
        return false;
      }

      this.log(
        `Using helper container ${helperName} for health check of ${targetContainer}`
      );

      // Retry the curl command if it fails
      let statusCode = "";
      let success = false;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const execCmd = `exec ${helperName} curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 5 http://${targetContainer}:80/up || echo 'failed'`;
          statusCode = await this.execRemote(execCmd);
          success = true;
          break;
        } catch (execError) {
          this.logError(
            `Health check attempt ${attempt + 1}/2 failed: ${execError}`
          );
          if (attempt < 1) {
            // Brief pause before retry
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }

      if (!success) {
        this.logError(
          `All health check attempts with helper ${helperName} failed`
        );
        return false;
      }

      // Check the status code
      const cleanStatusCode = statusCode.trim();
      this.log(
        `Health check for ${targetContainer} returned status: ${cleanStatusCode} (using helper ${helperName})`
      );

      return cleanStatusCode === "200";
    } catch (error) {
      this.logError(`Health check failed for ${targetContainer}: ${error}`);
      return false;
    }
  }

  /**
   * Clean up a helper container
   * @param helperName Name of the helper container to remove
   */
  async cleanupHelperContainer(helperName: string): Promise<boolean> {
    try {
      const exists = await this.containerExists(helperName);
      if (exists) {
        await this.stopContainer(helperName);
        await this.removeContainer(helperName);
        this.log(`Successfully removed helper container ${helperName}`);
        return true;
      }
      return false;
    } catch (error) {
      this.logError(
        `Failed to clean up helper container ${helperName}: ${error}`
      );
      return false;
    }
  }

  /**
   * Prune unused Docker resources (containers, networks, images, build cache) on the remote server.
   */
  async prune(): Promise<boolean> {
    this.log("Pruning Docker resources (system prune -af)...");
    try {
      await this.execRemote("system prune -af");
      this.log("Successfully pruned Docker resources.");
      return true;
    } catch (error) {
      this.logError(`Failed to prune Docker resources: ${error}`);
      return false;
    }
  }

  /**
   * Convert a Luma service definition to Docker container options
   */
  static serviceToContainerOptions(
    service: ServiceEntry,
    projectName: string,
    secrets: LumaSecrets
  ): DockerContainerOptions {
    const containerName = `luma-${projectName}-${service.name}`;
    const options: DockerContainerOptions = {
      name: containerName,
      image: service.image,
      network: `${projectName}-network`,
      ports: service.ports,
      volumes: service.volumes,
      envVars: {},
    };

    // Add environment variables
    if (service.environment?.plain) {
      for (const [key, value] of Object.entries(service.environment.plain)) {
        if (key && value !== undefined) {
          options.envVars![key] = value;
        }
      }
    }

    // Secret environment variables
    if (service.environment?.secret) {
      service.environment.secret.forEach((secretName: string) => {
        const secretValue = secrets[secretName];
        if (secretValue) {
          options.envVars![secretName] = secretValue;
        }
      });
    }

    return options;
  }

  /**
   * Ensure Alpine image is available on the remote server
   * @returns true if Alpine image is available or was successfully pulled
   */
  async ensureAlpineImage(): Promise<boolean> {
    try {
      this.log("Checking if Alpine image is available...");

      // Check if the alpine image already exists
      try {
        await this.execRemote("images alpine:latest --quiet");
        this.log("Alpine image is already available");
        return true;
      } catch (error) {
        // Image doesn't exist or another error occurred
        this.log("Alpine image not found, pulling it...");
      }

      // Pull the alpine image explicitly
      try {
        await this.execRemote("pull alpine:latest");
        this.log("Successfully pulled Alpine image");
        return true;
      } catch (pullError) {
        this.logError(`Failed to pull Alpine image: ${pullError}`);
        return false;
      }
    } catch (error) {
      this.logError(`Error checking/pulling Alpine image: ${error}`);
      return false;
    }
  }
}
