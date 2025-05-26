// SSH client wrapper logic will go here

import SSH2Promise from "ssh2-promise";
import { ConnectConfig } from "ssh2"; // Import ConnectConfig from ssh2
import { getSSHCredentials } from "./utils"; // Import the utility function
import { createReadStream, createWriteStream } from "fs";
import { stat } from "fs/promises";
import * as cliProgress from "cli-progress";

export { getSSHCredentials }; // Export for use across the codebase

export interface SSHClientOptions {
  host: string;
  port?: number;
  username: string;
  identity?: string; // Path to private key, ssh2-promise uses 'identity' for path
  privateKey?: string; // Content of the private key, ssh2 uses 'privateKey'
  password?: string;
  passphrase?: string; // For encrypted private keys
  agent?: string; // SSH agent socket path
  verbose?: boolean;
  // proxy?: SSHConfig['proxy']; // Assuming proxy config is part of SSHConfig, will verify later
}

export class SSHClient {
  private ssh: SSH2Promise;
  private connectOptions: ConnectConfig;
  public readonly host: string;
  private verbose: boolean = false;

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
    return client;
  }

  private setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  async connect(): Promise<void> {
    try {
      await this.ssh.connect();
      if (this.verbose) {
        console.log(`SSH connection established to ${this.host}`);
      }
    } catch (err) {
      console.error(`SSH connection failed to ${this.host}:`, err);
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

    try {
      const result = await this.ssh.exec(command);
      if (typeof result === "string") {
        return result;
      }
      if (this.verbose) {
        console.warn(
          `Unexpected exec result type on ${
            this.host
          } for command "${sanitizedCommand}": ${typeof result}`
        );
      }
      return String(result);
    } catch (err: any) {
      // Check if error has stdout/stderr (common for exec errors)
      const execError = err as {
        stdout?: string;
        stderr?: string;
        message?: string;
        code?: number | string;
      };

      // Only show detailed error info in verbose mode
      if (this.verbose) {
        // Sanitize error outputs
        if (execError.stderr && isSensitiveCommand) {
          const sanitizedStderr = this.sanitizeErrorOutput(execError.stderr);
          console.error(
            `Command "${sanitizedCommand}" on ${this.host} failed with stderr:\n${sanitizedStderr}`
          );
        } else if (execError.stderr) {
          console.error(
            `Command "${sanitizedCommand}" on ${this.host} failed with stderr:\n${execError.stderr}`
          );
        }

        if (execError.stdout && isSensitiveCommand) {
          const sanitizedStdout = this.sanitizeErrorOutput(execError.stdout);
          console.warn(
            `Command "${sanitizedCommand}" on ${this.host} had stdout despite error:\n${sanitizedStdout}`
          );
        } else if (execError.stdout) {
          console.warn(
            `Command "${sanitizedCommand}" on ${this.host} had stdout despite error:\n${execError.stdout}`
          );
        }

        // Sanitize the error message
        const errorMessage = execError.message || String(err);
        const sanitizedError = isSensitiveCommand
          ? this.sanitizeErrorOutput(errorMessage)
          : errorMessage;

        console.error(
          `Error executing command "${sanitizedCommand}" on ${this.host}:`,
          sanitizedError
        );
      }

      throw err;
    }
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
   * Upload a file to the remote server using SFTP
   */
  async uploadFile(
    localPath: string,
    remotePath: string,
    onProgress?: (transferred: number, total: number) => void
  ): Promise<void> {
    if (this.verbose) {
      console.log(`[${this.host}] Uploading ${localPath} to ${remotePath}`);
    }

    try {
      // Get file stats for progress info
      const stats = await stat(localPath);
      if (this.verbose) {
        console.log(
          `[${this.host}] File size: ${(stats.size / 1024 / 1024).toFixed(
            2
          )} MB`
        );
      }

      const sftp = await this.ssh.sftp();

      if (onProgress) {
        // Use streaming upload with progress tracking
        const readStream = createReadStream(localPath);
        const writeStream = await sftp.createWriteStream(remotePath);
        let transferred = 0;
        const totalSize = stats.size;

        return new Promise((resolve, reject) => {
          readStream.on("data", (chunk: string | Buffer) => {
            const chunkSize =
              typeof chunk === "string"
                ? Buffer.byteLength(chunk)
                : chunk.length;
            transferred += chunkSize;
            onProgress(transferred, totalSize);
          });

          readStream.on("end", () => {
            resolve();
          });

          readStream.on("error", reject);
          writeStream.on("error", reject);

          readStream.pipe(writeStream);
        });
      } else {
        // Use the standard upload method
        await sftp.fastPut(localPath, remotePath);
      }

      if (this.verbose) {
        console.log(`[${this.host}] Upload completed: ${remotePath}`);
      }
    } catch (err) {
      console.error(
        `[${this.host}] Failed to upload file ${localPath} to ${remotePath}:`,
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
