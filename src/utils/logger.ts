export interface LoggerOptions {
  verbose?: boolean;
}

export class Logger {
  private startTime: number = Date.now();
  private stepStartTime: number = Date.now();
  private isVerbose: boolean;

  constructor(options: LoggerOptions = {}) {
    this.isVerbose = options.verbose || false;
  }

  // Main phase headers
  deploymentStart(releaseId: string) {
    console.log(`🚀 Starting deployment with release ${releaseId}\n`);
    this.startTime = Date.now();
  }

  phase(message: string) {
    console.log(`${message}`);
    this.stepStartTime = Date.now();
  }

  phaseComplete(message: string, duration?: number) {
    const elapsed = duration || Date.now() - this.stepStartTime;
    console.log(`✅ ${message} (${this.formatDuration(elapsed)})\n`);
  }

  phaseError(message: string, error?: any) {
    console.log(`❌ ${message}`);
    if (error && this.isVerbose) {
      console.error(`   Error details: ${error}`);
    }
    console.log();
  }

  // Tree-style logging for hierarchical operations
  step(message: string, level: number = 0) {
    const indent = this.getIndent(level);
    console.log(`${indent}├─ ${message}`);
  }

  stepComplete(message: string, duration?: number, level: number = 0) {
    const indent = this.getIndent(level);
    const elapsed = duration || Date.now() - this.stepStartTime;
    console.log(`${indent}├─ ${message} ✅ (${this.formatDuration(elapsed)})`);
  }

  stepLast(message: string, duration?: number, level: number = 0) {
    const indent = this.getIndent(level);
    const elapsed = duration || Date.now() - this.stepStartTime;
    console.log(`${indent}└─ ${message} ✅ (${this.formatDuration(elapsed)})`);
  }

  stepError(message: string, error?: any, level: number = 0) {
    const indent = this.getIndent(level);
    console.log(`${indent}├─ ${message} ❌`);
    if (error && this.isVerbose) {
      console.error(`${indent}   Error: ${error}`);
    }
  }

  // Server-specific operations
  server(hostname: string) {
    console.log(`  └─ ${hostname}`);
  }

  serverStep(message: string, isLast: boolean = false) {
    const symbol = isLast ? "└─" : "├─";
    console.log(`     ${symbol} ${message}`);
  }

  serverStepComplete(
    message: string,
    duration?: number,
    isLast: boolean = false
  ) {
    const symbol = isLast ? "└─" : "├─";
    const elapsed = duration || Date.now() - this.stepStartTime;
    console.log(
      `     ${symbol} ${message} ✅ (${this.formatDuration(elapsed)})`
    );
  }

  serverStepError(message: string, error?: any, isLast: boolean = false) {
    const symbol = isLast ? "└─" : "├─";
    console.log(`     ${symbol} ${message} ❌`);
    if (error && this.isVerbose) {
      console.error(`        Error: ${error}`);
    }
  }

  // Final results
  deploymentComplete(urls: string[] = []) {
    const totalDuration = Date.now() - this.startTime;
    console.log(
      `✅ Deployment completed successfully in ${this.formatDuration(
        totalDuration
      )}\n`
    );

    if (urls.length > 0) {
      console.log(`🌐 Your app is live at:`);
      urls.forEach((url, index) => {
        const isLast = index === urls.length - 1;
        const symbol = isLast ? "└─" : "├─";
        console.log(`  ${symbol} ${url}`);
      });
    }
  }

  deploymentFailed(error: any) {
    const totalDuration = Date.now() - this.startTime;
    console.log(
      `❌ Deployment failed after ${this.formatDuration(totalDuration)}`
    );
    if (this.isVerbose && error) {
      console.error(`\nError details: ${error}`);
    }
  }

  // Verbose logging (only shown if verbose mode is enabled)
  verbose(message: string) {
    if (this.isVerbose) {
      console.log(`   ${message}`);
    }
  }

  // Warning messages
  warn(message: string) {
    console.warn(`⚠️  ${message}`);
  }

  // Error messages
  error(message: string, error?: any) {
    console.error(`❌ ${message}`);
    if (error && this.isVerbose) {
      console.error(`   Error details: ${error}`);
    }
  }

  // Info messages
  info(message: string) {
    console.log(`ℹ️  ${message}`);
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
}

// Export a default logger instance
export const logger = new Logger();
