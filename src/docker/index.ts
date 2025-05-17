// Docker CLI wrapper logic will go here

import { SSHClient } from "../ssh";
import { LumaService } from "../config/types";

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

export class DockerClient {
  private sshClient: SSHClient;
  private serverHostname: string;

  constructor(sshClient: SSHClient, serverHostname: string) {
    this.sshClient = sshClient;
    this.serverHostname = serverHostname;
  }

  /**
   * Log a message with server hostname prefix
   */
  private log(message: string): void {
    console.log(`[${this.serverHostname}] ${message}`);
  }

  /**
   * Log an error with server hostname prefix
   */
  private logError(message: string): void {
    console.error(`[${this.serverHostname}] ${message}`);
  }

  /**
   * Execute a Docker command via SSH
   */
  private async exec(command: string): Promise<string> {
    try {
      return await this.sshClient.exec(`docker ${command}`);
    } catch (error) {
      this.logError(`Docker command failed: ${error}`);
      throw error;
    }
  }

  /**
   * Check if Docker is installed and working
   */
  async checkInstallation(): Promise<boolean> {
    try {
      await this.exec("info");
      this.log("Docker is installed and accessible.");
      return true;
    } catch (error) {
      this.logError(`Docker not found or 'docker info' failed: ${error}`);
      return false;
    }
  }

  /**
   * Install Docker if not already installed
   */
  async install(): Promise<boolean> {
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
      // Escape special characters in password for shell command
      const escapedPassword = password.replace(
        /[\$"`\\\n]/g,
        (match) => `\\${match}`
      );
      const loginCommand = `login ${registry} -u "${username}" --password-stdin`;

      // Use echo to pass password to stdin
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
   * Pull a Docker image
   */
  async pullImage(image: string): Promise<boolean> {
    this.log(`Pulling image ${image}...`);
    try {
      await this.exec(`pull ${image}`);
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
      const result = await this.exec(
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

      await this.exec(`network create ${options.name}`);
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
      const result = await this.exec(
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
      const result = await this.exec(
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
      await this.exec(`start ${name}`);
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
      await this.exec(`stop ${name}`);
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
      await this.exec(`rm ${name}`);
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
      await this.exec(cmd);
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
   * Convert a Luma service definition to Docker container options
   */
  static serviceToContainerOptions(
    service: LumaService & { name: string },
    projectName: string,
    secrets: Record<string, string>
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
    if (service.environment) {
      // Plain environment variables
      if (service.environment.plain) {
        service.environment.plain.forEach((envVar) => {
          const [key, value] = envVar.split("=");
          if (key && value) {
            options.envVars![key] = value;
          }
        });
      }

      // Secret environment variables
      if (service.environment.secret) {
        service.environment.secret.forEach((secretName) => {
          const secretValue = secrets[secretName];
          if (secretValue) {
            options.envVars![secretName] = secretValue;
          }
        });
      }
    }

    return options;
  }
}
