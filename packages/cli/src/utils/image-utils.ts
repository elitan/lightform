import { AppEntry, ServiceEntry } from '../config/types';

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

/**
 * Checks if a service needs to be built locally (vs using a pre-built image)
 */
export function serviceNeedsBuilding(serviceEntry: ServiceEntry): boolean {
  // If it has a build config, it needs building
  if (serviceEntry.build) {
    return true;
  }

  // If it doesn't have an image field, it needs building
  if (!serviceEntry.image) {
    return true;
  }

  // Services with image field but no build config are pre-built
  return false;
}

/**
 * Gets the base image name for a service
 */
export function getServiceImageName(serviceEntry: ServiceEntry): string {
  // If image is specified, use it as the base name
  if (serviceEntry.image) {
    return serviceEntry.image;
  }

  // Otherwise, generate a name based on the service name
  return `${serviceEntry.name}`;
}

/**
 * Builds the full image name with release ID for built services, or returns original name for pre-built services
 */
export function buildServiceImageName(serviceEntry: ServiceEntry, releaseId: string): string {
  const baseImageName = getServiceImageName(serviceEntry);

  // For services that need building, use release ID
  if (serviceNeedsBuilding(serviceEntry)) {
    return `${baseImageName}:${releaseId}`;
  }
  // For pre-built services, use the image as-is (if it exists)
  return serviceEntry.image || baseImageName;
}