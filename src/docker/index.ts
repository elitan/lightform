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
      const escapedPassword = password.replace(
        /[\$"`\\\n]/g,
        (match) => `\\${match}`
      );
      const loginCommand = `login ${registry} -u "${username}" --password-stdin`;
      if (!this.sshClient) {
        this.logError("SSH client not available for Docker login operation.");
        return false;
      }
      await this.sshClient.exec(
        `echo "${escapedPassword}" | docker ${loginCommand}`
      );
      this.log(`Successfully logged into Docker registry: ${registry}.`);
      return true;
    } catch (error) {
      this.logError(`Failed to log into Docker registry ${registry}: ${error}`);
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
   * @param endpoint The HTTP endpoint to check (e.g., "/up", "/health")
   * @param port The port the application is listening on inside the container (default: 8080)
   * @returns true if the endpoint returns 200, false otherwise
   */
  async checkContainerEndpoint(
    containerName: string,
    endpoint: string = "/up",
    port: number = 8080
  ): Promise<boolean> {
    // Generate a unique name for the helper container
    const helperName = `healthcheck-${containerName}-${Date.now()}`;

    try {
      // Get the network of the target container
      const networkInfo = await this.execRemote(
        `inspect -f "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}" ${containerName}`
      );
      const network = networkInfo.trim();

      if (!network) {
        this.logError(
          `Cannot determine network for container ${containerName}`
        );
        return false;
      }

      this.log(`Using network ${network} for health check of ${containerName}`);

      // Run a temporary Alpine container with curl
      const helperCmd = `run --rm --name ${helperName} --network ${network} alpine:latest /bin/sh -c "apk add --no-cache curl && curl -s -o /dev/null -w '%{http_code}' http://${containerName}:${port}${endpoint} || echo 'failed'"`;

      this.log(`Starting helper container to check health of ${containerName}`);
      const statusCode = await this.execRemote(helperCmd);

      // Check the status code
      const cleanStatusCode = statusCode.trim();
      this.log(
        `Health check for ${containerName} returned status: ${cleanStatusCode}`
      );

      return cleanStatusCode === "200";
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
}
