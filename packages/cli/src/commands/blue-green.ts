import { ServiceEntry, IopSecrets } from "../config/types";
import { DockerClient, DockerContainerOptions } from "../docker";
import {
  serviceNeedsBuilding,
  getServiceImageName,
  buildServiceImageName,
} from "../utils/image-utils";
import { processVolumes } from "../utils";
import { ServiceFingerprint } from "../utils/service-fingerprint";

export interface BlueGreenDeploymentOptions {
  serviceEntry: ServiceEntry; // Now using unified ServiceEntry
  releaseId: string;
  secrets: IopSecrets;
  projectName: string;
  networkName: string;
  dockerClient: DockerClient;
  serverHostname: string;
  verbose?: boolean;
  fingerprint?: ServiceFingerprint; // Optional fingerprint for container labels
}

export interface BlueGreenDeploymentResult {
  success: boolean;
  newColor: "blue" | "green";
  deployedContainers: string[];
  error?: string;
}

/**
 * Generates blue-green container names based on project name, service name, color, and replica count
 */
function generateContainerNames(
  projectName: string,
  serviceName: string,
  color: "blue" | "green",
  replicas: number
): string[] {
  if (replicas === 1) {
    return [`${projectName}-${serviceName}-${color}`];
  }

  const names: string[] = [];
  for (let i = 1; i <= replicas; i++) {
    names.push(`${projectName}-${serviceName}-${color}-${i}`);
  }
  return names;
}

/**
 * Creates container options for blue-green deployment
 */
function createBlueGreenContainerOptions(
  serviceEntry: ServiceEntry,
  releaseId: string,
  secrets: IopSecrets,
  projectName: string,
  containerName: string,
  fingerprint?: ServiceFingerprint
): DockerContainerOptions {
  const imageNameWithRelease = buildServiceImageName(serviceEntry, releaseId);
  const envVars = resolveEnvironmentVariables(serviceEntry, secrets);

  // Dual alias approach: generic name for internal communication + project-specific for proxy routing
  const projectSpecificAlias = `${projectName}-${serviceEntry.name}`;

  return {
    name: containerName,
    image: imageNameWithRelease,
    ports: serviceEntry.ports,
    volumes: processVolumes(serviceEntry.volumes, projectName),
    envVars: envVars,
    network: `${projectName}-network`,
    networkAliases: [
      serviceEntry.name, // "web" - for internal project communication
      projectSpecificAlias, // "gmail-web" - for proxy routing
    ],
    restart: "unless-stopped",
    command: serviceEntry.command,
    labels: {
      "iop.managed": "true",
      "iop.project": projectName,
      "iop.type": "service",
      "iop.app": serviceEntry.name,
      // Add fingerprint labels if provided
      ...(fingerprint ? {
        "iop.fingerprint-type": fingerprint.type,
        "iop.config-hash": fingerprint.configHash,
        "iop.secrets-hash": fingerprint.secretsHash,
        ...(fingerprint.type === 'external' && fingerprint.imageReference && { 
          "iop.image-reference": fingerprint.imageReference 
        }),
      } : {}),
    },
  };
}

/**
 * Resolves environment variables for a container from plain and secret sources
 */
function resolveEnvironmentVariables(
  entry: ServiceEntry,
  secrets: IopSecrets
): Record<string, string> {
  const envVars: Record<string, string> = {};

  if (entry.environment?.plain) {
    for (const envVar of entry.environment.plain) {
      const [key, ...valueParts] = envVar.split("=");
      if (key && valueParts.length > 0) {
        envVars[key] = valueParts.join("=");
      }
    }
  }

  if (entry.environment?.secret) {
    for (const secretKey of entry.environment.secret) {
      if (secrets[secretKey] !== undefined) {
        envVars[secretKey] = secrets[secretKey];
      } else {
        console.warn(
          `Secret key "${secretKey}" for entry "${entry.name}" not found in loaded secrets.`
        );
      }
    }
  }

  return envVars;
}

/**
 * Performs health checks on all new containers
 */
async function performBlueGreenHealthChecks(
  containerNames: string[],
  serviceEntry: ServiceEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  projectName: string,
  verbose?: boolean
): Promise<boolean> {
  if (verbose) {
    console.log(
      `    [${serverHostname}] Running health checks for ${containerNames.length} containers...`
    );
  }

  const servicePort = serviceEntry.proxy?.app_port || 3000;
  const healthCheckPath = serviceEntry.health_check?.path || "/up";
  const healthPromises = containerNames.map(async (containerName) => {
    try {
      const healthCheckPassed =
        await dockerClient.checkHealthWithIopProxy(
          "iop-proxy",
          serviceEntry.name,
          containerName,
          projectName,
          servicePort,
          healthCheckPath
        );

      if (healthCheckPassed) {
        if (verbose) {
          console.log(
            `    [${serverHostname}] Health check passed for ${containerName}`
          );
        }
        return true;
      } else {
        if (verbose) {
          console.error(
            `    [${serverHostname}] Health check failed for ${containerName}`
          );
        }
        return false;
      }
    } catch (error) {
      if (verbose) {
        console.error(
          `    [${serverHostname}] Health check error for ${containerName}:`,
          error
        );
      }
      return false;
    }
  });

  const healthResults = await Promise.all(healthPromises);
  const allHealthy = healthResults.every((result) => result === true);

  if (allHealthy) {
    if (verbose) {
      console.log(
        `    [${serverHostname}] All ${containerNames.length} containers passed health checks ✓`
      );
    }
  } else {
    if (verbose) {
      console.error(
        `    [${serverHostname}] Health checks failed for some containers`
      );
    }
  }

  return allHealthy;
}

/**
 * Cleans up failed deployment containers
 */
async function cleanupFailedDeployment(
  containerNames: string[],
  dockerClient: DockerClient,
  serverHostname: string,
  verbose?: boolean
): Promise<void> {
  if (verbose) {
    console.log(
      `    [${serverHostname}] Cleaning up failed deployment containers...`
    );
  }

  for (const containerName of containerNames) {
    try {
      await dockerClient.stopContainer(containerName);
      await dockerClient.removeContainer(containerName);
      if (verbose) {
        console.log(
          `    [${serverHostname}] Removed failed container ${containerName}`
        );
      }
    } catch (error) {
      if (verbose) {
        console.warn(
          `    [${serverHostname}] Could not remove container ${containerName}:`,
          error
        );
      }
    }
  }
}

/**
 * Main zero-downtime deployment function
 */
export async function performBlueGreenDeployment(
  options: BlueGreenDeploymentOptions
): Promise<BlueGreenDeploymentResult> {
  const {
    serviceEntry, // Now directly using serviceEntry from interface
    releaseId,
    secrets,
    projectName,
    networkName,
    dockerClient,
    serverHostname,
    verbose = false,
    fingerprint,
  } = options;

  if (verbose) {
    console.log(
      `    [${serverHostname}] Starting zero-downtime deployment for ${serviceEntry.name}...`
    );
  }

  try {
    // Step 1: Determine deployment color
    const currentActiveColor =
      await dockerClient.getCurrentActiveColorForProject(
        serviceEntry.name,
        projectName
      );
    const newColor = currentActiveColor === "blue" ? "green" : "blue";

    if (verbose) {
      console.log(`    [${serverHostname}] Deploying new version...`);
    }

    // Step 2: Generate container names for new deployment
    const replicas = serviceEntry.replicas || 1;
    const newContainerNames = generateContainerNames(
      projectName,
      serviceEntry.name,
      newColor,
      replicas
    );

    if (verbose) {
      console.log(
        `    [${serverHostname}] Creating ${replicas} container(s): ${newContainerNames.join(
          ", "
        )}`
      );
    }

    // Step 2.5: Clean up any existing containers with the target color names
    // This handles cases where previous deployments failed and left containers behind
    if (verbose) {
      console.log(
        `    [${serverHostname}] Cleaning up existing ${newColor} containers...`
      );
    }

    for (const containerName of newContainerNames) {
      try {
        const exists = await dockerClient.containerExists(containerName);
        if (exists) {
          if (verbose) {
            console.log(
              `    [${serverHostname}] Removing existing container ${containerName}...`
            );
          }
          await dockerClient.stopContainer(containerName);
          await dockerClient.removeContainer(containerName);
        }
      } catch (error) {
        if (verbose) {
          console.warn(
            `    [${serverHostname}] Could not remove existing container ${containerName}: ${error}`
          );
        }
        // Continue despite cleanup errors - createContainer will give a more specific error if needed
      }
    }

    // Step 3: Create new containers
    const deployedContainers: string[] = [];

    for (let i = 0; i < newContainerNames.length; i++) {
      const containerName = newContainerNames[i];
      const replicaIndex = i + 1;

      const containerOptions = createBlueGreenContainerOptions(
        serviceEntry,
        releaseId,
        secrets,
        projectName,
        containerName,
        options.fingerprint
      );

      if (verbose) {
        console.log(
          `    [${serverHostname}] Creating container ${containerName}...`
        );
      }

      const success = await dockerClient.createContainerWithLabels(
        containerOptions,
        serviceEntry.name,
        newColor,
        replicaIndex,
        false // Not active yet
      );

      if (!success) {
        // Cleanup and abort
        await cleanupFailedDeployment(
          deployedContainers,
          dockerClient,
          serverHostname,
          verbose
        );
        return {
          success: false,
          newColor,
          deployedContainers: [],
          error: `Failed to create container ${containerName}`,
        };
      }

      deployedContainers.push(containerName);
    }

    // Step 4: Health check all new containers (only if ports are exposed)
    let allHealthy = true;
    
    if (serviceEntry.ports && serviceEntry.ports.length > 0) {
      if (verbose) {
        console.log(
          `    [${serverHostname}] Service exposes ports, performing health checks...`
        );
      }
      
      allHealthy = await performBlueGreenHealthChecks(
        newContainerNames,
        serviceEntry,
        dockerClient,
        serverHostname,
        projectName,
        verbose
      );

      if (!allHealthy) {
        await cleanupFailedDeployment(
          deployedContainers,
          dockerClient,
          serverHostname,
          verbose
        );
        return {
          success: false,
          newColor,
          deployedContainers: [],
          error: "Health checks failed for new containers",
        };
      }
    } else {
      if (verbose) {
        console.log(
          `    [${serverHostname}] Service has no exposed ports, skipping health checks (assuming healthy if running)`
        );
      }
    }

    // Step 5: Switch network alias (zero-downtime transition)
    // Only needed if there are existing containers to switch from
    if (currentActiveColor !== null) {
      if (verbose) {
        console.log(
          `    [${serverHostname}] Switching traffic to new version (zero downtime)...`
        );
      }

      const aliasSwitch = await dockerClient.switchNetworkAliasForProject(
        serviceEntry.name,
        newColor,
        networkName,
        projectName
      );

      if (!aliasSwitch) {
        await cleanupFailedDeployment(
          deployedContainers,
          dockerClient,
          serverHostname,
          verbose
        );
        return {
          success: false,
          newColor,
          deployedContainers: [],
          error: "Failed to switch network alias",
        };
      }
    } else {
      if (verbose) {
        console.log(
          `    [${serverHostname}] First deployment - network aliases already configured during container creation`
        );
      }
    }

    // Step 6: Update labels to mark new containers as active
    await dockerClient.updateActiveLabels(serviceEntry.name, newColor);

    // Step 7: Graceful shutdown of old containers
    if (currentActiveColor) {
      const oldContainers = await dockerClient.findContainersByLabelAndProject(
        `iop.app=${serviceEntry.name}`,
        projectName
      );

      const oldActiveContainers = [];
      for (const containerName of oldContainers) {
        const labels = await dockerClient.getContainerLabels(containerName);
        if (labels["iop.color"] === currentActiveColor) {
          oldActiveContainers.push(containerName);
        }
      }

      if (oldActiveContainers.length > 0) {
        if (verbose) {
          console.log(
            `    [${serverHostname}] Gracefully shutting down ${oldActiveContainers.length} old containers...`
          );
        }
        await dockerClient.gracefulShutdown(oldActiveContainers, 30);

        // Remove old containers
        for (const containerName of oldActiveContainers) {
          try {
            await dockerClient.removeContainer(containerName);
            if (verbose) {
              console.log(
                `    [${serverHostname}] Removed old container ${containerName}`
              );
            }
          } catch (error) {
            if (verbose) {
              console.warn(
                `    [${serverHostname}] Could not remove old container ${containerName}:`,
                error
              );
            }
          }
        }
      }
    }

    if (verbose) {
      console.log(
        `    [${serverHostname}] Zero-downtime deployment completed successfully ✅`
      );
    }

    return {
      success: true,
      newColor,
      deployedContainers,
    };
  } catch (error) {
    if (verbose) {
      console.error(`    [${serverHostname}] Deployment failed:`, error);
    }
    return {
      success: false,
      newColor: "blue",
      deployedContainers: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
