import { LumaConfig, LumaSecrets } from "../config/types";
import { SSHClientOptions } from "./index";
import * as fs from "fs";
import * as os from "os";

/**
 * Get SSH credentials for connecting to a server.
 * This function handles credentials consistently across all commands.
 */
export async function getSSHCredentials(
  serverHostname: string,
  config: LumaConfig,
  secrets: LumaSecrets,
  verbose: boolean = false
): Promise<Partial<SSHClientOptions>> {
  const sshUser = config.ssh?.username || "root"; // Default to root, though setup warns against it
  const sshPort = config.ssh?.port || 22;
  const sshOptions: Partial<SSHClientOptions> = {
    username: sshUser,
    host: serverHostname,
    port: sshPort,
    verbose: verbose,
  };

  // Check for server-specific key path in secrets
  const serverSpecificKeyEnvVar = `SSH_KEY_${serverHostname
    .replace(/\./g, "_")
    .toUpperCase()}`;
  const serverSpecificKeyPath = secrets[serverSpecificKeyEnvVar];
  if (serverSpecificKeyPath) {
    if (verbose) {
      console.log(
        `[${serverHostname}] Attempting SSH with server-specific key from secrets (${serverSpecificKeyEnvVar}): ${serverSpecificKeyPath}`
      );
    }
    sshOptions.identity = serverSpecificKeyPath;
    return sshOptions;
  }

  // Check for default key path in secrets
  const defaultKeyPath = secrets.DEFAULT_SSH_KEY_PATH;
  if (defaultKeyPath) {
    if (verbose) {
      console.log(
        `[${serverHostname}] Attempting SSH with default key path from secrets (DEFAULT_SSH_KEY_PATH): ${defaultKeyPath}`
      );
    }
    sshOptions.identity = defaultKeyPath;
    return sshOptions;
  }

  // Check for server-specific password in secrets
  const serverSpecificPasswordEnvVar = `SSH_PASSWORD_${serverHostname
    .replace(/\./g, "_")
    .toUpperCase()}`;
  const serverSpecificPassword = secrets[serverSpecificPasswordEnvVar];
  if (serverSpecificPassword) {
    if (verbose) {
      console.log(
        `[${serverHostname}] Attempting SSH with server-specific password from secrets (${serverSpecificPasswordEnvVar}).`
      );
    }
    sshOptions.password = serverSpecificPassword;
    return sshOptions;
  }

  // Check for default password in secrets
  const defaultPassword = secrets.DEFAULT_SSH_PASSWORD;
  if (defaultPassword) {
    if (verbose) {
      console.log(
        `[${serverHostname}] Attempting SSH with default password from secrets (DEFAULT_SSH_PASSWORD).`
      );
    }
    sshOptions.password = defaultPassword;
    return sshOptions;
  }

  // Try to find common SSH key files in the user's home directory
  const homeDir = os.homedir();
  if (verbose) {
    console.log(`[${serverHostname}] Home directory resolved as: ${homeDir}`);
  }

  // Check for common SSH key files
  try {
    const keyPaths = [
      `${homeDir}/.ssh/id_rsa`,
      `${homeDir}/.ssh/id_ed25519`,
      `${homeDir}/.ssh/id_ecdsa`,
      `${homeDir}/.ssh/id_dsa`,
    ];

    for (const keyPath of keyPaths) {
      if (fs.existsSync(keyPath)) {
        sshOptions.identity = keyPath;
        if (verbose) {
          console.log(
            `[${serverHostname}] Explicitly using SSH key at: ${keyPath}`
          );
        }
        break; // Stop after finding the first existing key
      }
    }

    if (!sshOptions.identity && verbose) {
      console.log(
        `[${serverHostname}] No SSH keys found at standard locations: ${keyPaths.join(
          ", "
        )}`
      );
    }
  } catch (error) {
    if (verbose) {
      console.error(
        `[${serverHostname}] Error checking for default SSH keys:`,
        error
      );
    }
  }

  if (verbose) {
    console.log(
      `[${serverHostname}] No specific SSH key or password found in Luma secrets. Attempting agent-based authentication or found key file.`
    );
  }

  return sshOptions;
}
