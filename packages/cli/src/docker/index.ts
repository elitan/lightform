// Docker CLI wrapper logic will go here

import { SSHClient } from "../ssh";
import {
  ServiceEntry,
  AppEntry,
  LightformSecrets,
  LightformConfig,
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
  networkAliases?: string[];
  ports?: string[];
  volumes?: string[];
  envVars?: Record<string, string>;
  restart?: string;
  labels?: Record<string, string>;
}

export interface DockerBuildOptions {
  context: string;
  dockerfile?: string;
  tags?: string[];
  buildArgs?: Record<string, string>;
  target?: string;
  platform?: string;
  verbose?: boolean;
}

export class DockerClient {
  private sshClient?: SSHClient;
  private serverHostname?: string;
  private verbose: boolean = false;

  constructor(
    sshClient?: SSHClient,
    serverHostname?: string,
    verbose: boolean = false
  ) {
    this.sshClient = sshClient;
    this.serverHostname = serverHostname;
    this.verbose = verbose;
  }

  /**
   * Log a message with server hostname prefix or general log if no server context
   */
  private log(message: string): void {
    if (!this.verbose) return;

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
    if (!this.verbose) return;

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

      // For exec commands that might be successful proxy operations, don't log immediately
      // Let the calling method (like execInContainer) determine if it's actually an error
      if (command.includes("exec")) {
        throw error; // Rethrow without logging to let execInContainer handle it
      }

      this.logError(`Remote Docker command failed: ${error}`);
      throw error;
    }
  }

  /**
   * Execute a command locally
   */
  private static async _runLocalCommand(
    command: string,
    verbose: boolean = false
  ): Promise<{ stdout: string; stderr: string }> {
    if (verbose) {
      console.log(`Executing local command: ${command}`);
    }
    try {
      const { stdout, stderr } = await execAsync(command);
      if (stderr && verbose) {
        // Docker often prints non-error info to stderr, so log it but don't always throw
        console.warn(`Local command stderr: ${stderr}`);
      }
      return { stdout, stderr };
    } catch (error) {
      if (verbose) {
        console.error(`Local command failed: ${command}`, error);
      }
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

    if (options.verbose) {
      console.log(`Attempting to build image with command: ${buildCommand}`);
    }
    await DockerClient._runLocalCommand(buildCommand, options.verbose);
    if (options.verbose) {
      console.log("Docker build process completed.");
    }
  }

  static async tag(
    sourceImage: string,
    targetImage: string,
    verbose: boolean = false
  ): Promise<void> {
    const command = `docker tag \"${sourceImage}\" \"${targetImage}\"`;
    if (verbose) {
      console.log(`Attempting to tag image: ${command}`);
    }
    await DockerClient._runLocalCommand(command, verbose);
    if (verbose) {
      console.log(
        `Successfully tagged \"${sourceImage}\" as \"${targetImage}\".`
      );
    }
  }

  /**
   * Save a Docker image to a tar archive
   */
  static async save(
    imageName: string,
    outputPath: string,
    verbose: boolean = false
  ): Promise<void> {
    const command = `docker save \"${imageName}\" -o \"${outputPath}\"`;
    if (verbose) {
      console.log(`Saving image to archive: ${command}`);
    }
    await DockerClient._runLocalCommand(command, verbose);
    if (verbose) {
      console.log(
        `Successfully saved image \"${imageName}\" to \"${outputPath}\".`
      );
    }
  }

  /**
   * Save a Docker image to a compressed tar.gz archive for faster transfer
   * Falls back to uncompressed tar if gzip is not available
   */
  static async saveCompressed(
    imageName: string,
    outputPath: string,
    verbose: boolean = false
  ): Promise<void> {
    try {
      // Check if gzip is available locally
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execPromise = promisify(exec);

      try {
        await execPromise("which gzip");
        if (verbose) {
          console.log("gzip is available, using compression");
        }
      } catch (gzipCheckError) {
        if (verbose) {
          console.log("gzip not available, falling back to uncompressed tar");
        }
        // Fall back to regular save if gzip is not available
        const uncompressedPath = outputPath.replace(".tar.gz", ".tar");
        await DockerClient.save(imageName, uncompressedPath, verbose);
        return;
      }

      // Use gzip compression to significantly reduce file size
      const command = `docker save "${imageName}" | gzip > "${outputPath}"`;
      if (verbose) {
        console.log(`Saving compressed image to archive: ${command}`);
      }
      await DockerClient._runLocalCommand(command, verbose);
      if (verbose) {
        console.log(
          `Successfully saved compressed image "${imageName}" to "${outputPath}".`
        );
      }
    } catch (error) {
      if (verbose) {
        console.log(
          `Compression failed, falling back to uncompressed tar: ${error}`
        );
      }
      // Fall back to regular save if compression fails
      const uncompressedPath = outputPath.replace(".tar.gz", ".tar");
      await DockerClient.save(imageName, uncompressedPath, verbose);
    }
  }

  static async push(
    imageName: string,
    registry?: string,
    verbose: boolean = false
  ): Promise<void> {
    // If a specific registry (not Docker Hub) is provided, the imageName should already include it for push.
    // However, Docker CLI push can take the full image name including registry.
    // Example: my.registry.com/namespace/image:tag
    // If registry param is just hostname, it assumes official library image if no user/org part.
    // For simplicity, ensure imageName is the full path if not Docker Hub.
    const command = `docker push \"${imageName}\"`;
    if (verbose) {
      console.log(`Attempting to push image: ${command}`);
    }
    await DockerClient._runLocalCommand(command, verbose);
    if (verbose) {
      console.log(
        `Successfully pushed \"${imageName}\"${
          registry ? " to " + registry : ""
        }.`
      );
    }
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
        // Only log this in verbose mode since it's expected
        if (this.verbose) {
          this.log(
            `Could not remove existing image ${image} (expected if image doesn't exist locally), will pull fresh copy.`
          );
        }
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
   * Load a Docker image from a tar archive
   */
  async loadImage(archivePath: string): Promise<boolean> {
    this.log(`Loading image from archive ${archivePath}...`);
    try {
      // Check if it's a compressed archive by file extension
      if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
        return await this.loadCompressedImage(archivePath);
      }

      await this.execRemote(`load -i "${archivePath}"`);
      this.log(`Successfully loaded image from ${archivePath}.`);
      return true;
    } catch (error) {
      this.logError(`Failed to load image from ${archivePath}: ${error}`);
      return false;
    }
  }

  /**
   * Load a Docker image from a compressed tar.gz archive
   * Falls back to regular docker load if gunzip is not available
   */
  async loadCompressedImage(archivePath: string): Promise<boolean> {
    this.log(`Loading compressed image from archive ${archivePath}...`);
    try {
      // Check if gunzip is available on the remote server
      try {
        await this.sshClient?.exec("which gunzip");
        this.log("gunzip is available on remote server, using decompression");
      } catch (gunzipCheckError) {
        this.log(
          "gunzip not available on remote server, falling back to regular docker load"
        );
        // Fall back to regular docker load (assuming file might not be compressed)
        await this.execRemote(`load -i "${archivePath}"`);
        this.log(
          `Successfully loaded image from ${archivePath} (fallback method).`
        );
        return true;
      }

      // Use shell command to decompress and pipe to docker load
      const command = `sh -c "gunzip -c '${archivePath}' | docker load"`;
      await this.sshClient?.exec(command);
      this.log(`Successfully loaded compressed image from ${archivePath}.`);
      return true;
    } catch (error) {
      this.logError(
        `Failed to load compressed image from ${archivePath}: ${error}`
      );

      // Try one more fallback - maybe the file isn't actually compressed
      try {
        this.log(
          `Attempting fallback: treating ${archivePath} as uncompressed`
        );
        await this.execRemote(`load -i "${archivePath}"`);
        this.log(
          `Successfully loaded image from ${archivePath} (fallback method).`
        );
        return true;
      } catch (fallbackError) {
        this.logError(
          `All load attempts failed for ${archivePath}: ${fallbackError}`
        );
        return false;
      }
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

      // Add labels if specified
      if (options.labels) {
        Object.entries(options.labels).forEach(([key, value]) => {
          cmd += ` --label ${key}="${value}"`;
        });
      }

      // Add network if specified
      if (options.network) {
        cmd += ` --network ${options.network}`;

        // Add network aliases if specified
        if (options.networkAliases && options.networkAliases.length > 0) {
          options.networkAliases.forEach((alias) => {
            cmd += ` --network-alias ${alias}`;
          });
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
   * Run a health check using project-specific DNS targets
   * @param proxyContainerName Name of the lightform-proxy container (should be "lightform-proxy")
   * @param targetNetworkAlias Network alias of the container to check (e.g., "web") - DEPRECATED, use projectSpecificTarget
   * @param targetContainerName Name of the container to check
   * @param projectName The project name for network isolation
   * @param appPort The port the app is listening on (default: 80)
   * @param healthCheckPath The health check endpoint path (default: "/up")
   * @returns true if the health check endpoint returns 200, false otherwise
   */
  async checkHealthWithLightformProxy(
    proxyContainerName: string,
    targetNetworkAlias: string,
    targetContainerName: string,
    projectName: string,
    appPort: number = 80,
    healthCheckPath: string = "/up"
  ): Promise<boolean> {
    try {
      // Use project-specific target directly (dual alias solution)
      const appName = targetNetworkAlias; // Assuming targetNetworkAlias is the app name
      const projectSpecificTarget = `${projectName}-${appName}`;

      this.log(
        `Using project-specific health check for ${targetContainerName} (project: ${projectName}, target: ${projectSpecificTarget}:${appPort}${healthCheckPath})`
      );

      // Retry the health check if it fails. Give containers up to 30 seconds to start up.
      let statusCode = "";
      let success = false;
      const maxAttempts = 30;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          // Use project-specific DNS target directly
          const targetURL = `http://${projectSpecificTarget}:${appPort}${healthCheckPath}`;

          // Install curl if needed and run health check
          const installCurlCmd = `exec ${proxyContainerName} sh -c "command -v curl >/dev/null 2>&1 || (apt-get update && apt-get install -y curl)"`;
          await this.execRemote(installCurlCmd);

          // Separate health check command with proper quote escaping and newline separation
          const healthCheckCmd = `exec ${proxyContainerName} sh -c "curl -s -o /dev/null -w '%{http_code}\\n' --connect-timeout 3 --max-time 5 ${targetURL}"`;
          statusCode = await this.execRemote(healthCheckCmd);

          // Check if we got a successful status code
          const cleanStatusCode = statusCode.trim();
          if (cleanStatusCode === "200") {
            success = true;
            this.log(
              `Health check for ${targetContainerName} passed on attempt ${
                attempt + 1
              }/${maxAttempts} (project: ${projectName}, target: ${projectSpecificTarget}:${appPort}${healthCheckPath})`
            );
            break;
          } else {
            if (attempt < maxAttempts - 1) {
              this.log(
                `Health check attempt ${
                  attempt + 1
                }/${maxAttempts} returned status: ${cleanStatusCode}, retrying in 1 second...`
              );
            }
          }
        } catch (execError) {
          if (attempt < maxAttempts - 1) {
            this.log(
              `Health check attempt ${
                attempt + 1
              }/${maxAttempts} failed: ${execError}, retrying in 1 second...`
            );
          } else {
            this.logError(
              `Health check attempt ${
                attempt + 1
              }/${maxAttempts} failed: ${execError}`
            );
          }
        }

        // Wait 1 second before next attempt (unless this was the last attempt)
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      if (!success) {
        this.logError(
          `All ${maxAttempts} health check attempts failed for ${targetContainerName} in project ${projectName}`
        );
        return false;
      }

      return true;
    } catch (error) {
      this.logError(`Health check failed for ${targetContainerName}: ${error}`);
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

      // Check if this is actually a successful operation based on output patterns
      // This handles cases where commands work correctly but return non-zero exit codes
      if (
        errorOutput.includes("Route deployed successfully") ||
        errorOutput.includes("successfully configured") ||
        errorOutput.includes("SSL certificate obtained") ||
        errorOutput.includes("Health status for") ||
        errorOutput.includes("updated to true") ||
        errorOutput.includes("updated to false") ||
        (errorOutput.includes("Domain") &&
          errorOutput.includes("added to certificate manager")) ||
        errorOutput.includes(
          "SSL certificate will be provisioned automatically"
        ) ||
        errorOutput.includes("Adding domain to certificate manager") ||
        errorOutput.includes("Created certificate reload trigger") ||
        errorOutput.includes("Scheduling SSL certificate provisioning") ||
        (errorOutput.includes("Added") &&
          errorOutput.includes("to certificate retry queue")) ||
        (errorOutput.includes("Added") &&
          errorOutput.includes("to background certificate retry queue")) ||
        (errorOutput.includes("Route for host") &&
          errorOutput.includes("successfully configured")) ||
        errorOutput.includes("✅") ||
        errorOutput.includes("📋") // Success emojis from proxy
      ) {
        // For proxy commands, only show detailed output in verbose mode
        if (this.verbose) {
          this.log(
            `Command succeeded despite non-zero exit code in container ${containerName}:`
          );
          console.log(errorOutput); // Show the full output in verbose mode
        } else {
          this.log(
            `Command succeeded despite non-zero exit code in container ${containerName}.`
          );
        }
        return { success: true, output: errorOutput };
      }

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
   * Convert a Lightform service definition to Docker container options
   */
  static serviceToContainerOptions(
    service: ServiceEntry,
    projectName: string,
    secrets: LightformSecrets
  ): DockerContainerOptions {
    const containerName = `${projectName}-${service.name}`;
    const options: DockerContainerOptions = {
      name: containerName,
      image: service.image,
      network: `${projectName}-network`,
      ports: service.ports,
      volumes: service.volumes,
      envVars: {},
      labels: {
        "lightform.managed": "true",
        "lightform.project": projectName,
        "lightform.type": "service",
        "lightform.service": service.name,
      },
    };

    // Add environment variables
    if (service.environment?.plain) {
      for (const envVar of service.environment.plain) {
        const [key, ...valueParts] = envVar.split("=");
        if (key && valueParts.length > 0) {
          options.envVars![key] = valueParts.join("=");
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
   * Find containers by label filter
   * @param labelFilter Docker label filter string (e.g., "lightform.app=blog", "lightform.color=blue")
   * @returns Array of container names matching the filter
   */
  async findContainersByLabel(labelFilter: string): Promise<string[]> {
    try {
      const result = await this.execRemote(
        `ps -a --filter "label=${labelFilter}" --format "{{.Names}}"`
      );
      if (!result.trim()) {
        return [];
      }
      return result.trim().split("\n");
    } catch (error) {
      this.logError(
        `Failed to find containers by label ${labelFilter}: ${error}`
      );
      return [];
    }
  }

  /**
   * Find containers by label filter within a specific project
   * @param labelFilter Docker label filter string (e.g., "lightform.app=web", "lightform.color=blue")
   * @param projectName Project name to scope the search to
   * @returns Array of container names matching the filter within the project
   */
  async findContainersByLabelAndProject(
    labelFilter: string,
    projectName: string
  ): Promise<string[]> {
    try {
      const result = await this.execRemote(
        `ps -a --filter "label=${labelFilter}" --filter "label=lightform.project=${projectName}" --format "{{.Names}}"`
      );
      if (!result.trim()) {
        return [];
      }
      return result.trim().split("\n");
    } catch (error) {
      this.logError(
        `Failed to find containers by label ${labelFilter} in project ${projectName}: ${error}`
      );
      return [];
    }
  }

  /**
   * Get container labels
   * @param containerName Name of the container
   * @returns Object with container labels or empty object if none found
   */
  async getContainerLabels(
    containerName: string
  ): Promise<Record<string, string>> {
    try {
      const result = await this.execRemote(
        `inspect ${containerName} --format '{{json .Config.Labels}}'`
      );
      if (!result.trim() || result.trim() === "null") {
        return {};
      }
      return JSON.parse(result.trim());
    } catch (error) {
      this.logError(
        `Failed to get labels for container ${containerName}: ${error}`
      );
      return {};
    }
  }

  /**
   * Determines the current active color (blue/green) for an app
   * @param appName Name of the app
   * @returns 'blue', 'green', or null if no containers exist
   */
  async getCurrentActiveColor(
    appName: string
  ): Promise<"blue" | "green" | null> {
    try {
      const containers = await this.findContainersByLabel(
        `lightform.app=${appName}`
      );

      if (containers.length === 0) {
        return null; // No containers exist
      }

      // First, try to find containers explicitly marked as active
      for (const containerName of containers) {
        const labels = await this.getContainerLabels(containerName);
        if (labels["lightform.active"] === "true") {
          return labels["lightform.color"] as "blue" | "green";
        }
      }

      // If no containers are marked as active, check which containers have the main network alias
      // This handles the case where containers exist but active labels aren't set
      for (const containerName of containers) {
        try {
          // Check if this container has the main network alias (indicating it's active)
          const inspectOutput = await this.execRemote(
            `inspect ${containerName} --format "{{json .NetworkSettings.Networks}}"`
          );
          const networks = JSON.parse(inspectOutput);

          // Look for the main app alias in any network
          for (const networkData of Object.values(networks) as any[]) {
            if (networkData.Aliases && networkData.Aliases.includes(appName)) {
              const labels = await this.getContainerLabels(containerName);
              return labels["lightform.color"] as "blue" | "green";
            }
          }
        } catch (error) {
          // Continue checking other containers if one fails
          continue;
        }
      }

      // If we still can't determine active color, return the color of the first running container
      for (const containerName of containers) {
        const isRunning = await this.containerIsRunning(containerName);
        if (isRunning) {
          const labels = await this.getContainerLabels(containerName);
          return labels["lightform.color"] as "blue" | "green";
        }
      }

      return null;
    } catch (error) {
      this.logError(
        `Failed to determine active color for app ${appName}: ${error}`
      );
      return null;
    }
  }

  /**
   * Determines the current active color (blue/green) for an app within a specific project
   * @param appName Name of the app
   * @param projectName Project name to scope the search to
   * @returns 'blue', 'green', or null if no containers exist
   */
  async getCurrentActiveColorForProject(
    appName: string,
    projectName: string
  ): Promise<"blue" | "green" | null> {
    try {
      const containers = await this.findContainersByLabelAndProject(
        `lightform.app=${appName}`,
        projectName
      );

      if (containers.length === 0) {
        return null; // No containers exist
      }

      // First, try to find containers explicitly marked as active
      for (const containerName of containers) {
        const labels = await this.getContainerLabels(containerName);
        if (labels["lightform.active"] === "true") {
          return labels["lightform.color"] as "blue" | "green";
        }
      }

      // If no containers are marked as active, check which containers have the main network alias
      // This handles the case where containers exist but active labels aren't set
      for (const containerName of containers) {
        try {
          // Check if this container has the main network alias (indicating it's active)
          const inspectOutput = await this.execRemote(
            `inspect ${containerName} --format "{{json .NetworkSettings.Networks}}"`
          );
          const networks = JSON.parse(inspectOutput);

          // Look for the main app alias in any network
          for (const networkData of Object.values(networks) as any[]) {
            if (networkData.Aliases && networkData.Aliases.includes(appName)) {
              const labels = await this.getContainerLabels(containerName);
              return labels["lightform.color"] as "blue" | "green";
            }
          }
        } catch (error) {
          // Continue checking other containers if one fails
          continue;
        }
      }

      // If we still can't determine active color, return the color of the first running container
      for (const containerName of containers) {
        const isRunning = await this.containerIsRunning(containerName);
        if (isRunning) {
          const labels = await this.getContainerLabels(containerName);
          return labels["lightform.color"] as "blue" | "green";
        }
      }

      return null;
    } catch (error) {
      this.logError(
        `Failed to determine active color for app ${appName} in project ${projectName}: ${error}`
      );
      return null;
    }
  }

  /**
   * Gets the inactive color (opposite of current active)
   * @param appName Name of the app
   * @returns 'blue' or 'green' - the color that should be used for new deployment
   */
  async getInactiveColor(appName: string): Promise<"blue" | "green"> {
    const activeColor = await this.getCurrentActiveColor(appName);
    return activeColor === "blue" ? "green" : "blue";
  }

  /**
   * Gets the inactive color (opposite of current active) for a specific project
   * @param appName Name of the app
   * @param projectName Project name to scope the search to
   * @returns 'blue' or 'green' - the color that should be used for new deployment
   */
  async getInactiveColorForProject(
    appName: string,
    projectName: string
  ): Promise<"blue" | "green"> {
    const activeColor = await this.getCurrentActiveColorForProject(
      appName,
      projectName
    );
    return activeColor === "blue" ? "green" : "blue";
  }

  /**
   * Creates a container with zero-downtime deployment labels
   * @param options Standard container options
   * @param appName Application name
   * @param color Color for this deployment (blue/green)
   * @param replicaIndex Replica index (1-based)
   * @param active Whether this container is currently active
   * @returns true if container was created successfully
   */
  async createContainerWithLabels(
    options: DockerContainerOptions,
    appName: string,
    color: "blue" | "green",
    replicaIndex: number,
    active: boolean
  ): Promise<boolean> {
    try {
      // Add zero-downtime deployment labels
      const extendedOptions = {
        ...options,
        labels: {
          ...options.labels,
          "lightform.app": appName,
          "lightform.color": color,
          "lightform.replica": replicaIndex.toString(),
          "lightform.active": active.toString(),
          "lightform.managed": "true",
        },
      };

      this.log(`Creating container: ${options.name}`);
      return await this.createContainer(extendedOptions);
    } catch (error) {
      this.logError(`Failed to create container with labels: ${error}`);
      return false;
    }
  }

  /**
   * Switches network aliases from old color to new color atomically
   * @param appName Name of the app
   * @param newColor The color to switch to
   * @param networkName The network name
   * @returns true if successful
   */
  async switchNetworkAlias(
    appName: string,
    newColor: "blue" | "green",
    networkName: string
  ): Promise<boolean> {
    try {
      this.log(
        `Switching network alias for ${appName} to ${newColor} containers`
      );

      // Get all containers for the new color
      const newContainers = await this.findContainersByLabel(
        `lightform.app=${appName}`
      );
      const newColorContainers = [];

      for (const containerName of newContainers) {
        const labels = await this.getContainerLabels(containerName);
        if (labels["lightform.color"] === newColor) {
          newColorContainers.push(containerName);
        }
      }

      if (newColorContainers.length === 0) {
        this.logError(`No ${newColor} containers found for app ${appName}`);
        return false;
      }

      // For each new container, disconnect from network and reconnect with main alias
      for (const containerName of newColorContainers) {
        try {
          // Disconnect from network (removes temporary alias)
          await this.execRemote(
            `network disconnect ${networkName} ${containerName} || true`
          );

          // Reconnect with the main alias
          await this.execRemote(
            `network connect --alias ${appName} ${networkName} ${containerName}`
          );

          this.log(`Updated network alias for container ${containerName}`);
        } catch (error) {
          this.logError(
            `Failed to update network alias for ${containerName}: ${error}`
          );
          return false;
        }
      }

      return true;
    } catch (error) {
      this.logError(`Failed to switch network alias for ${appName}: ${error}`);
      return false;
    }
  }

  /**
   * Switches network aliases from old color to new color atomically within a specific project
   * @param appName Name of the app
   * @param newColor The color to switch to
   * @param networkName The network name
   * @param projectName Project name to scope the search to
   * @returns true if successful
   */
  async switchNetworkAliasForProject(
    appName: string,
    newColor: "blue" | "green",
    networkName: string,
    projectName: string
  ): Promise<boolean> {
    try {
      this.log(
        `Switching network alias for ${appName} to ${newColor} containers in project ${projectName}`
      );

      // Get all containers for the new color within the project
      const newContainers = await this.findContainersByLabelAndProject(
        `lightform.app=${appName}`,
        projectName
      );
      const newColorContainers = [];

      for (const containerName of newContainers) {
        const labels = await this.getContainerLabels(containerName);
        if (labels["lightform.color"] === newColor) {
          newColorContainers.push(containerName);
        }
      }

      if (newColorContainers.length === 0) {
        this.logError(
          `No ${newColor} containers found for app ${appName} in project ${projectName}`
        );
        return false;
      }

      // For each new container, disconnect from network and reconnect with dual aliases
      for (const containerName of newColorContainers) {
        try {
          // Disconnect from network (removes temporary alias)
          await this.execRemote(
            `network disconnect ${networkName} ${containerName} || true`
          );

          // Reconnect with both aliases (dual alias approach)
          const projectSpecificAlias = `${projectName}-${appName}`;
          await this.execRemote(
            `network connect --alias ${appName} --alias ${projectSpecificAlias} ${networkName} ${containerName}`
          );

          this.log(`Updated network alias for container ${containerName}`);
        } catch (error) {
          this.logError(
            `Failed to update network alias for ${containerName}: ${error}`
          );
          return false;
        }
      }

      return true;
    } catch (error) {
      this.logError(
        `Failed to switch network alias for ${appName} in project ${projectName}: ${error}`
      );
      return false;
    }
  }

  /**
   * Updates container labels to mark them as active/inactive
   * Note: Docker doesn't support updating labels after container creation,
   * so this function is a no-op. Labels are set correctly during creation.
   * @param appName Name of the app
   * @param activeColor The color to mark as active
   * @returns true (always successful since labels are set during creation)
   */
  async updateActiveLabels(
    appName: string,
    activeColor: "blue" | "green"
  ): Promise<boolean> {
    this.log(
      `Active labels for ${appName} are set correctly during container creation`
    );
    // Docker doesn't support updating labels after creation
    // Labels are already set correctly in createContainerWithLabels()
    return true;
  }

  /**
   * Performs graceful shutdown of containers with SIGTERM
   * @param containerNames Array of container names to shut down
   * @param gracefulTimeoutSeconds Time to wait for graceful shutdown (default: 30)
   * @returns true if all containers shut down successfully
   */
  async gracefulShutdown(
    containerNames: string[],
    gracefulTimeoutSeconds: number = 30
  ): Promise<boolean> {
    try {
      this.log(
        `Starting graceful shutdown of ${containerNames.length} containers with ${gracefulTimeoutSeconds}s timeout`
      );

      for (const containerName of containerNames) {
        try {
          // Send SIGTERM and wait for graceful shutdown
          await this.execRemote(
            `stop --time ${gracefulTimeoutSeconds} ${containerName}`
          );
          this.log(`Gracefully stopped container ${containerName}`);
        } catch (error) {
          this.logWarn(`Failed to gracefully stop ${containerName}: ${error}`);
        }
      }

      return true;
    } catch (error) {
      this.logError(`Failed during graceful shutdown: ${error}`);
      return false;
    }
  }

  /**
   * Find all containers managed by Lightform for a specific project
   * @param projectName The project name to filter by
   * @returns Array of container names belonging to the project
   */
  async findProjectContainers(projectName: string): Promise<string[]> {
    try {
      return await this.findContainersByLabel(
        `lightform.project=${projectName}`
      );
    } catch (error) {
      this.logError(
        `Failed to find containers for project ${projectName}: ${error}`
      );
      return [];
    }
  }

  /**
   * Find all app containers for a specific project
   * @param projectName The project name to filter by
   * @returns Array of container names for apps in the project
   */
  async findProjectAppContainers(projectName: string): Promise<string[]> {
    try {
      const result = await this.execRemote(
        `ps -a --filter "label=lightform.project=${projectName}" --filter "label=lightform.type=app" --format "{{.Names}}"`
      );
      if (!result.trim()) {
        return [];
      }
      return result.trim().split("\n");
    } catch (error) {
      this.logError(
        `Failed to find app containers for project ${projectName}: ${error}`
      );
      return [];
    }
  }

  /**
   * Find all service containers for a specific project
   * @param projectName The project name to filter by
   * @returns Array of container names for services in the project
   */
  async findProjectServiceContainers(projectName: string): Promise<string[]> {
    try {
      const result = await this.execRemote(
        `ps -a --filter "label=lightform.project=${projectName}" --filter "label=lightform.type=service" --format "{{.Names}}"`
      );
      if (!result.trim()) {
        return [];
      }
      return result.trim().split("\n");
    } catch (error) {
      this.logError(
        `Failed to find service containers for project ${projectName}: ${error}`
      );
      return [];
    }
  }

  /**
   * Get detailed information about a project's containers
   * @param projectName The project name to analyze
   * @returns Object with apps and services currently deployed
   */
  async getProjectCurrentState(projectName: string): Promise<{
    apps: Record<string, string[]>; // app name -> container names
    services: Record<string, string>; // service name -> container name
  }> {
    const state = {
      apps: {} as Record<string, string[]>,
      services: {} as Record<string, string>,
    };

    try {
      const allContainers = await this.findProjectContainers(projectName);

      for (const containerName of allContainers) {
        const labels = await this.getContainerLabels(containerName);

        if (labels["lightform.type"] === "app" && labels["lightform.app"]) {
          const appName = labels["lightform.app"];
          if (!state.apps[appName]) {
            state.apps[appName] = [];
          }
          state.apps[appName].push(containerName);
        } else if (
          labels["lightform.type"] === "service" &&
          labels["lightform.service"]
        ) {
          const serviceName = labels["lightform.service"];
          state.services[serviceName] = containerName;
        }
      }

      return state;
    } catch (error) {
      this.logError(
        `Failed to get current state for project ${projectName}: ${error}`
      );
      return state;
    }
  }

  /**
   * Get container uptime in a human-readable format
   * @param containerName Name of the container
   * @returns Human-readable uptime string (e.g., "2h 15m", "3 days") or null if error
   */
  async getContainerUptime(containerName: string): Promise<string | null> {
    try {
      const inspectOutput = await this.execRemote(
        `inspect ${containerName} --format '{{.State.StartedAt}}'`
      );

      if (!inspectOutput.trim()) {
        return null;
      }

      const startedAt = new Date(inspectOutput.trim());
      const now = new Date();
      const uptimeMs = now.getTime() - startedAt.getTime();

      // Convert to human-readable format
      const seconds = Math.floor(uptimeMs / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (days > 0) {
        return `${days}d ${hours % 24}h`;
      } else if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
      } else if (minutes > 0) {
        return `${minutes}m`;
      } else {
        return `${seconds}s`;
      }
    } catch (error) {
      this.logError(
        `Failed to get uptime for container ${containerName}: ${error}`
      );
      return null;
    }
  }

  /**
   * Get container resource usage (CPU and memory)
   * @param containerName Name of the container
   * @returns Object with CPU and memory usage or null if error
   */
  async getContainerStats(containerName: string): Promise<{
    cpuPercent: string;
    memoryUsage: string;
    memoryPercent: string;
  } | null> {
    try {
      // Use docker stats with --no-stream to get current stats
      const statsOutput = await this.execRemote(
        `stats ${containerName} --no-stream --format "{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"`
      );

      const lines = statsOutput.trim().split("\n");
      if (lines.length < 1) {
        return null;
      }

      // Get data from first line (no header when using custom format)
      const dataLine = lines[0];
      const [cpuPercent, memoryUsage, memoryPercent] = dataLine.split("\t");

      return {
        cpuPercent: cpuPercent?.trim() || "0%",
        memoryUsage: memoryUsage?.trim() || "0B / 0B",
        memoryPercent: memoryPercent?.trim() || "0%",
      };
    } catch (error) {
      this.logError(
        `Failed to get stats for container ${containerName}: ${error}`
      );
      return null;
    }
  }

  /**
   * Get detailed container information for status display
   * @param containerName Name of the container
   * @returns Detailed container info or null if error
   */
  async getContainerDetails(containerName: string): Promise<{
    uptime: string | null;
    stats: {
      cpuPercent: string;
      memoryUsage: string;
      memoryPercent: string;
    } | null;
    image: string | null;
    createdAt: string | null;
    restartCount: number;
    exitCode: number | null;
    ports: string[];
    volumes: Array<{
      source: string;
      destination: string;
      mode?: string;
    }>;
  } | null> {
    try {
      const inspectOutput = await this.execRemote(`inspect ${containerName}`);
      const inspectData = JSON.parse(inspectOutput);

      if (!inspectData || inspectData.length === 0) {
        return null;
      }

      const container = inspectData[0];

      // Get uptime and stats in parallel
      const [uptime, stats] = await Promise.all([
        this.getContainerUptime(containerName),
        this.getContainerStats(containerName),
      ]);

      // Extract detailed info
      const image = container.Config?.Image || null;
      const createdAt = container.Created || null;
      const restartCount = container.RestartCount || 0;
      const exitCode = container.State?.ExitCode || null;

      // Extract port mappings
      const ports: string[] = [];
      if (container.NetworkSettings?.Ports) {
        for (const [containerPort, hostBindings] of Object.entries(
          container.NetworkSettings.Ports
        )) {
          if (hostBindings && Array.isArray(hostBindings)) {
            for (const binding of hostBindings) {
              ports.push(`${binding.HostPort}:${containerPort}`);
            }
          }
        }
      }

      // Extract volume mounts with detailed information
      const volumes: Array<{
        source: string;
        destination: string;
        mode?: string;
      }> = [];
      if (container.Mounts && Array.isArray(container.Mounts)) {
        for (const mount of container.Mounts) {
          volumes.push({
            source: mount.Name || mount.Source || "unknown",
            destination: mount.Destination || "unknown",
            mode: mount.Mode,
          });
        }
      }

      return {
        uptime,
        stats,
        image,
        createdAt,
        restartCount,
        exitCode,
        ports,
        volumes,
      };
    } catch (error) {
      this.logError(
        `Failed to get details for container ${containerName}: ${error}`
      );
      return null;
    }
  }
}
