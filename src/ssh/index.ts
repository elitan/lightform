// SSH client wrapper logic will go here

import SSH2Promise from "ssh2-promise";
import { ConnectConfig } from "ssh2"; // Import ConnectConfig from ssh2

export interface SSHClientOptions {
  host: string;
  port?: number;
  username: string;
  identity?: string; // Path to private key, ssh2-promise uses 'identity' for path
  privateKey?: string; // Content of the private key, ssh2 uses 'privateKey'
  password?: string;
  passphrase?: string; // For encrypted private keys
  agent?: string; // SSH agent socket path
  // proxy?: SSHConfig['proxy']; // Assuming proxy config is part of SSHConfig, will verify later
}

export class SSHClient {
  private ssh: SSH2Promise;
  private connectOptions: ConnectConfig;
  public readonly host: string;

  private constructor(connectOptions: ConnectConfig) {
    this.connectOptions = connectOptions;
    // SSH2Promise constructor expects the config directly
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
      // Options for ssh2-promise wrapper itself (if any, like reconnect)
      // should be part of a separate config or handled if ssh2promise extends them.
      // For now, assuming ssh2-promise passes underlying ssh2 options through.
      // reconnect: true, // This is an ssh2-promise specific option, not ssh2 ConnectConfig
      // reconnectDelay: 2000,
      // reconnectTries: 5,
    };

    // ssh2-promise allows 'identity' for path, ssh2 'privateKey' for content
    // We need to ensure we pass the correct option to the SSH2Promise constructor.
    // ssh2-promise documentation: "Extra identity option is provided to directly pass the path of private key file"
    // ssh2 (which ssh2-promise wraps) uses 'privateKey' for key content.

    const ssh2PromiseConfig: any = { ...connectOpts }; // Start with base ssh2 options

    if (options.identity) {
      ssh2PromiseConfig.identity = options.identity; // Use identity for path for ssh2-promise
    } else if (options.privateKey) {
      ssh2PromiseConfig.privateKey = options.privateKey; // Use privateKey for content
    }

    // Add ssh2-promise specific options
    ssh2PromiseConfig.reconnect = true;
    ssh2PromiseConfig.reconnectDelay = 2000;
    ssh2PromiseConfig.reconnectTries = 5;

    // The constructor of SSHClient will now receive the full ssh2PromiseConfig
    const client = new SSHClient(ssh2PromiseConfig as ConnectConfig);
    return client;
  }

  async connect(): Promise<void> {
    try {
      await this.ssh.connect();
      console.log(`SSH connection established to ${this.host}`);
    } catch (err) {
      console.error(`SSH connection failed to ${this.host}:`, err);
      throw err;
    }
  }

  async exec(command: string): Promise<string> {
    try {
      const result = await this.ssh.exec(command);
      if (typeof result === "string") {
        return result;
      }
      // ssh2-promise can return an object with stdout/stderr for exec
      // Based on ssh2-promise docs, exec directly returns string output or throws error.
      // However, the previous code had a more complex check, let's stick to simpler string for now.
      // If complex object is indeed returned, this needs adjustment based on actual behavior.
      console.warn(
        `Unexpected exec result type on ${
          this.host
        } for command "${command}": ${typeof result}`
      );
      return String(result); // Attempt to convert, but this might not be ideal.
    } catch (err) {
      // Check if error has stdout/stderr (common for exec errors)
      const execError = err as {
        stdout?: string;
        stderr?: string;
        message?: string;
        code?: number | string;
      };
      if (execError.stderr) {
        console.error(
          `Command "${command}" on ${this.host} failed with stderr:\n${execError.stderr}`
        );
      }
      if (execError.stdout) {
        // Sometimes errors might still have stdout
        console.warn(
          `Command "${command}" on ${this.host} had stdout despite error:\n${execError.stdout}`
        );
      }
      console.error(
        `Error executing command "${command}" on ${this.host}:`,
        execError.message || err
      );
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.ssh.close();
    console.log(`SSH connection closed to ${this.host}`);
  }
}
