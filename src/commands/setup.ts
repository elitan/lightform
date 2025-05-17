import { loadConfig, loadSecrets } from "../config";
import { LumaConfig, LumaSecrets, LumaService } from "../config/types";
import { SSHClient } from "../ssh";

async function getSSHCredentials(
  serverHostname: string,
  config: LumaConfig,
  secrets: LumaSecrets
): Promise<any> {
  const sshUser = config.ssh?.username || "root";

  const serverSpecificKeyEnvVar = `SSH_KEY_${serverHostname
    .replace(/\./g, "_")
    .toUpperCase()}`;
  const serverSpecificKeyPath = secrets[serverSpecificKeyEnvVar];
  if (serverSpecificKeyPath) {
    console.log(
      `[${serverHostname}] Attempting SSH with server-specific key from secrets (${serverSpecificKeyEnvVar}): ${serverSpecificKeyPath}`
    );
    return { username: sshUser, identity: serverSpecificKeyPath };
  }

  const defaultKeyPath = secrets.DEFAULT_SSH_KEY_PATH;
  if (defaultKeyPath) {
    console.log(
      `[${serverHostname}] Attempting SSH with default key path from secrets (DEFAULT_SSH_KEY_PATH): ${defaultKeyPath}`
    );
    return { username: sshUser, identity: defaultKeyPath };
  }

  const serverSpecificPasswordEnvVar = `SSH_PASSWORD_${serverHostname
    .replace(/\./g, "_")
    .toUpperCase()}`;
  const serverSpecificPassword = secrets[serverSpecificPasswordEnvVar];
  if (serverSpecificPassword) {
    console.log(
      `[${serverHostname}] Attempting SSH with server-specific password from secrets (${serverSpecificPasswordEnvVar}).`
    );
    return { username: sshUser, password: serverSpecificPassword };
  }

  const defaultPassword = secrets.DEFAULT_SSH_PASSWORD;
  if (defaultPassword) {
    console.log(
      `[${serverHostname}] Attempting SSH with default password from secrets (DEFAULT_SSH_PASSWORD).`
    );
    return { username: sshUser, password: defaultPassword };
  }

  console.log(
    `[${serverHostname}] No specific SSH key or password found in Luma secrets. Attempting agent-based or other default SSH authentication methods (e.g., default key files like ~/.ssh/id_rsa, ~/.ssh/id_ed25519).`
  );
  return { username: sshUser };
}

async function setupServer(
  serverHostname: string,
  config: LumaConfig,
  secrets: LumaSecrets
) {
  console.log(`Setting up server: ${serverHostname}...`);

  const sshCredentials = await getSSHCredentials(
    serverHostname,
    config,
    secrets
  );
  if (!sshCredentials.username) {
    console.error(
      `[${serverHostname}] Could not determine SSH username. Skipping.`
    );
    return;
  }

  // Early exit if using root
  if (sshCredentials.username === "root") {
    console.error(
      `[${serverHostname}] Using root for SSH access is not recommended.`
    );
    console.error(
      `[${serverHostname}] Please see https://github.com/elitan/luma for security best practices.`
    );
    return;
  }

  console.log(
    `[${serverHostname}] Resolved SSH username: ${sshCredentials.username}`
  );
  if (sshCredentials.identity) {
    console.log(
      `[${serverHostname}] Using SSH key path: ${sshCredentials.identity}`
    );
  } else if (sshCredentials.password) {
    console.log(`[${serverHostname}] Using SSH password (not displayed).`);
  } else {
    console.log(
      `[${serverHostname}] No specific key or password configured; attempting agent/default key authentication.`
    );
  }

  const sshClientOptions: any = {
    host: serverHostname,
    username: sshCredentials.username,
    port: config.ssh?.port || 22,
    identity: sshCredentials.identity,
    password: sshCredentials.password,
    // passphrase: secrets.SSH_KEY_PASSPHRASE, // If your private key is passphrase protected
  };

  // Always try default key locations with full paths
  const homeDir = process.env.HOME || require("os").homedir();
  console.log(`[${serverHostname}] Home directory resolved as: ${homeDir}`);

  // Check for and use various common SSH key files
  try {
    const fs = require("fs");
    const keyPaths = [
      `${homeDir}/.ssh/id_rsa`,
      `${homeDir}/.ssh/id_ed25519`,
      `${homeDir}/.ssh/id_ecdsa`,
      `${homeDir}/.ssh/id_dsa`,
    ];

    for (const keyPath of keyPaths) {
      if (fs.existsSync(keyPath)) {
        sshClientOptions.identity = keyPath;
        console.log(
          `[${serverHostname}] Explicitly using SSH key at: ${keyPath}`
        );
        break; // Stop after finding the first existing key
      }
    }

    if (!sshClientOptions.identity) {
      console.log(
        `[${serverHostname}] No SSH keys found at standard locations: ${keyPaths.join(
          ", "
        )}`
      );
    }
  } catch (error) {
    console.error(
      `[${serverHostname}] Error checking for default SSH keys:`,
      error
    );
  }

  // Add ssh2 debug logging
  sshClientOptions.debug = (message: string) => {
    console.log(`[${serverHostname}] SSH_DEBUG: ${message}`);
  };

  const loggableSshClientOptions = {
    ...sshClientOptions,
    password: sshClientOptions.password ? "***hidden***" : undefined,
    debug: sshClientOptions.debug ? "<function>" : undefined,
  };
  console.log(
    `[${serverHostname}] SSHClient options:`,
    JSON.stringify(loggableSshClientOptions, null, 2)
  );

  const sshClient = await SSHClient.create(sshClientOptions);

  try {
    await sshClient.connect();

    // 1. Check if Docker is installed
    console.log(`[${serverHostname}] Checking Docker installation...`);
    let dockerInstalled = false;
    try {
      await sshClient.exec("docker info");
      console.log(`[${serverHostname}] Docker is installed and accessible.`);
      dockerInstalled = true;
    } catch (error) {
      console.warn(
        `[${serverHostname}] Docker not found or 'docker info' failed: ${error}.`
      );
      console.log(`[${serverHostname}] Will attempt to install Docker...`);
    }

    // Install Docker, curl, git if not installed
    if (!dockerInstalled) {
      console.log(`[${serverHostname}] Installing Docker, curl, and git...`);
      try {
        console.log(`[${serverHostname}] Running apt update...`);
        await sshClient.exec("sudo apt update");

        console.log(`[${serverHostname}] Running apt upgrade...`);
        await sshClient.exec("sudo apt upgrade -y");

        console.log(`[${serverHostname}] Installing docker.io, curl, git...`);
        await sshClient.exec("sudo apt install -y docker.io curl git");

        console.log(`[${serverHostname}] Adding user to docker group...`);
        await sshClient.exec(
          `sudo usermod -a -G docker ${sshCredentials.username}`
        );

        console.log(
          `[${serverHostname}] Successfully installed required packages.`
        );
        dockerInstalled = true;
      } catch (installError) {
        console.error(
          `[${serverHostname}] Failed to install Docker and dependencies: ${installError}`
        );
        console.log(
          `[${serverHostname}] Please install Docker manually. See https://github.com/elitan/luma for server setup instructions.`
        );
        return; // Early exit if installation failed
      }
    }

    // 2. Log into Docker registry
    const dockerRegistry = config.docker?.registry || "docker.io"; // Default to Docker Hub
    const dockerUsername = config.docker?.username;
    const dockerPassword = secrets.DOCKER_REGISTRY_PASSWORD; // Assuming this key exists in secrets

    console.log(
      `[${serverHostname}] Using Docker registry: ${dockerRegistry} (default: docker.io)`
    );

    if (dockerUsername && dockerPassword) {
      console.log(
        `[${serverHostname}] Logging into Docker registry: ${dockerRegistry}...`
      );
      try {
        // Important: Escape special characters in password for shell command
        const escapedPassword = dockerPassword.replace(
          /[\$"`\\\n]/g,
          (match) => `\\${match}`
        );
        const loginCommand = `echo "${escapedPassword}" | docker login ${dockerRegistry} -u "${dockerUsername}" --password-stdin`;
        await sshClient.exec(loginCommand);
        console.log(
          `[${serverHostname}] Successfully logged into Docker registry: ${dockerRegistry}.`
        );
      } catch (error) {
        console.error(
          `[${serverHostname}] Failed to log into Docker registry ${dockerRegistry}: ${error}`
        );
        // Decide if this is a fatal error for the setup
      }
    } else {
      console.warn(
        `[${serverHostname}] Docker registry username or password not configured/found in secrets. Skipping Docker login.`
      );
      console.warn(
        `[${serverHostname}] Please ensure DOCKER_REGISTRY_PASSWORD is in .luma/secrets and docker.username is in luma.yml if login is required.`
      );
    }

    // 3. Start the services assigned to this server
    console.log(
      `[${serverHostname}] Starting services assigned to this server...`
    );

    const servicesOnThisServer = Object.entries(config.services || {})
      .filter(
        ([_, service]) =>
          service.servers && service.servers.includes(serverHostname)
      )
      .map(([name, service]) => ({ name, ...service }));

    if (servicesOnThisServer.length === 0) {
      console.log(`[${serverHostname}] No services found for this server.`);
    } else {
      console.log(
        `[${serverHostname}] Found ${servicesOnThisServer.length} services to start.`
      );

      // Create a dedicated Docker network for all Luma containers
      // Require a project name for network creation
      if (!config.name) {
        console.error(
          `[${serverHostname}] Project name is required in luma.yml (add 'name: your_project_name').`
        );
        console.error(
          `[${serverHostname}] The project name is used to create a unique Docker network for your services.`
        );
        throw new Error(
          `Project name not specified in configuration. Please add 'name: your_project_name' to your luma.yml file.`
        );
      }

      const networkName = `${config.name}-network`;
      let useCustomNetwork = true;
      console.log(
        `[${serverHostname}] Creating Docker network: ${networkName}...`
      );
      try {
        // Check if network already exists
        const networkExists = await sshClient.exec(
          `docker network ls --filter name=${networkName} --format "{{.Name}}"`
        );

        if (networkExists.trim() === networkName) {
          console.log(
            `[${serverHostname}] Docker network ${networkName} already exists.`
          );
        } else {
          // Create the network
          await sshClient.exec(`docker network create ${networkName}`);
          console.log(
            `[${serverHostname}] Created Docker network: ${networkName}`
          );
        }
      } catch (networkError) {
        console.error(
          `[${serverHostname}] Failed to create Docker network: ${networkError}`
        );
        console.error(
          `[${serverHostname}] Will attempt to continue without custom network.`
        );
        useCustomNetwork = false;
      }

      // Handle service-specific registry logins
      const serviceRegistryMap = new Map<
        string,
        { registry: string; username: string; password: string }
      >();

      for (const service of servicesOnThisServer) {
        // Check if this service has a specific registry configuration
        if (
          service.registry &&
          typeof service.registry === "object" &&
          service.registry.username
        ) {
          // Use service registry URL if provided, otherwise fall back to global registry, which defaults to Docker Hub
          const serviceRegistry = service.registry.url || dockerRegistry;
          const serviceUsername = service.registry.username;

          console.log(
            `[${serverHostname}] Service ${service.name} uses registry: ${serviceRegistry}`
          );

          // Check if registry has a password in secrets
          if (
            service.registry.password &&
            Array.isArray(service.registry.password) &&
            service.registry.password.length > 0
          ) {
            const passwordSecretKey = service.registry.password[0];
            const servicePassword = secrets[passwordSecretKey];

            if (servicePassword && !serviceRegistryMap.has(serviceRegistry)) {
              serviceRegistryMap.set(serviceRegistry, {
                registry: serviceRegistry,
                username: serviceUsername,
                password: servicePassword,
              });
            } else if (!servicePassword) {
              console.warn(
                `[${serverHostname}] Service ${service.name}: Secret ${passwordSecretKey} not found in .luma/secrets. Skipping registry login.`
              );
            }
          }
        }
      }

      // Login to all service-specific registries
      for (const [registry, credentials] of serviceRegistryMap.entries()) {
        console.log(
          `[${serverHostname}] Logging into service-specific Docker registry: ${registry}...`
        );
        try {
          const escapedPassword = credentials.password.replace(
            /[\$"`\\\n]/g,
            (match) => `\\${match}`
          );
          const loginCommand = `echo "${escapedPassword}" | docker login ${registry} -u "${credentials.username}" --password-stdin`;
          await sshClient.exec(loginCommand);
          console.log(
            `[${serverHostname}] Successfully logged into Docker registry: ${registry}.`
          );
        } catch (error) {
          console.error(
            `[${serverHostname}] Failed to log into Docker registry ${registry}: ${error}`
          );
        }
      }

      for (const service of servicesOnThisServer) {
        console.log(`[${serverHostname}] Starting service: ${service.name}...`);

        try {
          // Pull the latest image
          console.log(`[${serverHostname}] Pulling image ${service.image}...`);

          // Always do a fresh pull to ensure we have the latest version
          try {
            await sshClient.exec(`docker pull ${service.image}`);
            console.log(
              `[${serverHostname}] Successfully pulled image ${service.image}.`
            );
          } catch (pullError) {
            console.warn(
              `[${serverHostname}] Warning: Failed to pull image ${service.image}: ${pullError}`
            );
            console.warn(
              `[${serverHostname}] Will attempt to continue with locally available image, if any.`
            );
          }

          // Check if container with this name already exists
          const containerName = `luma-${config.name}-${service.name}`;

          // Check if container already exists (running or not)
          const containerExists = await sshClient.exec(
            `docker ps -a --filter "name=${containerName}" --format "{{.Names}}"`
          );

          if (containerExists.trim()) {
            // Container exists, check if it's running
            const containerRunning = await sshClient.exec(
              `docker ps --filter "name=${containerName}" --format "{{.Names}}"`
            );

            if (containerRunning.trim()) {
              console.log(
                `[${serverHostname}] Container ${containerName} is already running. Setup command does not restart existing containers.`
              );
              continue; // Skip to the next service
            } else {
              console.log(
                `[${serverHostname}] Container ${containerName} exists but is not running. Starting it...`
              );
              await sshClient.exec(`docker start ${containerName}`);
              console.log(
                `[${serverHostname}] Started container ${containerName}.`
              );
              continue; // Skip to the next service
            }
          }

          console.log(
            `[${serverHostname}] No existing container named ${containerName}. Creating new container.`
          );

          // Prepare the docker run command
          let runCommand = `docker run -d --name ${containerName}`;

          // Add network if available
          if (useCustomNetwork) {
            runCommand += ` --network ${networkName}`;
          }

          // Add restart policy
          runCommand += ` --restart unless-stopped`;

          // Add ports
          if (service.ports && service.ports.length > 0) {
            service.ports.forEach((port) => {
              runCommand += ` -p ${port}`;
            });
          }

          // Add volumes
          if (service.volumes && service.volumes.length > 0) {
            service.volumes.forEach((volume: string) => {
              runCommand += ` -v ${volume}`;
            });
          }

          // Add environment variables
          const envVars: string[] = [];

          // Add plain environment variables
          if (
            service.environment?.plain &&
            service.environment.plain.length > 0
          ) {
            service.environment.plain.forEach((envVar) => {
              envVars.push(`-e ${envVar}`);
            });
          }

          // Add secret environment variables
          if (
            service.environment?.secret &&
            service.environment.secret.length > 0
          ) {
            service.environment.secret.forEach((secretName) => {
              const secretValue = secrets[secretName];
              if (secretValue) {
                // Escape special characters in secret value
                const escapedValue = secretValue.replace(/[\$"`\\]/g, "\\$&");
                envVars.push(`-e ${secretName}="${escapedValue}"`);
              } else {
                console.warn(
                  `[${serverHostname}] Secret ${secretName} not found in .luma/secrets. Skipping.`
                );
              }
            });
          }

          if (envVars.length > 0) {
            runCommand += ` ${envVars.join(" ")}`;
          }

          // Finally add the image name
          runCommand += ` ${service.image}`;

          // Run the container
          console.log(
            `[${serverHostname}] Starting container ${containerName}...`
          );
          await sshClient.exec(runCommand);

          console.log(
            `[${serverHostname}] Service ${service.name} started successfully.`
          );
        } catch (error) {
          console.error(
            `[${serverHostname}] Failed to start service ${service.name}: ${error}`
          );
        }
      }
    }

    console.log(`[${serverHostname}] Setup steps completed.`);
  } catch (error: any) {
    const portForError = config.ssh?.port || 22;
    console.error(
      `[${serverHostname}] Error during server setup (connecting to ${
        sshCredentials.username
      }@${serverHostname}:${portForError}): ${error.message || error}`
    );
    if (
      error.level === "client-authentication" ||
      (error.message &&
        error.message.includes("All configured authentication methods failed"))
    ) {
      console.error(`[${serverHostname}] Authentication failure. Please verify:
          1. SSH key path ('identity') in Luma config/secrets is correct and accessible.
          2. If using a password, it's correct in Luma secrets.
          3. SSH agent (if used) is configured correctly with the right keys.
          4. The user '${sshCredentials.username}' is allowed to SSH to '${serverHostname}'.`);
    } else if (error.code === "ECONNREFUSED") {
      console.error(
        `[${serverHostname}] Connection refused. Ensure an SSH server is running on '${serverHostname}' and accessible on port ${portForError}. Check firewalls.`
      );
    } else if (
      error.code === "ETIMEDOUT" ||
      (error.message && error.message.toLowerCase().includes("timeout"))
    ) {
      console.error(
        `[${serverHostname}] Connection timed out. Check network connectivity to '${serverHostname}', server load, and any firewalls.`
      );
    } else if (error.message && error.message.includes("ENOTFOUND")) {
      console.error(
        `[${serverHostname}] Hostname not found. Ensure '${serverHostname}' is a valid and resolvable hostname.`
      );
    }
  } finally {
    await sshClient.close();
  }
}

export async function setupCommand(serviceNames?: string[]) {
  try {
    const config = await loadConfig();
    const secrets = await loadSecrets();

    let servicesToSetup: LumaService[] = [];

    if (serviceNames && serviceNames.length > 0) {
      console.log(`Targeting services: ${serviceNames.join(", ")}`);
      serviceNames.forEach((name) => {
        if (config.services[name]) {
          servicesToSetup.push(config.services[name]);
        } else {
          console.warn(
            `Service "${name}" not found in configuration. Skipping.`
          );
        }
      });
    } else {
      console.log("Targeting all services for setup.");
      servicesToSetup = Object.values(config.services);
    }

    if (servicesToSetup.length === 0) {
      console.log("No services to set up.");
      return;
    }

    const uniqueServers = new Set<string>();
    servicesToSetup.forEach((service) => {
      if (service.servers && service.servers.length > 0) {
        service.servers.forEach((server) => uniqueServers.add(server));
      } else {
        console.warn(
          `Service "${Object.keys(config.services).find(
            (key) => config.services[key] === service
          )}" has no servers defined. Skipping.`
        );
      }
    });

    if (uniqueServers.size === 0) {
      console.log("No target servers found for the specified services.");
      return;
    }

    console.log(
      `Identified unique target servers: ${Array.from(uniqueServers).join(
        ", "
      )}`
    );

    for (const serverHostname of uniqueServers) {
      await setupServer(serverHostname, config, secrets);
    }

    console.log("Setup command finished.");
  } catch (error) {
    console.error("Failed to execute setup command:", error);
    // Optionally, exit with error code: process.exit(1);
  }
}
