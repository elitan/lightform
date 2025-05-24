import { AppEntry, LumaSecrets } from "../config/types";
import { DockerClient, DockerContainerOptions } from "../docker";

export interface BlueGreenDeploymentOptions {
  appEntry: AppEntry;
  releaseId: string;
  secrets: LumaSecrets;
  projectName: string;
  networkName: string;
  dockerClient: DockerClient;
  serverHostname: string;
}

export interface BlueGreenDeploymentResult {
  success: boolean;
  newColor: "blue" | "green";
  deployedContainers: string[];
  error?: string;
}

/**
 * Generates blue-green container names based on app name, color, and replica count
 */
function generateContainerNames(
  appName: string,
  color: "blue" | "green",
  replicas: number
): string[] {
  if (replicas === 1) {
    return [`${appName}-${color}`];
  }

  const names: string[] = [];
  for (let i = 1; i <= replicas; i++) {
    names.push(`${appName}-${color}-${i}`);
  }
  return names;
}

/**
 * Creates container options for blue-green deployment
 */
function createBlueGreenContainerOptions(
  appEntry: AppEntry,
  releaseId: string,
  secrets: LumaSecrets,
  projectName: string,
  containerName: string
): DockerContainerOptions {
  const imageNameWithRelease = `${appEntry.image}:${releaseId}`;
  const envVars = resolveEnvironmentVariables(appEntry, secrets);

  return {
    name: containerName,
    image: imageNameWithRelease,
    ports: appEntry.ports,
    volumes: appEntry.volumes,
    envVars: envVars,
    network: `${projectName}-network`,
    networkAlias: appEntry.name, // Will be modified during deployment
    restart: "unless-stopped",
  };
}

/**
 * Resolves environment variables for a container from plain and secret sources
 */
function resolveEnvironmentVariables(
  entry: AppEntry,
  secrets: LumaSecrets
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
  appEntry: AppEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  projectName: string
): Promise<boolean> {
  console.log(
    `    [${serverHostname}] Performing health checks on ${containerNames.length} containers...`
  );

  const appPort = appEntry.proxy?.app_port || 80;
  const healthPromises = containerNames.map(async (containerName) => {
    try {
      // Wait for container to be ready
      const hcConfig = appEntry.health_check || {};
      const startPeriodSeconds = parseInt(hcConfig.start_period || "0s", 10);

      if (startPeriodSeconds > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, startPeriodSeconds * 1000)
        );
      }

      const result = await dockerClient.checkContainerEndpoint(
        containerName,
        true,
        projectName,
        appPort
      );

      const [healthCheckPassed] = result as [boolean, string];

      if (healthCheckPassed) {
        console.log(
          `    [${serverHostname}] Health check passed for ${containerName}`
        );
        return true;
      } else {
        console.error(
          `    [${serverHostname}] Health check failed for ${containerName}`
        );
        return false;
      }
    } catch (error) {
      console.error(
        `    [${serverHostname}] Health check error for ${containerName}:`,
        error
      );
      return false;
    }
  });

  const healthResults = await Promise.all(healthPromises);
  const allHealthy = healthResults.every((result) => result === true);

  if (allHealthy) {
    console.log(
      `    [${serverHostname}] All ${containerNames.length} containers passed health checks ✓`
    );
  } else {
    console.error(
      `    [${serverHostname}] Health checks failed for some containers`
    );
  }

  return allHealthy;
}

/**
 * Cleans up failed deployment containers
 */
async function cleanupFailedDeployment(
  containerNames: string[],
  dockerClient: DockerClient,
  serverHostname: string
): Promise<void> {
  console.log(
    `    [${serverHostname}] Cleaning up failed deployment containers...`
  );

  for (const containerName of containerNames) {
    try {
      await dockerClient.stopContainer(containerName);
      await dockerClient.removeContainer(containerName);
      console.log(
        `    [${serverHostname}] Removed failed container ${containerName}`
      );
    } catch (error) {
      console.warn(
        `    [${serverHostname}] Could not remove container ${containerName}:`,
        error
      );
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
    appEntry,
    releaseId,
    secrets,
    projectName,
    networkName,
    dockerClient,
    serverHostname,
  } = options;

  console.log(
    `    [${serverHostname}] Starting zero-downtime deployment for ${appEntry.name}...`
  );

  try {
    // Step 1: Determine deployment color
    const currentActiveColor = await dockerClient.getCurrentActiveColor(
      appEntry.name
    );
    const newColor = currentActiveColor === "blue" ? "green" : "blue";

    console.log(`    [${serverHostname}] Deploying new version...`);

    // Step 2: Generate container names for new deployment
    const replicas = appEntry.replicas || 1;
    const newContainerNames = generateContainerNames(
      appEntry.name,
      newColor,
      replicas
    );

    console.log(
      `    [${serverHostname}] Creating ${replicas} container(s): ${newContainerNames.join(
        ", "
      )}`
    );

    // Step 3: Create new containers
    const deployedContainers: string[] = [];

    for (let i = 0; i < newContainerNames.length; i++) {
      const containerName = newContainerNames[i];
      const replicaIndex = i + 1;

      const containerOptions = createBlueGreenContainerOptions(
        appEntry,
        releaseId,
        secrets,
        projectName,
        containerName
      );

      console.log(
        `    [${serverHostname}] Creating container ${containerName}...`
      );

      const success = await dockerClient.createContainerWithLabels(
        containerOptions,
        appEntry.name,
        newColor,
        replicaIndex,
        false // Not active yet
      );

      if (!success) {
        // Cleanup and abort
        await cleanupFailedDeployment(
          deployedContainers,
          dockerClient,
          serverHostname
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

    // Step 4: Health check all new containers
    const allHealthy = await performBlueGreenHealthChecks(
      newContainerNames,
      appEntry,
      dockerClient,
      serverHostname,
      projectName
    );

    if (!allHealthy) {
      await cleanupFailedDeployment(
        deployedContainers,
        dockerClient,
        serverHostname
      );
      return {
        success: false,
        newColor,
        deployedContainers: [],
        error: "Health checks failed for new containers",
      };
    }

    // Step 5: Switch network alias (zero-downtime transition)
    console.log(
      `    [${serverHostname}] Switching traffic to new version (zero downtime)...`
    );

    const aliasSwitch = await dockerClient.switchNetworkAlias(
      appEntry.name,
      newColor,
      networkName
    );

    if (!aliasSwitch) {
      await cleanupFailedDeployment(
        deployedContainers,
        dockerClient,
        serverHostname
      );
      return {
        success: false,
        newColor,
        deployedContainers: [],
        error: "Failed to switch network alias",
      };
    }

    // Step 6: Update labels to mark new containers as active
    await dockerClient.updateActiveLabels(appEntry.name, newColor);

    // Step 7: Graceful shutdown of old containers
    if (currentActiveColor) {
      const oldContainers = await dockerClient.findContainersByLabel(
        `luma.app=${appEntry.name}`
      );

      const oldActiveContainers = [];
      for (const containerName of oldContainers) {
        const labels = await dockerClient.getContainerLabels(containerName);
        if (labels["luma.color"] === currentActiveColor) {
          oldActiveContainers.push(containerName);
        }
      }

      if (oldActiveContainers.length > 0) {
        console.log(
          `    [${serverHostname}] Gracefully shutting down ${oldActiveContainers.length} old containers...`
        );
        await dockerClient.gracefulShutdown(oldActiveContainers, 30);

        // Remove old containers
        for (const containerName of oldActiveContainers) {
          try {
            await dockerClient.removeContainer(containerName);
            console.log(
              `    [${serverHostname}] Removed old container ${containerName}`
            );
          } catch (error) {
            console.warn(
              `    [${serverHostname}] Could not remove old container ${containerName}:`,
              error
            );
          }
        }
      }
    }

    console.log(
      `    [${serverHostname}] Zero-downtime deployment completed successfully ✅`
    );

    return {
      success: true,
      newColor,
      deployedContainers,
    };
  } catch (error) {
    console.error(`    [${serverHostname}] Deployment failed:`, error);
    return {
      success: false,
      newColor: "blue",
      deployedContainers: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
