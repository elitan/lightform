// General utilities will go here

export * from "./release";
// Add other utils exports here as they are created

export function getProjectNetworkName(projectName: string): string {
  if (!projectName || projectName.trim() === "") {
    throw new Error(
      "Project name cannot be empty when generating network name."
    );
  }
  // Sanitize project name to be DNS-friendly for network naming
  const sanitizedProjectName = projectName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  return `${sanitizedProjectName}-network`;
}

export * from "./port-checker";
export * from "./config-validator";

/**
 * Sanitizes a string to be safe for use as a folder name
 */
export function sanitizeFolderName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\-_]/g, "-") // Replace invalid chars with hyphens
    .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .toLowerCase();
}

/**
 * Processes volume mappings to ensure project isolation and proper path resolution
 * @param volumes Array of volume mappings (e.g., ["mydata:/data", "./local:/app"])
 * @param projectName Project name for prefixing
 * @returns Processed volume mappings with project prefixes and resolved paths
 */
export function processVolumes(
  volumes: string[] | undefined,
  projectName: string
): string[] {
  if (!volumes || volumes.length === 0) {
    return [];
  }

  const sanitizedProjectName = sanitizeFolderName(projectName);

  return volumes.map((volume) => {
    const [source, destination, ...rest] = volume.split(":");

    if (!destination) {
      throw new Error(
        `Invalid volume mapping: "${volume}". Expected format: "source:destination" or "source:destination:options"`
      );
    }

    let processedSource: string;

    if (
      source.startsWith("./") ||
      source.startsWith("../") ||
      !source.startsWith("/")
    ) {
      // Relative path or local directory - convert to project-specific bind mount
      const relativePath = source.startsWith("./") ? source.slice(2) : source;
      processedSource = `~/.iop/projects/${sanitizedProjectName}/${relativePath}`;
    } else if (source.startsWith("/")) {
      // Absolute path - use as-is (but warn user)
      processedSource = source;
    } else {
      // Named volume - prefix with project name
      const sanitizedVolumeName = sanitizeFolderName(source);
      processedSource = `${sanitizedProjectName}-${sanitizedVolumeName}`;
    }

    // Reconstruct the volume mapping
    const processedVolume =
      rest.length > 0
        ? `${processedSource}:${destination}:${rest.join(":")}`
        : `${processedSource}:${destination}`;

    return processedVolume;
  });
}

/**
 * Creates necessary project directories on the remote server
 * @param sshClient SSH client connection
 * @param projectName Project name
 */
export async function ensureProjectDirectories(
  sshClient: any,
  projectName: string
): Promise<void> {
  const sanitizedProjectName = sanitizeFolderName(projectName);
  const projectDir = `~/.iop/projects/${sanitizedProjectName}`;

  try {
    await sshClient.exec(`mkdir -p "${projectDir}"`);
  } catch (error) {
    throw new Error(
      `Failed to create project directory ${projectDir}: ${error}`
    );
  }
}
