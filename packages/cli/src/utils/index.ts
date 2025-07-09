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
