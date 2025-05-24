import { DockerClient } from "../docker";
import { SSHClient } from "../ssh";

/**
 * Client for interacting with the luma-proxy service
 */
export class LumaProxyClient {
  private dockerClient: DockerClient;
  private serverHostname?: string;
  private verbose: boolean = false;

  /**
   * Create a new LumaProxyClient
   * @param dockerClient An initialized DockerClient for the target server
   * @param serverHostname The hostname of the server (for logging purposes)
   * @param verbose Whether to enable verbose logging
   */
  constructor(
    dockerClient: DockerClient,
    serverHostname?: string,
    verbose: boolean = false
  ) {
    this.dockerClient = dockerClient;
    this.serverHostname = serverHostname;
    this.verbose = verbose;
  }

  /**
   * Log a message with server hostname prefix (only in verbose mode)
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
   * Log an error with server hostname prefix
   */
  private logError(message: string): void {
    if (this.serverHostname) {
      console.error(`[${this.serverHostname}] ${message}`);
    } else {
      console.error(message);
    }
  }

  /**
   * Check if the luma-proxy container is running
   * @returns true if the luma-proxy container exists and is running
   */
  async isProxyRunning(): Promise<boolean> {
    try {
      const proxyExists = await this.dockerClient.containerExists("luma-proxy");
      if (!proxyExists) {
        this.log("luma-proxy container does not exist");
        return false;
      }

      const isRunning = await this.dockerClient.containerIsRunning(
        "luma-proxy"
      );
      if (!isRunning) {
        this.log("luma-proxy container exists but is not running");
        return false;
      }

      this.log("luma-proxy container is running");
      return true;
    } catch (error) {
      this.logError(`Error checking luma-proxy status: ${error}`);
      return false;
    }
  }

  /**
   * Configure the luma-proxy to route traffic from a host to a target container
   * @param host The hostname to route traffic from (e.g., api.example.com)
   * @param targetContainer The container name to route traffic to
   * @param targetPort The port on the target container
   * @param projectName The name of the project (used for network connectivity)
   * @returns true if the configuration was successful
   */
  async configureProxy(
    host: string,
    targetContainer: string,
    targetPort: number,
    projectName: string
  ): Promise<boolean> {
    try {
      // Check if luma-proxy is running
      if (!(await this.isProxyRunning())) {
        this.logError(
          "Cannot configure proxy: luma-proxy container is not running"
        );
        return false;
      }

      this.log(
        `Configuring luma-proxy for host: ${host} -> ${targetContainer}:${targetPort}`
      );

      // Build the proxy configuration command (SSL certificates are now always attempted automatically)
      const proxyCmd = `luma-proxy deploy --host ${host} --target ${targetContainer}:${targetPort} --project ${projectName}`;

      // Execute the command in the luma-proxy container
      const execResult = await this.dockerClient.execInContainer(
        "luma-proxy",
        proxyCmd
      );

      if (execResult.success) {
        this.log(
          `Successfully configured luma-proxy for ${host} -> ${targetContainer}:${targetPort}`
        );
        return true;
      } else {
        this.logError(`Failed to configure luma-proxy: ${execResult.output}`);
        return false;
      }
    } catch (error) {
      this.logError(`Error configuring luma-proxy: ${error}`);
      return false;
    }
  }

  /**
   * Remove a host configuration from the luma-proxy
   * @param host The hostname to remove
   * @returns true if the removal was successful
   */
  async removeProxyConfig(host: string): Promise<boolean> {
    try {
      // Check if luma-proxy is running
      if (!(await this.isProxyRunning())) {
        this.logError(
          "Cannot remove proxy config: luma-proxy container is not running"
        );
        return false;
      }

      this.log(`Removing luma-proxy configuration for host: ${host}`);

      // Build the proxy removal command
      const proxyCmd = `luma-proxy remove --host ${host}`;

      // Execute the command in the luma-proxy container
      const execResult = await this.dockerClient.execInContainer(
        "luma-proxy",
        proxyCmd
      );

      if (execResult.success) {
        this.log(`Successfully removed luma-proxy configuration for ${host}`);
        return true;
      } else {
        this.logError(
          `Failed to remove luma-proxy configuration: ${execResult.output}`
        );
        return false;
      }
    } catch (error) {
      this.logError(`Error removing luma-proxy configuration: ${error}`);
      return false;
    }
  }

  /**
   * List all proxy configurations
   * @returns The output of the list command if successful, or null if it fails
   */
  async listProxyConfigs(): Promise<string | null> {
    try {
      // Check if luma-proxy is running
      if (!(await this.isProxyRunning())) {
        this.logError(
          "Cannot list proxy configs: luma-proxy container is not running"
        );
        return null;
      }

      this.log("Listing luma-proxy configurations");

      // Execute the list command in the luma-proxy container
      const execResult = await this.dockerClient.execInContainer(
        "luma-proxy",
        "luma-proxy list"
      );

      if (execResult.success) {
        return execResult.output;
      } else {
        this.logError(
          `Failed to list luma-proxy configurations: ${execResult.output}`
        );
        return null;
      }
    } catch (error) {
      this.logError(`Error listing luma-proxy configurations: ${error}`);
      return null;
    }
  }
}
