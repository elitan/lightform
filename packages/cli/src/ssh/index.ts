// SSH client wrapper logic will go here

import SSH2Promise from "ssh2-promise";
import { ConnectConfig } from "ssh2";
import { getSSHCredentials } from "./utils";
import { createReadStream } from "fs";
import { stat } from "fs/promises";

export { getSSHCredentials };

export interface SSHClientOptions {
  host: string;
  port?: number;
  username: string;
  identity?: string;
  privateKey?: string;
  password?: string;
  passphrase?: string;
  agent?: string;
  verbose?: boolean;
  skipHostKeyVerification?: boolean;
  suppressConnectionErrors?: boolean;
}

export class SSHClient {
  private ssh: SSH2Promise;
  private connectOptions: ConnectConfig;
  public readonly host: string;
  private verbose: boolean = false;
  private suppressConnectionErrors: boolean = false;
  private platformCache?: string;

  private constructor(connectOptions: ConnectConfig) {
    this.connectOptions = connectOptions;
    this.ssh = new SSH2Promise(this.connectOptions);
    this.host = connectOptions.host!;
  }

  public static async create(options: SSHClientOptions): Promise<SSHClient> {
    const connectOpts: ConnectConfig = {
      host: options.host,
      port: options.port || 22,
      username: options.username,
      password: options.password,
      passphrase: options.passphrase,
      agent: options.agent,
    };
    
    // Skip host key verification for fresh servers
    if (options.skipHostKeyVerification) {
      connectOpts.hostHash = 'sha256';
      connectOpts.hostVerifier = () => true;
    }

    // ssh2-promise allows 'identity' for path, ssh2 'privateKey' for content
    const ssh2PromiseConfig: any = { ...connectOpts };

    if (options.identity) {
      ssh2PromiseConfig.identity = options.identity;
    } else if (options.privateKey) {
      ssh2PromiseConfig.privateKey = options.privateKey;
    }

    // Add ssh2-promise specific options
    ssh2PromiseConfig.reconnect = true;
    ssh2PromiseConfig.reconnectDelay = 2000;
    ssh2PromiseConfig.reconnectTries = 5;

    const client = new SSHClient(ssh2PromiseConfig as ConnectConfig);
    client.setVerbose(options.verbose || false);
    client.setSuppressConnectionErrors(options.suppressConnectionErrors || false);
    return client;
  }

  private setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  private setSuppressConnectionErrors(suppress: boolean): void {
    this.suppressConnectionErrors = suppress;
  }

  async connect(): Promise<void> {
    try {
      await this.ssh.connect();
      if (this.verbose) {
        console.log(`SSH connection established to ${this.host}`);
      }
    } catch (err) {
      if (!this.suppressConnectionErrors) {
        console.error(`SSH connection failed to ${this.host}:`, err);
      }
      throw err;
    }
  }

  async exec(command: string): Promise<string> {
    // Check if this is a sensitive command containing credentials
    const isSensitiveCommand =
      command.includes("password") ||
      command.includes("login") ||
      command.includes('echo "') ||
      command.includes("cat >");

    // Create a sanitized version for logging
    const sanitizedCommand = isSensitiveCommand
      ? command
          .replace(/echo ".*?"/g, 'echo "***REDACTED***"')
          .replace(/cat > .*?<< ['"]?EOF/g, "cat > ***REDACTED*** << EOF")
      : command;

    if (this.verbose) {
      console.log(`[${this.host}] Executing: ${sanitizedCommand}`);
    }

    return new Promise(async (resolve, reject) => {
      try {
        // Use shell command with explicit exit code checking
        // This command runs the original command and captures both stdout/stderr and exit code
        const wrappedCommand = `${command}; echo "EXIT_CODE:$?"`;
        const result = await this.ssh.exec(wrappedCommand);
        
        // Parse the result to extract exit code
        const lines = result.split('\n');
        let exitCodeLine = '';
        let output = '';
        
        // Find the exit code line (should be last non-empty line)
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].trim()) {
            if (lines[i].startsWith('EXIT_CODE:')) {
              exitCodeLine = lines[i];
              // Everything before this line is the actual output
              output = lines.slice(0, i).join('\n');
              break;
            }
          }
        }
        
        const exitCode = exitCodeLine ? parseInt(exitCodeLine.replace('EXIT_CODE:', '')) : 0;
        
        if (exitCode === 0) {
          // Command succeeded
          resolve(output);
        } else {
          // Command failed
          if (this.verbose) {
            console.error(`Command "${sanitizedCommand}" on ${this.host} failed with exit code ${exitCode}`);
          }
          reject(new Error(`Command failed with exit code ${exitCode}: ${output}`));
        }
        
      } catch (err: any) {
        // Handle the original ssh2-promise behavior for stderr as error
        const errorMessage = String(err);
        
        // If this is just a Docker warning or similar, treat as success
        if (errorMessage.includes("WARNING: No swap limit support") ||
            (errorMessage.includes("WARNING:") && !errorMessage.includes("error") && !errorMessage.includes("failed"))) {
          if (this.verbose) {
            console.warn(`[${this.host}] Command "${sanitizedCommand}" succeeded but had warnings:\n${errorMessage}`);
          }
          resolve(errorMessage);
        } else {
          // This is a real error
          if (this.verbose) {
            console.error(`Error executing command "${sanitizedCommand}" on ${this.host}:`, errorMessage);
          }
          reject(err);
        }
      }
    });
  }

  // Helper method to sanitize potentially sensitive output
  private sanitizeErrorOutput(output: string): string {
    // Replace potential Docker login password in command
    output = output.replace(
      /echo ".*?" \| docker login/g,
      'echo "***REDACTED***" | docker login'
    );

    // Replace other sensitive patterns
    output = output.replace(
      /password=.*?( |$|\n)/gi,
      "password=***REDACTED*** "
    );
    output = output.replace(
      /password:.*?( |$|\n)/gi,
      "password:***REDACTED*** "
    );
    output = output.replace(
      /--password[-_]?\w*\s+["']?[\w!@#$%^&*(),.?;:|<>]*["']?/gi,
      "--password ***REDACTED***"
    );

    return output;
  }

  async close(): Promise<void> {
    try {
      await this.ssh.close();
      if (this.verbose) {
        console.log(`SSH connection closed to ${this.host}`);
      }
    } catch (err) {
      if (this.verbose) {
        console.error(`Error closing SSH connection to ${this.host}:`, err);
      }
    }
  }

  /**
   * Detects the platform architecture of the remote server
   * @returns Promise<string> Platform string (e.g., "linux/amd64", "linux/arm64")
   */
  async detectServerPlatform(): Promise<string> {
    if (this.platformCache) {
      return this.platformCache;
    }

    try {
      if (this.verbose) {
        console.log(`[${this.host}] Detecting server platform...`);
      }

      // Get architecture and OS information
      const arch = await this.exec("uname -m");
      const os = await this.exec("uname -s");

      // Map common architectures to Docker platform format
      const cleanArch = arch.trim().toLowerCase();
      const cleanOs = os.trim().toLowerCase();

      let dockerArch: string;
      switch (cleanArch) {
        case "x86_64":
        case "amd64":
          dockerArch = "amd64";
          break;
        case "aarch64":
        case "arm64":
          dockerArch = "arm64";
          break;
        case "armv7l":
        case "armv7":
          dockerArch = "arm/v7";
          break;
        case "armv6l":
        case "armv6":
          dockerArch = "arm/v6";
          break;
        case "i386":
        case "i686":
          dockerArch = "386";
          break;
        default:
          // Default to amd64 for unknown architectures
          if (this.verbose) {
            console.warn(`[${this.host}] Unknown architecture '${cleanArch}', defaulting to amd64`);
          }
          dockerArch = "amd64";
      }

      // Construct platform string (typically linux/amd64, linux/arm64, etc.)
      let platform: string;
      if (cleanOs === "linux") {
        platform = `linux/${dockerArch}`;
      } else if (cleanOs === "darwin") {
        platform = `darwin/${dockerArch}`;
      } else {
        // Default to linux for unknown OS
        if (this.verbose) {
          console.warn(`[${this.host}] Unknown OS '${cleanOs}', defaulting to linux`);
        }
        platform = `linux/${dockerArch}`;
      }

      // Cache the result
      this.platformCache = platform;

      if (this.verbose) {
        console.log(`[${this.host}] Detected platform: ${platform} (arch: ${cleanArch}, os: ${cleanOs})`);
      }

      return platform;
    } catch (error) {
      if (this.verbose) {
        console.warn(`[${this.host}] Failed to detect server platform, defaulting to linux/amd64:`, error);
      }
      // Default fallback
      this.platformCache = "linux/amd64";
      return this.platformCache;
    }
  }

  /**
   * Upload a file to the remote server using native rsync or scp command (fastest for large files)
   */
  async uploadFile(
    localPath: string,
    remotePath: string,
    onProgress?: (transferred: number, total: number) => void
  ): Promise<void> {
    if (this.verbose) {
      console.log(
        `[${this.host}] Uploading ${localPath} to ${remotePath} via rsync or SCP`
      );
    }

    try {
      // Get file stats for progress info
      const stats = await stat(localPath);
      const totalSize = stats.size;
      if (this.verbose) {
        console.log(
          `[${this.host}] File size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`
        );
      }

      // Create remote directory first via SSH
      await this.ssh.exec(`mkdir -p $(dirname "${remotePath}")`);

      // Use native rsync or scp command for maximum speed
      // Try rsync first (faster for large files), fall back to scp
      const rsyncCommand = `rsync -avz --progress "${localPath}" ${this.connectOptions.username}@${this.host}:"${remotePath}"`;
      const scpCommand = `scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -C "${localPath}" ${this.connectOptions.username}@${this.host}:"${remotePath}"`;

      if (this.verbose) {
        console.log(`[${this.host}] Trying rsync for faster transfer`);
      }

      // Execute rsync or scp command directly
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execPromise = promisify(exec);

      let progressInterval: NodeJS.Timeout | undefined;

      if (onProgress) {
        // Monitor progress by checking remote file size during transfer
        progressInterval = setInterval(async () => {
          try {
            const result = await this.ssh.exec(
              `stat -c%s "${remotePath}" 2>/dev/null || echo 0`
            );
            const transferred = parseInt(result.trim()) || 0;
            onProgress(Math.min(transferred, totalSize), totalSize);
          } catch (e) {
            // Ignore errors during progress monitoring
          }
        }, 200); // Check every 200ms for smoother progress
      }

      try {
        // Try rsync first
        try {
          if (this.verbose) {
            console.log(
              `[${this.host}] Executing rsync: ${rsyncCommand.replace(
                localPath,
                "***"
              )}`
            );
          }
          await execPromise(rsyncCommand);
          if (this.verbose) {
            console.log(`[${this.host}] rsync upload completed: ${remotePath}`);
          }
        } catch (rsyncError) {
          // Fallback to SCP if rsync fails
          if (this.verbose) {
            console.log(
              `[${this.host}] rsync failed, falling back to SCP: ${rsyncError}`
            );
            console.log(
              `[${this.host}] Executing SCP: ${scpCommand.replace(
                localPath,
                "***"
              )}`
            );
          }
          await execPromise(scpCommand);
          if (this.verbose) {
            console.log(`[${this.host}] SCP upload completed: ${remotePath}`);
          }
        }

        if (progressInterval) {
          clearInterval(progressInterval);
          // Final progress update
          onProgress?.(totalSize, totalSize);
        }
      } catch (transferError) {
        if (progressInterval) {
          clearInterval(progressInterval);
        }
        throw transferError;
      }
    } catch (err) {
      console.error(
        `[${this.host}] Failed to upload file ${localPath} to ${remotePath} via rsync or SCP:`,
        err
      );
      throw err;
    }
  }

  /**
   * Download a file from the remote server using SFTP
   */
  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    if (this.verbose) {
      console.log(`[${this.host}] Downloading ${remotePath} to ${localPath}`);
    }

    try {
      const sftp = await this.ssh.sftp();
      await sftp.fastGet(remotePath, localPath);

      if (this.verbose) {
        console.log(`[${this.host}] Download completed: ${localPath}`);
      }
    } catch (err) {
      console.error(
        `[${this.host}] Failed to download file ${remotePath} to ${localPath}:`,
        err
      );
      throw err;
    }
  }
}
