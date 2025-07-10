import { DockerClient } from "../docker";
import { SSHClient } from "../ssh";

/**
 * Client for interacting with the lightform-proxy service
 */
export class LightformProxyClient {
  private dockerClient: DockerClient;
  private serverHostname?: string;
  private verbose: boolean = false;

  /**
   * Create a new LightformProxyClient
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
   * Check if the lightform-proxy container is running
   * @returns true if the lightform-proxy container exists and is running
   */
  async isProxyRunning(): Promise<boolean> {
    try {
      const proxyExists = await this.dockerClient.containerExists("lightform-proxy");
      if (!proxyExists) {
        this.log("lightform-proxy container does not exist");
        return false;
      }

      const isRunning = await this.dockerClient.containerIsRunning(
        "lightform-proxy"
      );
      if (!isRunning) {
        this.log("lightform-proxy container exists but is not running");
        return false;
      }

      this.log("lightform-proxy container is running");
      return true;
    } catch (error) {
      this.logError(`Error checking lightform-proxy status: ${error}`);
      return false;
    }
  }

  /**
   * Configure the lightform-proxy to route traffic from a host to a target container
   * @param host The hostname to route traffic from (e.g., api.example.com)
   * @param targetContainer The container name to route traffic to
   * @param targetPort The port on the target container
   * @param projectName The name of the project (used for network connectivity)
   * @param healthPath The health check endpoint path (default: "/up")
   * @returns true if the configuration was successful
   */
  async configureProxy(
    host: string,
    targetContainer: string,
    targetPort: number,
    projectName: string,
    healthPath: string = "/up"
  ): Promise<boolean> {
    try {
      // Build the command arguments
      const args = [
        "deploy",
        "--host",
        host,
        "--target",
        `${targetContainer}:${targetPort}`,
        "--project",
        projectName,
        "--health-path",
        healthPath,
        "--ssl",
      ];

      const command = `/usr/local/bin/lightform-proxy ${args.join(" ")}`;
      const execResult = await this.dockerClient.execInContainer(
        "lightform-proxy",
        command
      );

      if (this.verbose) {
        this.log(`Proxy configuration result: ${execResult.output.trim()}`);
      }

      return (
        execResult.success ||
        execResult.output.includes("Added") ||
        execResult.output.includes("Updated") ||
        execResult.output.includes("Route deployed successfully") ||
        execResult.output.includes("successfully configured")
      );
    } catch (error) {
      if (this.verbose) {
        this.log(`Failed to configure proxy for ${host}: ${error}`);
      }
      return false;
    }
  }

  /**
   * Remove a host configuration from the lightform-proxy
   * @param host The hostname to remove
   * @returns true if the removal was successful
   */
  async removeProxyConfig(host: string): Promise<boolean> {
    try {
      // Check if lightform-proxy is running
      if (!(await this.isProxyRunning())) {
        this.logError(
          "Cannot remove proxy config: lightform-proxy container is not running"
        );
        return false;
      }

      this.log(`Removing lightform-proxy configuration for host: ${host}`);

      // Build the proxy removal command
      const proxyCmd = `lightform-proxy remove --host ${host}`;

      // Execute the command in the lightform-proxy container
      const execResult = await this.dockerClient.execInContainer(
        "lightform-proxy",
        proxyCmd
      );

      if (execResult.success) {
        this.log(`Successfully removed lightform-proxy configuration for ${host}`);
        return true;
      } else {
        this.logError(
          `Failed to remove lightform-proxy configuration: ${execResult.output}`
        );
        return false;
      }
    } catch (error) {
      this.logError(`Error removing lightform-proxy configuration: ${error}`);
      return false;
    }
  }

  /**
   * List all proxy configurations
   * @returns The output of the list command if successful, or null if it fails
   */
  async listProxyConfigs(): Promise<string | null> {
    try {
      // Check if lightform-proxy is running
      if (!(await this.isProxyRunning())) {
        this.logError(
          "Cannot list proxy configs: lightform-proxy container is not running"
        );
        return null;
      }

      this.log("Listing lightform-proxy configurations");

      // Execute the list command in the lightform-proxy container
      const execResult = await this.dockerClient.execInContainer(
        "lightform-proxy",
        "lightform-proxy list"
      );

      if (execResult.success) {
        return execResult.output;
      } else {
        this.logError(
          `Failed to list lightform-proxy configurations: ${execResult.output}`
        );
        return null;
      }
    } catch (error) {
      this.logError(`Error listing lightform-proxy configurations: ${error}`);
      return null;
    }
  }

  /**
   * Update the health status of a service in the proxy
   * @param host The hostname to update
   * @param healthy Whether the service is healthy
   * @returns true if the update was successful
   */
  async updateServiceHealth(host: string, healthy: boolean): Promise<boolean> {
    try {
      // Check if lightform-proxy is running
      if (!(await this.isProxyRunning())) {
        this.logError(
          "Cannot update service health: lightform-proxy container is not running"
        );
        return false;
      }

      this.log(
        `Updating health status for ${host}: ${
          healthy ? "healthy" : "unhealthy"
        }`
      );

      // Build the proxy update health command
      const healthStatus = healthy ? "true" : "false";
      const proxyCmd = `/usr/local/bin/lightform-proxy updatehealth --host ${host} --healthy ${healthStatus}`;

      // Execute the command in the lightform-proxy container
      const execResult = await this.dockerClient.execInContainer(
        "lightform-proxy",
        proxyCmd
      );

      if (execResult.success || execResult.output.includes("updated")) {
        this.log(
          `Successfully updated health status for ${host} to ${
            healthy ? "healthy" : "unhealthy"
          }`
        );
        return true;
      } else {
        this.logError(
          `Failed to update health status for ${host}: ${execResult.output}`
        );
        return false;
      }
    } catch (error) {
      this.logError(`Error updating health status for ${host}: ${error}`);
      return false;
    }
  }
}
