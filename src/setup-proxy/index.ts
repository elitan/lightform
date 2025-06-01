import { DockerClient } from "../docker";
import { LumaConfig, LumaSecrets } from "../config/types";
import { SSHClient } from "../ssh";
import { loadConfig } from "../config";

// Constants
export const LUMA_PROXY_NAME = "luma-proxy";
const DEFAULT_LUMA_PROXY_IMAGE = "elitan/luma-proxy:latest";

/**
 * Check if the Luma proxy is running and set it up if not
 * @param serverHostname The hostname of the server
 * @param sshClient SSH client connection
 * @param verbose Whether to show verbose output
 * @param forceUpdate Whether to force update the proxy even if it exists (default: false - only install if not present)
 */
export async function setupLumaProxy(
  serverHostname: string,
  sshClient: SSHClient,
  verbose: boolean = false,
  forceUpdate: boolean = false
): Promise<boolean> {
  try {
    if (verbose) {
      console.log(`[${serverHostname}] Checking Luma proxy status...`);
    }

    // Get SSH client from Docker client (reusing existing SSH connection)
    const dockerClient = new DockerClient(sshClient, serverHostname, verbose);

    // Get config to check for custom proxy image
    const config = await loadConfig();
    const proxyImage = config.proxy?.image || DEFAULT_LUMA_PROXY_IMAGE;

    // Check if container exists
    const proxyExists = await dockerClient.containerExists(LUMA_PROXY_NAME);

    if (proxyExists) {
      if (forceUpdate) {
        if (verbose) {
          console.log(
            `[${serverHostname}] Luma proxy already exists. Force updating to latest version...`
          );
          console.log(
            `[${serverHostname}] Stopping and removing existing proxy container...`
          );
        }

        // Stop and remove existing container to force update
        try {
          const proxyRunning = await dockerClient.containerIsRunning(
            LUMA_PROXY_NAME
          );
          if (proxyRunning) {
            await dockerClient.stopContainer(LUMA_PROXY_NAME);
          }
          await dockerClient.removeContainer(LUMA_PROXY_NAME);
          if (verbose) {
            console.log(
              `[${serverHostname}] Existing proxy container removed successfully.`
            );
          }
        } catch (error) {
          console.error(
            `[${serverHostname}] Warning: Failed to remove existing proxy container: ${error}`
          );
          // Continue anyway - the force pull and create might still work
        }
      } else {
        // Check if proxy is running, if not start it
        const proxyRunning = await dockerClient.containerIsRunning(
          LUMA_PROXY_NAME
        );

        if (proxyRunning) {
          if (verbose) {
            console.log(
              `[${serverHostname}] Luma proxy already exists and is running. Skipping setup.`
            );
          }
          return true;
        } else {
          if (verbose) {
            console.log(
              `[${serverHostname}] Luma proxy exists but is not running. Starting it...`
            );
          }
          try {
            await dockerClient.startContainer(LUMA_PROXY_NAME);
            if (verbose) {
              console.log(
                `[${serverHostname}] Luma proxy started successfully.`
              );
            }
            return true;
          } catch (error) {
            console.error(
              `[${serverHostname}] Failed to start existing proxy container: ${error}`
            );
            // Continue to recreate the container
          }
        }
      }
    }

    // Force pull the latest image (whether container existed or not)
    if (verbose) {
      console.log(`[${serverHostname}] Setting up Luma proxy...`);
      console.log(
        `[${serverHostname}] Force pulling latest Luma proxy image from registry...`
      );
      console.log(
        `[${serverHostname}] Force pulling latest image ${proxyImage}...`
      );
    }

    const pullResult = await dockerClient.forcePullImage(proxyImage);

    if (!pullResult) {
      console.error(
        `[${serverHostname}] Failed to pull Luma proxy image. Aborting setup.`
      );
      if (verbose) {
        console.error(
          `[${serverHostname}] If you are seeing "pull access denied" errors, you may need to use a different proxy image.`
        );
        console.error(
          `[${serverHostname}] You can configure a custom proxy image in your luma.yml file:`
        );
        console.error(`[${serverHostname}] proxy:`);
        console.error(
          `[${serverHostname}]   image: "your-registry.com/your-proxy-image:tag"`
        );
      }
      return false;
    }

    // Create container options
    const containerOptions = {
      name: LUMA_PROXY_NAME,
      image: proxyImage,
      ports: ["80:80", "443:443"],
      volumes: [
        "./.luma/luma-proxy-certs:/var/lib/luma-proxy/certs",
        "./.luma/luma-proxy-config:/tmp",
        "/var/run/docker.sock:/var/run/docker.sock",
      ],
      restart: "always",
    };

    // Create and start the container
    const containerCreated = await dockerClient.createContainer(
      containerOptions
    );

    if (!containerCreated) {
      console.error(
        `[${serverHostname}] Failed to create Luma proxy container.`
      );
      return false;
    }

    // Verify the container actually exists and is running
    const containerExists = await dockerClient.containerExists(LUMA_PROXY_NAME);
    if (!containerExists) {
      console.error(
        `[${serverHostname}] Luma proxy container was not created successfully despite no errors.`
      );
      return false;
    }

    const containerRunning = await dockerClient.containerIsRunning(
      LUMA_PROXY_NAME
    );
    if (!containerRunning) {
      console.error(
        `[${serverHostname}] Luma proxy container exists but is not running.`
      );
      return false;
    }

    if (verbose) {
      console.log(
        `[${serverHostname}] Luma proxy has been successfully set up.`
      );
    }
    return true;
  } catch (error) {
    console.error(`[${serverHostname}] Failed to set up Luma proxy: ${error}`);
    return false;
  }
}
