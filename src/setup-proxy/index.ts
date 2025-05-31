import { DockerClient } from "../docker";
import { LumaConfig, LumaSecrets } from "../config/types";
import { SSHClient } from "../ssh";
import { loadConfig } from "../config";

// Constants
export const LUMA_PROXY_NAME = "luma-proxy";
const DEFAULT_LUMA_PROXY_IMAGE = "elitan/luma-proxy:latest";

/**
 * Ensure the .luma directory and subdirectories are owned by the SSH user
 */
async function ensureLumaDirectoryOwnership(
  sshClient: SSHClient,
  serverHostname: string,
  verbose: boolean = false
): Promise<void> {
  try {
    // Get the current SSH username
    const currentUser = await sshClient.exec("whoami");
    const username = currentUser.trim();

    if (verbose) {
      console.log(
        `[${serverHostname}] Ensuring .luma directory is owned by user: ${username}`
      );
    }

    // Create .luma directory and subdirectories if they don't exist
    await sshClient.exec(
      "mkdir -p ./.luma/luma-proxy-certs ./.luma/luma-proxy-config"
    );

    // Change ownership of .luma directory and all subdirectories to the SSH user
    await sshClient.exec(`sudo chown -R ${username}:${username} ./.luma`);

    if (verbose) {
      console.log(
        `[${serverHostname}] Successfully set ownership of .luma directory to ${username}`
      );
    }
  } catch (error) {
    if (verbose) {
      console.log(
        `[${serverHostname}] Warning: Could not change ownership of .luma directory: ${error}`
      );
      console.log(
        `[${serverHostname}] This may cause permission issues. Consider running 'sudo chown -R $(whoami):$(whoami) ./.luma' on the server.`
      );
    }
    // Don't throw - this is not critical enough to stop the setup process
  }
}

/**
 * Check if the Luma proxy is running and set it up if not
 */
export async function setupLumaProxy(
  serverHostname: string,
  sshClient: SSHClient,
  verbose: boolean = false
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
      // Check if it's running
      const proxyRunning = await dockerClient.containerIsRunning(
        LUMA_PROXY_NAME
      );

      if (proxyRunning) {
        if (verbose) {
          console.log(`[${serverHostname}] Luma proxy is already running.`);
        }
        return true;
      } else {
        if (verbose) {
          console.log(
            `[${serverHostname}] Luma proxy exists but is not running. Starting it...`
          );
        }
        await dockerClient.startContainer(LUMA_PROXY_NAME);
        return true;
      }
    }

    // If we get here, the proxy doesn't exist and needs to be created
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

    // Ensure .luma directory is owned by the SSH user before creating container
    await ensureLumaDirectoryOwnership(sshClient, serverHostname, verbose);

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
