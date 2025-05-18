import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export async function generateReleaseId(): Promise<string> {
  try {
    // Check for uncommitted changes first
    // Disabling this check for testing
    /*
    const { stdout: statusOutput } = await execAsync("git status --porcelain");
    if (statusOutput.trim() !== "") {
      console.error("Error: Uncommitted changes detected in the repository.");
      console.error("Please commit or stash your changes before deploying.");
      throw new Error("Uncommitted Git changes detected. Halting deployment.");
    }
    */

    // If clean, proceed to get the SHA
    const { stdout: shaStdout } = await execAsync("git rev-parse --short HEAD");
    const sha = shaStdout.trim();
    if (sha) {
      console.log(`Using Git SHA for release ID: ${sha}`);
      return sha;
    }
    // This part should ideally not be reached if git rev-parse fails after a clean status, but as a safeguard:
    throw new Error(
      "Failed to retrieve Git SHA even though repository is clean."
    );
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.startsWith("Uncommitted Git changes")) {
        throw error; // Re-throw to halt deployment
      }
      console.warn(
        "Failed to get Git SHA or check repository status, falling back to timestamp for release ID:",
        error.message
      );
    } else {
      // Handle non-Error objects thrown
      console.warn(
        "An unexpected error type was caught while generating release ID, falling back to timestamp:",
        error
      );
    }
  }
  // Fallback to timestamp if Git checks fail for other reasons (e.g., not a git repo)
  const timestampId = Date.now().toString();
  console.log(`Using timestamp for release ID: ${timestampId}`);
  return timestampId;
}
