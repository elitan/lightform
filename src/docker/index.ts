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
import { getProjectNetworkName } from "../utils";

const execAsync = promisify(exec);

export interface DockerNetworkOptions {
  name: string;
}

export interface DockerContainerOptions {
  name: string;
  image: string;
  network?: string;
  networkAlias?: string;
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
   * Log a warning with server hostname prefix or general warning if no server context
   */
  private logWarn(message: string): void {
    if (this.serverHostname) {
      console.warn(`[${this.serverHostname}] ${message}`);
    } else {
      console.warn(message);
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
          // Still treat as success but don't mention the warning in user-facing logs
          this.log(`Successfully logged into Docker registry: ${registry}.`);
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
   * Force pull a Docker image, ensuring we get the latest version from the registry
   * This removes the image first if it exists locally, then pulls it again
   */
  async forcePullImage(image: string): Promise<boolean> {
    this.log(`Force pulling latest image ${image}...`);
    try {
      // First try to remove the image (ignoring errors if it doesn't exist)
      try {
        await this.execRemote(`rmi ${image}`);
        this.log(
          `Removed existing image ${image} to ensure we get the latest version.`
        );
      } catch (rmError) {
        // Ignore errors - the image might not exist locally or might be in use
        this.log(
          `Could not remove existing image ${image}, will try pulling anyway.`
        );
      }

      // Now pull the image
      await this.execRemote(`pull ${image}`);
      this.log(`Successfully pulled latest image ${image}.`);
      return true;
    } catch (error) {
      this.logError(`Failed to force pull image ${image}: ${error}`);
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
      // Ensure network name is project specific if generated via new utility elsewhere
      this.log(`Creating Docker network: ${options.name}`);
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

        // Add network alias if specified
        if (options.networkAlias) {
          cmd += ` --network-alias ${options.networkAlias}`;
        }
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
   * Find an existing health check helper container or create a new one
   * @returns [success, helperName]
   */
  async findOrCreateHealthCheckHelper(
    network: string
  ): Promise<[boolean, string]> {
    try {
      // Look for existing helper containers
      const result = await this.execRemote(
        `ps --filter "name=luma-hc-helper" --format "{{.Names}}"`
      );

      if (result.trim()) {
        // Found at least one helper container
        const helpers = result.trim().split("\n");
        this.log(`Found existing health check helper container: ${helpers[0]}`);
        return [true, helpers[0]];
      }

      // No existing helper found, create a new one
      const helperName = `luma-hc-helper-${Date.now()}`;

      // Ensure Alpine image is available
      const alpineAvailable = await this.ensureAlpineImage();
      if (!alpineAvailable) {
        this.logError(
          "Cannot proceed with health check: Alpine image is not available"
        );
        return [false, ""];
      }

      // Create a container that keeps running so we can exec into it
      const helperStartCmd = `run -d --name ${helperName} --network ${network} alpine:latest sh -c "apk add --no-cache curl && sleep 36000"`; // 10 hour timeout

      this.log(`Starting new helper container ${helperName}`);
      await this.execRemote(helperStartCmd);

      // Verify the container was created and is running
      let helperExists = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        helperExists = await this.containerExists(helperName);
        if (helperExists) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (!helperExists) {
        this.logError(`Failed to create helper container ${helperName}`);
        return [false, ""];
      }

      this.log(
        `Helper container ${helperName} created successfully. Waiting for curl installation...`
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));

      return [true, helperName];
    } catch (error) {
      this.logError(`Error finding or creating helper container: ${error}`);
      return [false, ""];
    }
  }

  /**
   * Check container's health by making an HTTP request to an endpoint using the luma-proxy container
   * @param containerName The name of the container to check
   * @param reuseHelper Whether to create the helper container but return a container name for reuse (legacy parameter, always uses luma-proxy now)
   * @param projectName The project name for network verification
   * @param appPort The port the app is listening on (default: 80)
   * @returns true if the /up endpoint returns 200, false otherwise. When reuseHelper is true, returns [boolean, string] with container name
   */
  async checkContainerEndpoint(
    containerName: string,
    reuseHelper: boolean = false,
    projectName?: string,
    appPort: number = 80
  ): Promise<boolean | [boolean, string]> {
    if (!projectName) {
      this.logError(
        "Project name is required for checkContainerEndpoint to ensure correct network communication."
      );
      return reuseHelper ? [false, ""] : false;
    }

    this.log(
      `Performing endpoint health check for ${containerName} (project: ${projectName}, using luma-proxy, port: ${appPort})`
    );

    const targetNetworkName = await this.getContainerNetworkName(
      containerName,
      projectName
    );

    if (!targetNetworkName) {
      this.logError(
        `Container ${containerName} is not on the expected project network. Aborting health check.`
      );
      return reuseHelper ? [false, ""] : false;
    }

    const targetIP = await this.getContainerIPAddress(
      containerName,
      targetNetworkName
    );

    if (!targetIP) {
      this.logError(
        `Failed to get IP address for ${containerName} on network ${targetNetworkName}. Aborting health check.`
      );
      return reuseHelper ? [false, ""] : false;
    }

    // Use the luma-proxy container for health checks
    const proxyContainerName = "luma-proxy";

    // Verify luma-proxy container exists and is running
    const proxyExists = await this.containerExists(proxyContainerName);
    if (!proxyExists) {
      this.logError(
        `luma-proxy container not found. Cannot perform health check.`
      );
      return reuseHelper ? [false, ""] : false;
    }

    const proxyRunning = await this.containerIsRunning(proxyContainerName);
    if (!proxyRunning) {
      this.logError(
        `luma-proxy container is not running. Cannot perform health check.`
      );
      return reuseHelper ? [false, ""] : false;
    }

    const isHealthy = await this.checkHealthWithLumaProxy(
      proxyContainerName,
      targetIP,
      containerName,
      appPort
    );

    return reuseHelper ? [isHealthy, proxyContainerName] : isHealthy;
  }

  /**
   * Run a health check using the luma-proxy container
   * @param proxyContainerName Name of the luma-proxy container (should be "luma-proxy")
   * @param targetContainerIP IP address of the container to check
   * @param targetContainerName Name of the container to check
   * @param appPort The port the app is listening on (default: 80)
   * @returns true if the /up endpoint returns 200, false otherwise
   */
  async checkHealthWithLumaProxy(
    proxyContainerName: string,
    targetContainerIP: string,
    targetContainerName: string,
    appPort: number = 80
  ): Promise<boolean> {
    try {
      this.log(
        `Using luma-proxy container for health check of ${targetContainerName} (IP: ${targetContainerIP}:${appPort})`
      );

      // Retry the curl command if it fails. Use the provided port, path to /up.
      let statusCode = "";
      let success = false;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Use curl from within the luma-proxy container
          // The luma-proxy container should have curl available, but if not we'll install it
          const execCmd = `exec ${proxyContainerName} sh -c "command -v curl >/dev/null 2>&1 || (apt-get update && apt-get install -y curl); curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 5 http://${targetContainerIP}:${appPort}/up || echo 'failed'"`;
          statusCode = await this.execRemote(execCmd);
          success = true;
          break;
        } catch (execError) {
          this.logError(
            `Health check attempt ${attempt + 1}/3 failed: ${execError}`
          );
          if (attempt < 2) {
            // Brief pause before retry
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }

      if (!success) {
        this.logError(`All health check attempts with luma-proxy failed`);
        return false;
      }

      // Check the status code
      const cleanStatusCode = statusCode.trim();
      this.log(
        `Health check for ${targetContainerName} (IP: ${targetContainerIP}:${appPort}) returned status: ${cleanStatusCode} (using luma-proxy)`
      );

      return cleanStatusCode === "200";
    } catch (error) {
      this.logError(`Health check failed for ${targetContainerName}: ${error}`);
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
   * Execute a command inside a running container
   */
  async execInContainer(
    containerName: string,
    command: string
  ): Promise<{ success: boolean; output: string }> {
    this.log(`Executing command in container ${containerName}: ${command}`);
    try {
      const output = await this.execRemote(`exec ${containerName} ${command}`);
      this.log(`Successfully executed command in container ${containerName}.`);
      return { success: true, output };
    } catch (error) {
      const errorOutput = String(error);
      this.logError(
        `Failed to execute command in container ${containerName}: ${errorOutput}`
      );
      return { success: false, output: errorOutput };
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

  /**
   * Get the IP address of a container on a specific network.
   * @param containerName The name of the container.
   * @param networkName The name of the network.
   * @returns The IP address string, or null if not found or an error occurs.
   */
  async getContainerIPAddress(
    containerName: string,
    networkName: string
  ): Promise<string | null> {
    this.log(
      `Getting IP address for container ${containerName} on network ${networkName}`
    );
    try {
      // Use JSON output instead of Go template to avoid issues with hyphens in network names
      const command = `inspect ${containerName} --format "{{json .NetworkSettings.Networks}}"`;
      this.log(`Executing Docker command: docker ${command}`);

      const output = await this.execRemote(command);
      this.log(`Docker inspect output: ${output}`);

      const networks = JSON.parse(output.trim());

      if (
        networks &&
        networks[networkName] &&
        networks[networkName].IPAddress
      ) {
        const ipAddress = networks[networkName].IPAddress;
        this.log(
          `Container ${containerName} has IP ${ipAddress} on network ${networkName}`
        );
        return ipAddress;
      }

      this.logWarn(
        `Could not find IP address for ${containerName} on network ${networkName}. Available networks: ${Object.keys(
          networks || {}
        ).join(", ")}`
      );
      return null;
    } catch (error) {
      this.logError(
        `Failed to get IP address for container ${containerName} on network ${networkName}: ${error}`
      );
      return null;
    }
  }

  /**
   * Get the project-specific network name a container is connected to.
   * @param containerName The name of the container.
   * @param projectName The name of the current Luma project.
   * @returns The network name string, or null if not found or an error occurs.
   */
  async getContainerNetworkName(
    containerName: string,
    projectName: string
  ): Promise<string | null> {
    this.log(
      `Getting project network for container ${containerName} (project: ${projectName})`
    );
    const expectedNetworkName = getProjectNetworkName(projectName);
    try {
      const command = `inspect ${containerName} --format "{{json .NetworkSettings.Networks}}"`;
      const output = await this.execRemote(command);
      const networks = JSON.parse(output.trim());

      for (const netName in networks) {
        if (netName === expectedNetworkName) {
          this.log(
            `Container ${containerName} is connected to project network ${expectedNetworkName}`
          );
          return expectedNetworkName;
        }
      }
      this.logWarn(
        `Container ${containerName} is not connected to the expected project network ${expectedNetworkName}. Found: ${Object.keys(
          networks
        ).join(", ")}`
      );
      return null;
    } catch (error) {
      this.logError(
        `Failed to get network information for container ${containerName}: ${error}`
      );
      return null;
    }
  }
}
