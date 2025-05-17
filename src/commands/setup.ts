import { loadConfig, loadSecrets } from "../config";
import { LumaConfig, LumaSecrets, LumaService } from "../config/types";
import { SSHClient } from "../ssh";

// Helper function to get SSH options (you'll need to define where these come from, e.g., config, secrets)
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
    try {
      await sshClient.exec("docker info");
      console.log(`[${serverHostname}] Docker is installed and accessible.`);
    } catch (error) {
      console.warn(
        `[${serverHostname}] Docker not found or 'docker info' failed: ${error}.`
      );
      console.log(
        `[${serverHostname}] Docker is not installed. Please see https://github.com/elitan/luma for server setup instructions.`
      );
      return; // Early exit if Docker isn't installed
    }

    // 2. Log into Docker registry
    const dockerRegistry = config.docker?.registry || "docker.io"; // Default to Docker Hub
    const dockerUsername = config.docker?.username;
    const dockerPassword = secrets.DOCKER_REGISTRY_PASSWORD; // Assuming this key exists in secrets

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

    // Add guidance if connecting as root
    if (sshCredentials.username === "root") {
      console.log(`\n[${serverHostname}] SECURITY RECOMMENDATIONS: You're connecting as root. Consider setting up a non-root user:
        
        1. SSH into the server as root:
           $ ssh root@${serverHostname}
        
        2. Create a new user with sudo privileges (example uses 'luma' as username):
           $ useradd -m -s /bin/bash luma
           $ passwd luma
           $ usermod -aG sudo luma
        
        3. Set up SSH for the new user:
           $ mkdir -p /home/luma/.ssh
           $ cp ~/.ssh/authorized_keys /home/luma/.ssh/ # If you have keys set up for root
           $ chown -R luma:luma /home/luma/.ssh
           $ chmod 700 /home/luma/.ssh
           $ chmod 600 /home/luma/.ssh/authorized_keys
        
        4. Test the new user login from your local machine:
           $ ssh luma@${serverHostname}
        
        5. Once confirmed working, update your luma config to use this user instead of root.
           In luma.yml, add or modify: \`ssh: { username: "luma" }\`
        
        6. Optionally, disable root SSH login for security:
           $ sudo nano /etc/ssh/sshd_config
           Find "PermitRootLogin" and change to "PermitRootLogin no"
           $ sudo systemctl restart sshd
      `);
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
