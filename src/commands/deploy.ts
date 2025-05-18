import { loadConfig } from "../config"; // Assuming loadConfig is exported from src/config/index.ts
import { loadSecrets } from "../config"; // Assuming loadSecrets is exported from src/config/index.ts
import {
  LumaConfig,
  AppEntry,
  ServiceEntry,
  HealthCheckConfig,
  LumaSecrets,
} from "../config/types";
import {
  DockerClient,
  DockerBuildOptions,
  DockerContainerOptions,
} from "../docker"; // Updated path and name
import { SSHClient, SSHClientOptions, getSSHCredentials } from "../ssh"; // Updated to import the utility function
import { generateReleaseId } from "../utils"; // Changed path
import { execSync } from "child_process";

// Helper to resolve environment variables for a container
function resolveEnvironmentVariables(
  entry: AppEntry | ServiceEntry,
  secrets: LumaSecrets
): Record<string, string> {
  const envVars: Record<string, string> = {};
  if (entry.environment?.plain) {
    for (const [key, value] of Object.entries(entry.environment.plain)) {
      envVars[key] = value;
    }
  }
  if (entry.environment?.secret) {
    for (const secretKey of entry.environment.secret) {
      if (secrets[secretKey] !== undefined) {
        envVars[secretKey] = secrets[secretKey];
      } else {
        console.warn(
          `Secret key "${secretKey}" for entry "${entry.name}" not found in loaded secrets. It will not be set as an environment variable.`
        );
      }
    }
  }
  return envVars;
}

// Function to check for uncommitted changes in the working directory
async function hasUncommittedChanges(): Promise<boolean> {
  try {
    const status = execSync("git status --porcelain").toString().trim();
    return status.length > 0;
  } catch (error) {
    console.warn(
      "Failed to check git status. Assuming no uncommitted changes."
    );
    return false;
  }
}

// Helper to create DockerContainerOptions for an AppEntry
function appEntryToContainerOptions(
  appEntry: AppEntry,
  releaseId: string,
  secrets: LumaSecrets,
  projectName: string
): DockerContainerOptions {
  const imageNameWithRelease = `${appEntry.image}:${releaseId}`;
  const containerName = `${appEntry.name}-${releaseId}`;
  const envVars = resolveEnvironmentVariables(appEntry, secrets);

  return {
    name: containerName,
    image: imageNameWithRelease,
    ports: appEntry.ports,
    volumes: appEntry.volumes,
    envVars: envVars,
    network: `${projectName}-network`, // Assumes network is named project_name-network
    restart: "unless-stopped", // Default restart policy for apps
    // TODO: Add healthcheck options if DockerContainerOptions supports them directly,
    // or handle healthcheck separately after container start.
    // Dockerode, for example, allows specifying Healthcheck in HostConfig
  };
}

// Helper to create DockerContainerOptions for a ServiceEntry
function serviceEntryToContainerOptions(
  serviceEntry: ServiceEntry,
  secrets: LumaSecrets,
  projectName: string
): DockerContainerOptions {
  const containerName = serviceEntry.name; // Services use their simple name
  const envVars = resolveEnvironmentVariables(serviceEntry, secrets);

  return {
    name: containerName,
    image: serviceEntry.image, // Includes tag, e.g., "postgres:15"
    ports: serviceEntry.ports,
    volumes: serviceEntry.volumes,
    envVars: envVars,
    network: `${projectName}-network`, // Assumes network is named project_name-network
    restart: "unless-stopped", // Default restart policy for services
  };
}

// Convert object or array format to a normalized array of entries with names
function normalizeConfigEntries(
  entries: Record<string, any> | Array<any> | undefined
): Array<any> {
  if (!entries) return [];

  // If it's already an array, return it
  if (Array.isArray(entries)) {
    return entries;
  }

  // If it's an object, convert to array with name property
  return Object.entries(entries).map(([name, entry]) => ({
    ...entry,
    name,
  }));
}

export async function deployCommand(rawEntryNamesAndFlags: string[]) {
  console.log("Deploy command initiated with raw args:", rawEntryNamesAndFlags);

  // Check for --force flag
  const forceFlag = rawEntryNamesAndFlags.includes("--force");

  // Filter out flags
  const entryNames = rawEntryNamesAndFlags.filter(
    (name) => name !== "--services" && name !== "--force"
  );

  // Check for uncommitted changes
  if (!forceFlag && (await hasUncommittedChanges())) {
    console.error(
      "ERROR: Uncommitted changes detected in working directory. Deployment aborted for safety.\n" +
        "Please commit your changes before deploying, or use --force to deploy anyway."
    );
    return;
  }

  // Detect --services flag
  const deployServicesFlag = rawEntryNamesAndFlags.includes("--services");

  if (deployServicesFlag) {
    console.log(
      "Service deployment explicitly requested (--services flag detected)."
    );
  } else {
    console.log("Defaulting to app deployment (no --services flag detected).");
  }

  let config: LumaConfig;
  let secrets: LumaSecrets;
  try {
    config = await loadConfig();
    secrets = await loadSecrets();
    console.log("Configuration and secrets loaded successfully.");
  } catch (error) {
    console.error("Failed to load or validate configuration/secrets:", error);
    return;
  }

  // 2. Identify target entries based on flags and names
  const configuredApps = normalizeConfigEntries(config.apps);
  const configuredServices = normalizeConfigEntries(config.services);
  let targetEntries: (AppEntry | ServiceEntry)[] = [];

  if (deployServicesFlag) {
    // --services flag is present: Target services
    if (entryNames.length === 0) {
      // No specific service names given with --services, target all services
      targetEntries = [...configuredServices];
      if (targetEntries.length === 0) {
        console.log("No services found in configuration to deploy.");
        return;
      }
      console.log("Targeting all services for deployment.");
    } else {
      // Specific names given with --services, filter only services
      entryNames.forEach((name) => {
        const service = configuredServices.find((s) => s.name === name);
        if (service) {
          targetEntries.push(service);
        } else {
          console.warn(
            `Service "${name}" not found in configuration or "${name}" is not a service. It will be ignored.`
          );
        }
      });
      if (targetEntries.length === 0) {
        console.log(
          "No valid services found for specified names with --services flag."
        );
        return;
      }
      console.log(
        "Targeting specified services for deployment:",
        targetEntries.map((e) => e.name).join(", ")
      );
    }
  } else {
    // --services flag is NOT present: Target apps
    if (entryNames.length === 0) {
      // No specific app names given, target all apps
      targetEntries = [...configuredApps];
      if (targetEntries.length === 0) {
        console.log("No apps found in configuration to deploy by default.");
        return;
      }
      console.log("Targeting all apps for deployment by default.");
    } else {
      // Specific names given, filter only apps
      entryNames.forEach((name) => {
        const app = configuredApps.find((a) => a.name === name);
        if (app) {
          targetEntries.push(app);
        } else {
          console.warn(
            `App "${name}" not found in configuration or "${name}" is not an app. It will be ignored.`
          );
        }
      });
      if (targetEntries.length === 0) {
        console.log("No valid apps found for specified names.");
        return;
      }
      console.log(
        "Targeting specified apps for deployment:",
        targetEntries.map((e) => e.name).join(", ")
      );
    }
  }

  if (targetEntries.length === 0) {
    console.log("No entries selected for deployment. Exiting.");
    return;
  }

  const releaseId = await generateReleaseId();
  console.log(
    `Generated Release ID for this run: ${releaseId} (used primarily for apps)`
  );

  const projectName = config.name;

  for (const entry of targetEntries) {
    const globalRegistryConfig = config.docker;
    const isApp =
      configuredApps.some((app) => app.name === entry.name) &&
      !deployServicesFlag;
    // The above isApp check could be simplified if targetEntries is guaranteed to be homogenous
    // For instance, after targeting, we know if we are in app-mode or service-mode.
    // Let's refine isApp based on the deployServicesFlag for clarity

    // If deployServicesFlag is true, all entries in targetEntries *should* be services.
    // If deployServicesFlag is false, all entries in targetEntries *should* be apps.
    const currentEntryIsApp = !deployServicesFlag; // Simplified assumption after filtering

    if (currentEntryIsApp) {
      const appEntry = entry as AppEntry;
      const imageNameWithRelease = `${appEntry.image}:${releaseId}`;
      const containerName = `${appEntry.name}-${releaseId}`; // Define containerName for app here
      console.log(
        `Deploying app: ${
          appEntry.name
        } (release ${releaseId}) to servers: ${appEntry.servers.join(", ")}`
      );

      let imageSuccessfullyBuiltOrTagged = false;

      // App Handling: Build, Tag, Push locally
      if (appEntry.build) {
        console.log(`  Building app ${appEntry.name}...`);
        try {
          // Ensure platform is set to avoid architecture mismatch during deployment
          const buildPlatform = appEntry.build.platform || "linux/amd64"; // Default to amd64 if not specified

          if (!appEntry.build.platform) {
            console.log(
              `  No platform specified, defaulting to ${buildPlatform} for cross-platform compatibility`
            );
          }

          await DockerClient.build({
            // Use static method
            context: appEntry.build.context,
            dockerfile: appEntry.build.dockerfile,
            tags: [imageNameWithRelease],
            buildArgs: appEntry.build.args,
            platform: buildPlatform, // Use the determined platform
            target: appEntry.build.target, // Assuming target can be in build config
          });
          console.log(
            `  Successfully built and tagged ${imageNameWithRelease}`
          );
          imageSuccessfullyBuiltOrTagged = true;
        } catch (error) {
          console.error(`  Failed to build app ${appEntry.name}:`, error);
          continue; // Skip to next entry if build fails
        }
      } else {
        // No build config, assume pre-built image. Tag it locally.
        console.log(
          `  No build config for ${appEntry.name}. Assuming pre-built image: ${appEntry.image}.`
        );
        console.log(
          `  Tagging ${appEntry.image} as ${imageNameWithRelease}...`
        );
        try {
          await DockerClient.tag(appEntry.image, imageNameWithRelease); // Use static method
          console.log(
            `  Successfully tagged ${appEntry.image} as ${imageNameWithRelease}`
          );
          imageSuccessfullyBuiltOrTagged = true;
        } catch (error) {
          console.error(
            `  Failed to tag pre-built image ${appEntry.image} for app ${appEntry.name}:`,
            error
          );
          continue; // Skip to next entry if tagging fails
        }
      }

      if (!imageSuccessfullyBuiltOrTagged) continue; // Should not happen if logic above is correct

      // Push the image
      console.log(`  Pushing image ${imageNameWithRelease}...`);
      try {
        // Determine registry for push
        const registryToPush =
          appEntry.registry?.url || config.docker?.registry;
        await DockerClient.push(imageNameWithRelease, registryToPush); // Use static method
        console.log(
          `  Successfully pushed ${imageNameWithRelease} to ${
            registryToPush || "default registry"
          }`
        );
      } catch (error) {
        console.error(
          `  Failed to push image ${imageNameWithRelease} for app ${appEntry.name}:`,
          error
        );
        continue; // Skip to next entry if push fails
      }

      // Per-server deployment for App
      for (const serverHostname of appEntry.servers) {
        console.log(
          `  Deploying app ${appEntry.name} to server ${serverHostname}...`
        );
        let sshClient: SSHClient | undefined;
        try {
          const sshCreds = await getSSHCredentials(
            serverHostname,
            config,
            secrets
          );
          if (!sshCreds.host) sshCreds.host = serverHostname;
          sshClient = await SSHClient.create(sshCreds as SSHClientOptions);
          await sshClient.connect();
          console.log(`    [${serverHostname}] SSH connection established.`);
          const dockerClientRemote = new DockerClient(
            sshClient,
            serverHostname
          );

          const containerOptions = appEntryToContainerOptions(
            appEntry,
            releaseId,
            secrets,
            projectName
          );

          const appRegistry = appEntry.registry;
          let appImageRegistry =
            appRegistry?.url || globalRegistryConfig?.registry || "docker.io";

          let registryLoginPerformed = false;

          if (appRegistry?.username && appRegistry?.password_secret) {
            const password = secrets[appRegistry.password_secret];
            if (password) {
              console.log(
                `    [${serverHostname}] Logging into app-specific registry: ${appImageRegistry}`
              );
              try {
                await dockerClientRemote.login(
                  appImageRegistry,
                  appRegistry.username,
                  password
                );
                console.log(
                  `    [${serverHostname}] Successfully logged into registry`
                );
                registryLoginPerformed = true;
              } catch (loginError) {
                // Check if the error is just the unencrypted warning
                const errorMessage =
                  typeof loginError === "object" && loginError !== null
                    ? String(loginError)
                    : "Unknown error";

                if (
                  errorMessage.includes(
                    "WARNING! Your password will be stored unencrypted"
                  )
                ) {
                  // This is just a warning, not an actual error - login was successful
                  console.log(
                    `    [${serverHostname}] Login successful (with warning about unencrypted storage)`
                  );
                  registryLoginPerformed = true;
                } else {
                  // This is a real error
                  console.error(
                    `    [${serverHostname}] Failed to login to registry:`,
                    loginError
                  );
                  // Continue anyway as the image might be public or pre-authenticated
                }
              }
            } else {
              console.warn(
                `    [${serverHostname}] Secret ${appRegistry.password_secret} for app registry not found. Assuming public image or pre-existing login.`
              );
            }
          } else if (
            globalRegistryConfig?.username &&
            secrets.DOCKER_REGISTRY_PASSWORD
          ) {
            // General DOCKER_REGISTRY_PASSWORD for global config
            console.log(
              `    [${serverHostname}] Logging into global Docker registry: ${
                globalRegistryConfig.registry || "docker.io"
              }`
            );
            try {
              await dockerClientRemote.login(
                appImageRegistry,
                globalRegistryConfig.username,
                secrets.DOCKER_REGISTRY_PASSWORD
              );
              console.log(
                `    [${serverHostname}] Successfully logged into registry`
              );
              registryLoginPerformed = true;
            } catch (loginError) {
              // Check if the error is just the unencrypted warning
              const errorMessage =
                typeof loginError === "object" && loginError !== null
                  ? String(loginError)
                  : "Unknown error";

              if (
                errorMessage.includes(
                  "WARNING! Your password will be stored unencrypted"
                )
              ) {
                // This is just a warning, not an actual error - login was successful
                console.log(
                  `    [${serverHostname}] Login successful (with warning about unencrypted storage)`
                );
                registryLoginPerformed = true;
              } else {
                // This is a real error
                console.error(
                  `    [${serverHostname}] Failed to login to registry:`,
                  loginError
                );
                // Continue anyway as the image might be public or pre-authenticated
              }
            }
          } // Else: relying on pre-configured login on the server or public images

          console.log(
            `    [${serverHostname}] Pulling image ${imageNameWithRelease}...`
          );
          const pullSuccess = await dockerClientRemote.pullImage(
            imageNameWithRelease
          );

          // Logout after pulling to avoid storing credentials
          if (registryLoginPerformed) {
            console.log(
              `    [${serverHostname}] Logging out from registry to avoid storing credentials...`
            );
            await dockerClientRemote.logout(appImageRegistry);
          }

          if (!pullSuccess) {
            console.error(
              `    [${serverHostname}] Failed to pull image ${imageNameWithRelease}. Skipping deployment to this server.`
            );
            continue;
          }

          console.log(
            `    [${serverHostname}] Starting new container ${containerName}...`
          ); // Now containerName is in scope

          // Check if container with same name already exists and is running
          const containerExists = await dockerClientRemote.containerExists(
            containerName
          );
          if (containerExists) {
            const containerRunning =
              await dockerClientRemote.containerIsRunning(containerName);
            if (containerRunning) {
              console.log(
                `    [${serverHostname}] Container ${containerName} is already running. Skipping deployment.`
              );
              // Continue with other servers/entries
              continue;
            } else {
              // Container exists but not running - remove it first
              console.log(
                `    [${serverHostname}] Container ${containerName} exists but is not running. Removing it...`
              );
              await dockerClientRemote.removeContainer(containerName);
            }
          }

          const createSuccessApp = await dockerClientRemote.createContainer(
            containerOptions
          );
          if (!createSuccessApp) {
            console.error(
              `    [${serverHostname}] Failed to create container ${containerName}. Skipping further steps for this app on this server.`
            ); // containerName is in scope
            continue;
          }

          let newAppIsHealthy = false;

          // First, always check the /up endpoint as a required Luma check
          console.log(
            `    [${serverHostname}] Performing /up endpoint health check for ${containerName}...`
          );

          // Set up retry parameters with fixed values for the /up check
          // Check every 1 second for up to 60 seconds
          const upCheckMaxAttempts = 60;
          const upCheckIntervalSeconds = 1;

          // We'll still use the start period from config if available
          const hcConfig = appEntry.health_check || {};
          const startPeriodSeconds = parseInt(
            hcConfig.start_period || "0s",
            10
          ); // Default 0s

          if (startPeriodSeconds > 0) {
            console.log(
              `    [${serverHostname}] Waiting for start period: ${startPeriodSeconds}s...`
            );
            await new Promise((resolve) =>
              setTimeout(resolve, startPeriodSeconds * 1000)
            );
          }

          // Create a single reusable helper container for all health checks
          console.log(
            `    [${serverHostname}] Creating health check helper container...`
          );

          let helperContainerName = "";
          let initialCheckResult = false;

          try {
            // Initial health check with reusable container
            console.log(
              `    [${serverHostname}] Initial health check setup for ${containerName}...`
            );
            const result = (await dockerClientRemote.checkContainerEndpoint(
              containerName,
              true // Create a reusable container
            )) as [boolean, string];

            initialCheckResult = result[0];
            helperContainerName = result[1];

            console.log(
              `    [${serverHostname}] Helper container name: ${helperContainerName}`
            );

            if (!helperContainerName) {
              console.error(
                `    [${serverHostname}] Failed to create valid helper container. Aborting health checks.`
              );
              newAppIsHealthy = false; // Cannot proceed with health checks
            } else if (initialCheckResult) {
              // First check was successful
              newAppIsHealthy = true;
              console.log(
                `    [${serverHostname}] /up endpoint check successful on first attempt`
              );
            } else {
              // Need to keep checking
              console.log(
                `    [${serverHostname}] First health check failed, continuing with repeated checks...`
              );

              // Perform the required /up endpoint check (starting from attempt 2)
              for (let i = 1; i < upCheckMaxAttempts; i++) {
                // Only log the attempt every 5 attempts to reduce verbosity
                if (i % 5 === 0 || i === upCheckMaxAttempts - 1) {
                  console.log(
                    `    [${serverHostname}] /up endpoint check attempt ${
                      i + 1
                    }/${upCheckMaxAttempts} for ${containerName}...`
                  );
                }

                if (!helperContainerName) {
                  console.error(
                    `    [${serverHostname}] Invalid helper container name. Aborting health checks.`
                  );
                  break;
                }

                const isHealthy =
                  await dockerClientRemote.checkHealthWithExistingHelper(
                    helperContainerName,
                    containerName
                  );

                if (isHealthy) {
                  newAppIsHealthy = true;
                  console.log(
                    `    [${serverHostname}] /up endpoint check successful for ${containerName} after ${
                      i + 1
                    } attempts`
                  );
                  break;
                }

                if (i < upCheckMaxAttempts - 1) {
                  // No need to log waiting messages as we're checking every second
                  await new Promise((resolve) =>
                    setTimeout(resolve, upCheckIntervalSeconds * 1000)
                  );
                }
              }
            }

            // Additionally, check Docker's built-in health check if configured
            if (newAppIsHealthy && appEntry.health_check) {
              // Use parameters from config for Docker's health check
              const dockerHcRetries = hcConfig.retries || 3;
              const dockerHcIntervalSeconds = parseInt(
                hcConfig.interval || "10s",
                10
              );

              console.log(
                `    [${serverHostname}] Also checking Docker's built-in health status for ${containerName}...`
              );

              // Use Docker's built-in health check as an additional check
              for (let i = 0; i < dockerHcRetries; i++) {
                console.log(
                  `    [${serverHostname}] Docker health check attempt ${
                    i + 1
                  }/${dockerHcRetries} for ${containerName}...`
                );
                const healthStatus =
                  await dockerClientRemote.getContainerHealth(containerName);

                if (healthStatus === "healthy") {
                  console.log(
                    `    [${serverHostname}] Docker reports container ${containerName} is healthy.`
                  );
                  break;
                }

                if (healthStatus === "unhealthy") {
                  console.error(
                    `    [${serverHostname}] Docker reports container ${containerName} is unhealthy. This is concerning but we'll continue since the /up check passed.`
                  );
                  break;
                }

                // If status is 'starting' or null, keep trying.
                if (i < dockerHcRetries - 1) {
                  await new Promise((resolve) =>
                    setTimeout(resolve, dockerHcIntervalSeconds * 1000)
                  );
                }
              }
            }
          } finally {
            // Always clean up the helper container
            if (helperContainerName) {
              console.log(
                `    [${serverHostname}] Cleaning up health check helper container...`
              );
              await dockerClientRemote.cleanupHelperContainer(
                helperContainerName
              );
            }
          }

          if (!newAppIsHealthy) {
            console.error(
              `    [${serverHostname}] Container ${containerName} failed the required /up endpoint check. Deployment cannot proceed.`
            );
          }

          if (!newAppIsHealthy) {
            console.error(
              `    [${serverHostname}] New container ${containerName} for app ${appEntry.name} did not become healthy. Stopping and removing it.`
            );
            try {
              await dockerClientRemote.stopContainer(containerName);
              await dockerClientRemote.removeContainer(containerName);
              console.log(
                `    [${serverHostname}] New unhealthy container ${containerName} stopped and removed.`
              );
            } catch (cleanupError) {
              console.error(
                `    [${serverHostname}] Error cleaning up unhealthy container ${containerName}:`,
                cleanupError
              );
            }
            continue; // Skip to next server or entry if health check failed
          }

          // If new app is healthy, proceed to stop old containers and track release
          console.log(
            `    [${serverHostname}] New app container ${containerName} is healthy. Proceeding with deployment finalization.`
          );

          // Find previous deployment containers for this app
          console.log(
            `    [${serverHostname}] Looking for previous deployments of ${appEntry.name}...`
          );

          const previousContainers =
            await dockerClientRemote.findContainersByPrefix(
              `${appEntry.name}-`
            );

          // Filter out the current container
          const oldContainers = previousContainers.filter(
            (name) => name !== containerName
          );

          if (oldContainers.length > 0) {
            console.log(
              `    [${serverHostname}] Found ${
                oldContainers.length
              } previous deployment(s) to clean up: ${oldContainers.join(", ")}`
            );

            // Stop and remove each old container
            for (const oldContainer of oldContainers) {
              console.log(
                `    [${serverHostname}] Stopping and removing old container ${oldContainer}...`
              );
              try {
                await dockerClientRemote.stopContainer(oldContainer);
                await dockerClientRemote.removeContainer(oldContainer);
                console.log(
                  `    [${serverHostname}] Old container ${oldContainer} stopped and removed.`
                );
              } catch (stopOldError) {
                console.warn(
                  `    [${serverHostname}] Could not stop/remove old container ${oldContainer}. It might have already been stopped/removed.`,
                  stopOldError
                );
              }
            }
          } else {
            console.log(
              `    [${serverHostname}] No previous deployments found for ${appEntry.name} to clean up.`
            );
          }

          // Prune for app server
          console.log(`    [${serverHostname}] Pruning Docker resources...`);
          await dockerClientRemote.prune();

          console.log(
            `    [${serverHostname}] App ${appEntry.name} (release ${releaseId}) deployed successfully to this server.`
          );
        } catch (serverError) {
          console.error(
            `  [${serverHostname}] Failed to deploy app ${appEntry.name} to server:`,
            serverError
          );
        } finally {
          if (sshClient) {
            await sshClient.close();
            console.log(`    [${serverHostname}] SSH connection closed.`);
          }
        }
      }
    } else {
      // It's a Service
      const serviceEntry = entry as ServiceEntry;
      const containerNameForService = serviceEntry.name; // Define containerName for service here
      console.log(
        `Deploying service: ${
          serviceEntry.name
        } to servers: ${serviceEntry.servers.join(", ")}`
      );

      for (const serverHostname of serviceEntry.servers) {
        console.log(
          `  Deploying service ${serviceEntry.name} to server ${serverHostname}...`
        );
        let sshClient: SSHClient | undefined;
        try {
          const sshCreds = await getSSHCredentials(
            serverHostname,
            config,
            secrets
          );
          if (!sshCreds.host) sshCreds.host = serverHostname;
          sshClient = await SSHClient.create(sshCreds as SSHClientOptions);
          await sshClient.connect();
          console.log(`    [${serverHostname}] SSH connection established.`);
          const dockerClientRemote = new DockerClient(
            sshClient,
            serverHostname
          );
          const imageToPull = serviceEntry.image;

          const serviceContainerOptions = serviceEntryToContainerOptions(
            serviceEntry,
            secrets,
            projectName
          );

          const serviceRegistry = serviceEntry.registry;
          let serviceImageRegistry =
            serviceRegistry?.url ||
            globalRegistryConfig?.registry ||
            "docker.io";

          let registryLoginPerformed = false;

          if (serviceRegistry?.username && serviceRegistry?.password_secret) {
            const password = secrets[serviceRegistry.password_secret];
            if (password) {
              console.log(
                `    [${serverHostname}] Logging into service-specific registry: ${serviceImageRegistry}`
              );
              try {
                await dockerClientRemote.login(
                  serviceImageRegistry,
                  serviceRegistry.username,
                  password
                );
                console.log(
                  `    [${serverHostname}] Successfully logged into registry`
                );
                registryLoginPerformed = true;
              } catch (loginError) {
                // Check if the error is just the unencrypted warning
                const errorMessage =
                  typeof loginError === "object" && loginError !== null
                    ? String(loginError)
                    : "Unknown error";

                if (
                  errorMessage.includes(
                    "WARNING! Your password will be stored unencrypted"
                  )
                ) {
                  // This is just a warning, not an actual error - login was successful
                  console.log(
                    `    [${serverHostname}] Login successful (with warning about unencrypted storage)`
                  );
                  registryLoginPerformed = true;
                } else {
                  // This is a real error
                  console.error(
                    `    [${serverHostname}] Failed to login to registry:`,
                    loginError
                  );
                  // Continue anyway as the image might be public or pre-authenticated
                }
              }
            } else {
              console.warn(
                `    [${serverHostname}] Secret ${serviceRegistry.password_secret} for service registry not found. Assuming public image or pre-existing login.`
              );
            }
          } else if (
            globalRegistryConfig?.username &&
            secrets.DOCKER_REGISTRY_PASSWORD
          ) {
            console.log(
              `    [${serverHostname}] Logging into global Docker registry: ${
                globalRegistryConfig.registry || "docker.io"
              }`
            );
            try {
              await dockerClientRemote.login(
                serviceImageRegistry,
                globalRegistryConfig.username,
                secrets.DOCKER_REGISTRY_PASSWORD
              );
              console.log(
                `    [${serverHostname}] Successfully logged into registry`
              );
              registryLoginPerformed = true;
            } catch (loginError) {
              // Check if the error is just the unencrypted warning
              const errorMessage =
                typeof loginError === "object" && loginError !== null
                  ? String(loginError)
                  : "Unknown error";

              if (
                errorMessage.includes(
                  "WARNING! Your password will be stored unencrypted"
                )
              ) {
                // This is just a warning, not an actual error - login was successful
                console.log(
                  `    [${serverHostname}] Login successful (with warning about unencrypted storage)`
                );
                registryLoginPerformed = true;
              } else {
                // This is a real error
                console.error(
                  `    [${serverHostname}] Failed to login to registry:`,
                  loginError
                );
                // Continue anyway as the image might be public or pre-authenticated
              }
            }
          } // Else: relying on pre-configured login on the server or public images

          console.log(
            `    [${serverHostname}] Pulling image ${imageToPull}...`
          );
          const pullServiceSuccess = await dockerClientRemote.pullImage(
            imageToPull
          );

          // Logout after pulling to avoid storing credentials
          if (registryLoginPerformed) {
            console.log(
              `    [${serverHostname}] Logging out from registry to avoid storing credentials...`
            );
            await dockerClientRemote.logout(serviceImageRegistry);
          }

          if (!pullServiceSuccess) {
            console.error(
              `    [${serverHostname}] Failed to pull image ${imageToPull}. Skipping deployment to this server.`
            );
            continue;
          }

          console.log(
            `    [${serverHostname}] Stopping and removing old container ${containerNameForService} (if exists)...`
          );
          try {
            await dockerClientRemote.stopContainer(containerNameForService); // Add ignoreNotFound option if possible
            await dockerClientRemote.removeContainer(containerNameForService); // Add ignoreNotFound option
          } catch (e) {
            console.warn(
              `    [${serverHostname}] Error stopping/removing old service container (may not exist):`,
              e
            );
          }

          console.log(
            `    [${serverHostname}] Starting new service container ${containerNameForService}...`
          );

          // Check if the service container with the same name already exists and is running
          const serviceContainerExists =
            await dockerClientRemote.containerExists(containerNameForService);
          if (serviceContainerExists) {
            const serviceContainerRunning =
              await dockerClientRemote.containerIsRunning(
                containerNameForService
              );

            // For services, we'll still replace the existing container even if it's running
            // But we'll log different messages based on state
            if (serviceContainerRunning) {
              console.log(
                `    [${serverHostname}] Service container ${containerNameForService} is already running. Replacing it...`
              );
              await dockerClientRemote.stopContainer(containerNameForService);
            } else {
              console.log(
                `    [${serverHostname}] Service container ${containerNameForService} exists but is not running. Removing it...`
              );
            }

            try {
              await dockerClientRemote.removeContainer(containerNameForService);
            } catch (e) {
              console.warn(
                `    [${serverHostname}] Error removing existing service container:`,
                e
              );
            }
          }

          const createServiceSuccess = await dockerClientRemote.createContainer(
            serviceContainerOptions
          );
          if (!createServiceSuccess) {
            console.error(
              `    [${serverHostname}] Failed to create container ${containerNameForService}. Skipping further steps for this service on this server.`
            );
            continue;
          }

          // Prune for service server
          console.log(`    [${serverHostname}] Pruning Docker resources...`);
          await dockerClientRemote.prune();

          console.log(
            `    [${serverHostname}] Service ${serviceEntry.name} deployed successfully to this server.`
          );
        } catch (serverError) {
          console.error(
            `  [${serverHostname}] Failed to deploy service ${serviceEntry.name} to server:`,
            serverError
          );
        } finally {
          if (sshClient) {
            await sshClient.close();
            console.log(`    [${serverHostname}] SSH connection closed.`);
          }
        }
      }
    }
  }
}
