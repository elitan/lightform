import { DockerClient } from "../docker";
import { LumaConfig, LumaSecrets } from "../config/types";
import { SSHClient } from "../ssh";

// Constants
export const LUMA_PROXY_NAME = "luma-proxy";
const LUMA_PROXY_IMAGE = "elitan/luma-proxy:latest";

/**
 * Check if the Luma proxy is running and set it up if not
 */
export async function setupLumaProxy(
  serverHostname: string,
  sshClient: SSHClient
): Promise<boolean> {
  try {
    console.log(`[${serverHostname}] Checking Luma proxy status...`);

    // Get SSH client from Docker client (reusing existing SSH connection)
    const dockerClient = new DockerClient(sshClient, serverHostname);

    // Check if container exists
    const proxyExists = await dockerClient.containerExists(LUMA_PROXY_NAME);

    if (proxyExists) {
      // Check if it's running
      const proxyRunning = await dockerClient.containerIsRunning(
        LUMA_PROXY_NAME
      );

      if (proxyRunning) {
        console.log(`[${serverHostname}] Luma proxy is already running.`);
        return true;
      } else {
        console.log(
          `[${serverHostname}] Luma proxy exists but is not running. Starting it...`
        );
        await dockerClient.startContainer(LUMA_PROXY_NAME);
        return true;
      }
    }

    // If we get here, the proxy doesn't exist and needs to be created
    console.log(`[${serverHostname}] Setting up Luma proxy...`);

    // Force pull the latest image from remote registry
    console.log(
      `[${serverHostname}] Force pulling latest Luma proxy image from registry...`
    );
    await dockerClient.forcePullImage(LUMA_PROXY_IMAGE); // Ensures we get the latest version

    // Create container options
    const containerOptions = {
      name: LUMA_PROXY_NAME,
      image: LUMA_PROXY_IMAGE,
      // Add any other required options for the proxy
      ports: ["80:80", "443:443"], // Standard HTTP/HTTPS ports
      restart: "always",
    };

    // Create and start the container
    await dockerClient.createContainer(containerOptions);
    console.log(`[${serverHostname}] Luma proxy has been successfully set up.`);

    return true;
  } catch (error) {
    console.error(`[${serverHostname}] Failed to set up Luma proxy: ${error}`);
    return false;
  }
}
