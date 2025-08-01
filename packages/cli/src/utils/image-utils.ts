import { ServiceEntry } from '../config/types';

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

// Legacy function aliases for backward compatibility
export const appNeedsBuilding = serviceNeedsBuilding;
export const getAppImageName = getServiceImageName;
export const buildImageName = buildServiceImageName;