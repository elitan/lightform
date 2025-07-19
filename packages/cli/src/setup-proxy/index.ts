import { DockerClient } from "../docker";
import { LightformConfig, LightformSecrets } from "../config/types";
import { SSHClient } from "../ssh";
import { loadConfig } from "../config";

// Constants
export const LIGHTFORM_PROXY_NAME = "lightform-proxy";
const DEFAULT_LIGHTFORM_PROXY_IMAGE = "elitan/lightform-proxy:latest";

/**
 * Check if the Lightform proxy is running and set it up if not
 * @param serverHostname The hostname of the server
 * @param sshClient SSH client connection
 * @param verbose Whether to show verbose output
 * @param forceUpdate Whether to force update the proxy even if it exists (default: false - only install if not present)
 */
export async function setupLightformProxy(
  serverHostname: string,
  sshClient: SSHClient,
  verbose: boolean = false,
  forceUpdate: boolean = false
): Promise<boolean> {
  try {
    if (verbose) {
      console.log(`[${serverHostname}] Checking Lightform proxy status...`);
    }

    // Get SSH client from Docker client (reusing existing SSH connection)
    const dockerClient = new DockerClient(sshClient, serverHostname, verbose);

    // Get config to check for custom proxy image
    const config = await loadConfig();
    const proxyImage = config.proxy?.image || DEFAULT_LIGHTFORM_PROXY_IMAGE;

    // Check if container exists
    const proxyExists = await dockerClient.containerExists(LIGHTFORM_PROXY_NAME);

    if (proxyExists) {
      if (forceUpdate) {
        if (verbose) {
          console.log(
            `[${serverHostname}] Lightform proxy already exists. Force updating to latest version...`
          );
          console.log(
            `[${serverHostname}] Stopping and removing existing proxy container...`
          );
        }

        // Backup state before updating container
        try {
          if (verbose) {
            console.log(`[${serverHostname}] Backing up proxy state before update...`);
          }
          
          // Ensure state directory exists on host
          await sshClient.exec("mkdir -p ~/.lightform/lightform-proxy-state");
          
          // Copy state from container to host if it exists
          const copyStateCmd = `docker cp ${LIGHTFORM_PROXY_NAME}:/var/lib/lightform-proxy/state.json ~/.lightform/lightform-proxy-state/state.json 2>/dev/null || echo "No existing state to backup"`;
          const backupResult = await sshClient.exec(copyStateCmd);
          
          if (verbose) {
            console.log(`[${serverHostname}] State backup result: ${backupResult.trim()}`);
          }
        } catch (error) {
          if (verbose) {
            console.log(`[${serverHostname}] Warning: Could not backup state: ${error}`);
          }
          // Continue with update anyway
        }

        // Stop and remove existing container to force update
        try {
          const proxyRunning = await dockerClient.containerIsRunning(
            LIGHTFORM_PROXY_NAME
          );
          if (proxyRunning) {
            await dockerClient.stopContainer(LIGHTFORM_PROXY_NAME);
          }
          await dockerClient.removeContainer(LIGHTFORM_PROXY_NAME);
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
          LIGHTFORM_PROXY_NAME
        );

        if (proxyRunning) {
          if (verbose) {
            console.log(
              `[${serverHostname}] Lightform proxy already exists and is running. Skipping setup.`
            );
          }
          return true;
        } else {
          if (verbose) {
            console.log(
              `[${serverHostname}] Lightform proxy exists but is not running. Starting it...`
            );
          }
          try {
            await dockerClient.startContainer(LIGHTFORM_PROXY_NAME);
            if (verbose) {
              console.log(
                `[${serverHostname}] Lightform proxy started successfully.`
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
      console.log(`[${serverHostname}] Setting up Lightform proxy...`);
      console.log(
        `[${serverHostname}] Force pulling latest Lightform proxy image from registry...`
      );
      console.log(
        `[${serverHostname}] Force pulling latest image ${proxyImage}...`
      );
    }

    const pullResult = await dockerClient.forcePullImage(proxyImage);

    if (!pullResult) {
      console.error(
        `[${serverHostname}] Failed to pull Lightform proxy image. Aborting setup.`
      );
      if (verbose) {
        console.error(
          `[${serverHostname}] If you are seeing "pull access denied" errors, you may need to use a different proxy image.`
        );
        console.error(
          `[${serverHostname}] You can configure a custom proxy image in your lightform.yml file:`
        );
        console.error(`[${serverHostname}] proxy:`);
        console.error(
          `[${serverHostname}]   image: "your-registry.com/your-proxy-image:tag"`
        );
      }
      return false;
    }

    // Ensure .lightform directories exist on the server before mounting
    if (verbose) {
      console.log(`[${serverHostname}] Creating .lightform directory structure...`);
    }
    try {
      await sshClient.exec("mkdir -p ~/.lightform/lightform-proxy-certs ~/.lightform/lightform-proxy-state");
      if (verbose) {
        console.log(`[${serverHostname}] .lightform directories created successfully.`);
      }
    } catch (error) {
      console.error(`[${serverHostname}] Failed to create .lightform directories: ${error}`);
      return false;
    }

    // Create container options
    const containerOptions = {
      name: LIGHTFORM_PROXY_NAME,
      image: proxyImage,
      ports: ["80:80", "443:443"],
      volumes: [
        "./.lightform/lightform-proxy-certs:/var/lib/lightform-proxy/certs",
        "./.lightform/lightform-proxy-state:/var/lib/lightform-proxy",
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
        `[${serverHostname}] Failed to create Lightform proxy container.`
      );
      return false;
    }

    // Verify the container actually exists and is running
    const containerExists = await dockerClient.containerExists(LIGHTFORM_PROXY_NAME);
    if (!containerExists) {
      console.error(
        `[${serverHostname}] Lightform proxy container was not created successfully despite no errors.`
      );
      return false;
    }

    const containerRunning = await dockerClient.containerIsRunning(
      LIGHTFORM_PROXY_NAME
    );
    if (!containerRunning) {
      console.error(
        `[${serverHostname}] Lightform proxy container exists but is not running.`
      );
      return false;
    }

    // Reconnect proxy to all project networks (needed after container recreation)
    try {
      if (verbose) {
        console.log(`[${serverHostname}] Reconnecting proxy to project networks...`);
      }
      
      // Find all project networks (they follow the pattern: {project-name}-network)
      const networksResult = await sshClient.exec('docker network ls --filter "name=-network" --format "{{.Name}}"');
      const projectNetworks = networksResult.trim().split('\n').filter(network => 
        network.trim() && network.endsWith('-network')
      );
      
      if (verbose) {
        console.log(`[${serverHostname}] Found project networks: ${projectNetworks.join(', ')}`);
      }
      
      // Connect proxy to each project network
      for (const networkName of projectNetworks) {
        try {
          // Check if already connected to avoid errors
          const isConnected = await dockerClient.isContainerConnectedToNetwork(
            LIGHTFORM_PROXY_NAME, 
            networkName
          );
          
          if (!isConnected) {
            await dockerClient.connectContainerToNetwork(LIGHTFORM_PROXY_NAME, networkName);
            if (verbose) {
              console.log(`[${serverHostname}] Connected proxy to network: ${networkName}`);
            }
          } else {
            if (verbose) {
              console.log(`[${serverHostname}] Proxy already connected to network: ${networkName}`);
            }
          }
        } catch (error) {
          if (verbose) {
            console.log(`[${serverHostname}] Warning: Could not connect to network ${networkName}: ${error}`);
          }
          // Continue with other networks
        }
      }
      
      if (verbose) {
        console.log(`[${serverHostname}] Network reconnection completed`);
      }
    } catch (error) {
      if (verbose) {
        console.log(`[${serverHostname}] Warning: Network reconnection failed: ${error}`);
      }
      // Don't fail the setup if network reconnection fails
    }

    if (verbose) {
      console.log(
        `[${serverHostname}] Lightform proxy has been successfully set up.`
      );
    }
    return true;
  } catch (error) {
    console.error(`[${serverHostname}] Failed to set up Lightform proxy: ${error}`);
    return false;
  }
}
