import { AppEntry } from '../config/types';

/**
 * Checks if an app needs to be built locally (vs using a pre-built image)
 */
export function appNeedsBuilding(appEntry: AppEntry): boolean {
  // If it has a build config, it needs building
  if (appEntry.build) {
    return true;
  }

  // If it doesn't have an image field, it needs building
  if (!appEntry.image) {
    return true;
  }

  // Apps with image field but no build config are pre-built
  return false;
}

/**
 * Gets the base image name for an app
 */
export function getAppImageName(appEntry: AppEntry): string {
  // If image is specified, use it as the base name
  if (appEntry.image) {
    return appEntry.image;
  }

  // Otherwise, generate a name based on the app name
  return `${appEntry.name}`;
}

/**
 * Builds the full image name with release ID for built apps, or returns original name for pre-built apps
 */
export function buildImageName(appEntry: AppEntry, releaseId: string): string {
  const baseImageName = getAppImageName(appEntry);

  // For apps that need building, use release ID
  if (appNeedsBuilding(appEntry)) {
    return `${baseImageName}:${releaseId}`;
  }
  // For pre-built apps, use the image as-is (if it exists)
  return appEntry.image || baseImageName;
}