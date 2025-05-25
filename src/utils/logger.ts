export interface LoggerOptions {
  verbose?: boolean;
}

interface ActiveSpinner {
  startTime: number;
  interval: NodeJS.Timeout;
  message: string;
  level: number;
}

export class Logger {
  private startTime: number = Date.now();
  private stepStartTime: number = Date.now();
  private isVerbose: boolean;
  private activeSpinner: ActiveSpinner | null = null;
  private spinnerChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private spinnerIndex = 0;

  constructor(options: LoggerOptions = {}) {
    this.isVerbose = options.verbose || false;
  }

  // Getter for verbose mode
  get verbose(): boolean {
    return this.isVerbose;
  }

  // Setup-specific methods
  setupStart(message: string) {
    console.log(`${message}\n`);
    this.startTime = Date.now();
  }

  setupComplete() {
    this.clearSpinner();
    const totalDuration = Date.now() - this.startTime;
    console.log(
      `\n[✓] Setup completed successfully in ${this.formatDuration(
        totalDuration
      )}`
    );
  }

  setupFailed(error?: any) {
    this.clearSpinner();
    const totalDuration = Date.now() - this.startTime;
    console.log(
      `\n[✗] Setup failed after ${this.formatDuration(totalDuration)}`
    );
    if (this.isVerbose && error) {
      console.error(`Error details: ${error}`);
    }
  }

  // Main phase headers
  deploymentStart(releaseId: string) {
    console.log(`Starting deployment with release ${releaseId}\n`);
    this.startTime = Date.now();
  }

  phase(message: string) {
    this.clearSpinner();
    this.startSpinner(message, 0);
  }

  phaseComplete(message: string, duration?: number) {
    this.clearSpinner();
    const elapsed = duration || Date.now() - this.stepStartTime;
    console.log(`[✓] ${message} (${this.formatDuration(elapsed)})`);
  }

  phaseError(message: string, error?: any) {
    this.clearSpinner();
    console.log(`[✗] ${message}`);
    if (error && this.isVerbose) {
      console.error(`   Error details: ${error}`);
    }
  }

  // Tree-style logging for hierarchical operations
  step(message: string, level: number = 0) {
    this.clearSpinner();
    const indent = this.getIndent(level);
    this.startSpinner(`${indent}${message}`, level);
  }

  stepComplete(message: string, duration?: number, level: number = 0) {
    this.clearSpinner();
    const indent = this.getIndent(level);
    const elapsed = duration || Date.now() - this.stepStartTime;
    console.log(`${indent}[✓] ${message} (${this.formatDuration(elapsed)})`);
  }

  stepLast(message: string, duration?: number, level: number = 0) {
    this.clearSpinner();
    const indent = this.getIndent(level);
    const elapsed = duration || Date.now() - this.stepStartTime;
    console.log(`${indent}[✓] ${message} (${this.formatDuration(elapsed)})`);
  }

  stepError(message: string, error?: any, level: number = 0) {
    this.clearSpinner();
    const indent = this.getIndent(level);
    console.log(`${indent}[✗] ${message}`);
    if (error && this.isVerbose) {
      console.error(`${indent}   Error: ${error}`);
    }
  }

  // Server-specific operations
  server(hostname: string) {
    this.clearSpinner();
    console.log(`  └─ ${hostname}`);
  }

  serverStep(message: string, isLast: boolean = false) {
    this.clearSpinner();
    const symbol = isLast ? "└─" : "├─";
    this.startSpinnerAtPosition(`     ${symbol} `, message, 2);
  }

  serverStepComplete(
    message: string,
    duration?: number,
    isLast: boolean = false
  ) {
    this.clearSpinner();
    const symbol = isLast ? "└─" : "├─";
    const elapsed = duration || Date.now() - this.stepStartTime;
    console.log(
      `     ${symbol} [✓] ${message} (${this.formatDuration(elapsed)})`
    );
  }

  serverStepError(message: string, error?: any, isLast: boolean = false) {
    this.clearSpinner();
    const symbol = isLast ? "└─" : "├─";
    console.log(`     ${symbol} [✗] ${message}`);
    if (error && this.isVerbose) {
      console.error(`        Error: ${error}`);
    }
  }

  // Final results
  deploymentComplete(urls: string[] = []) {
    this.clearSpinner();
    const totalDuration = Date.now() - this.startTime;
    console.log(
      `[✓] Deployment completed successfully in ${this.formatDuration(
        totalDuration
      )}\n`
    );

    if (urls.length > 0) {
      console.log(`Your app is live at:`);
      urls.forEach((url, index) => {
        const isLast = index === urls.length - 1;
        const symbol = isLast ? "└─" : "├─";
        console.log(`  ${symbol} ${url}`);
      });
    }
  }

  deploymentFailed(error: any) {
    this.clearSpinner();
    const totalDuration = Date.now() - this.startTime;
    console.log(
      `[✗] Deployment failed after ${this.formatDuration(totalDuration)}`
    );
    if (this.isVerbose && error) {
      console.error(`\nError details: ${error}`);
    }
  }

  // Verbose logging (only shown if verbose mode is enabled)
  verboseLog(message: string) {
    if (this.isVerbose) {
      this.clearSpinner();
      console.log(`   ${message}`);
      // Restart spinner if one was active
      if (this.activeSpinner) {
        this.restartSpinner();
      }
    }
  }

  // Warning messages
  warn(message: string) {
    this.clearSpinner();
    console.warn(`[!] ${message}`);
  }

  // Error messages
  error(message: string, error?: any) {
    this.clearSpinner();
    console.error(`[✗] ${message}`);
    if (error && this.isVerbose) {
      console.error(`   Error details: ${error}`);
    }
  }

  // Info messages
  info(message: string) {
    this.clearSpinner();
    console.log(`[i] ${message}`);
  }

  // Spinner management
  private startSpinner(message: string, level: number = 0) {
    this.clearSpinner();

    const startTime = Date.now();
    this.stepStartTime = startTime;

    const updateSpinner = () => {
      const elapsed = Date.now() - startTime;
      const spinner = this.spinnerChars[this.spinnerIndex];
      const timeStr = this.formatDuration(elapsed);

      // Clear the current line and write the spinner
      process.stdout.write("\r\x1b[K");
      process.stdout.write(`[${spinner}] ${message}... (${timeStr})`);

      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerChars.length;
    };

    // Initial display
    updateSpinner();

    // Set up interval for updates
    const interval = setInterval(updateSpinner, 100);

    this.activeSpinner = {
      startTime,
      interval,
      message,
      level,
    };
  }

  private startSpinnerAtPosition(
    prefix: string,
    message: string,
    level: number = 0
  ) {
    this.clearSpinner();

    const startTime = Date.now();
    this.stepStartTime = startTime;

    const updateSpinner = () => {
      const elapsed = Date.now() - startTime;
      const spinner = this.spinnerChars[this.spinnerIndex];
      const timeStr = this.formatDuration(elapsed);

      // Clear the current line and write the spinner with prefix positioning
      process.stdout.write("\r\x1b[K");
      process.stdout.write(`${prefix}[${spinner}] ${message}... (${timeStr})`);

      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerChars.length;
    };

    // Initial display
    updateSpinner();

    // Set up interval for updates
    const interval = setInterval(updateSpinner, 100);

    this.activeSpinner = {
      startTime,
      interval,
      message: `${prefix}${message}`, // Store full message for restart
      level,
    };
  }

  private clearSpinner() {
    if (this.activeSpinner) {
      clearInterval(this.activeSpinner.interval);
      // Clear the current line
      process.stdout.write("\r\x1b[K");
      this.activeSpinner = null;
    }
  }

  private restartSpinner() {
    if (this.activeSpinner) {
      const { message, level } = this.activeSpinner;
      this.startSpinner(message, level);
    }
  }

  // Helper methods
  private getIndent(level: number): string {
    return "  ".repeat(level);
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    const seconds = (ms / 1000).toFixed(1);
    return `${seconds}s`;
  }

  // Time tracking
  startStep() {
    this.stepStartTime = Date.now();
  }

  getStepDuration(): number {
    return Date.now() - this.stepStartTime;
  }

  // Clean up on exit
  cleanup() {
    this.clearSpinner();
  }
}

// Export a default logger instance
export const logger = new Logger();
