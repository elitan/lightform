import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ServiceEntry, IopSecrets } from '../config/types';
import { SSHClient } from '../ssh';

const execAsync = promisify(exec);

export interface ServiceFingerprint {
  type: 'built' | 'external';
  configHash: string;
  secretsHash: string;
  
  // For built services
  localImageHash?: string;
  serverImageHash?: string;
  
  // For external services  
  imageReference?: string;
}

export interface RedeploymentDecision {
  shouldRedeploy: boolean;
  reason: string;
  priority: 'critical' | 'normal' | 'optional';
}

/**
 * Creates a configuration hash for a service entry
 */
export function createServiceConfigHash(serviceEntry: ServiceEntry, secrets?: IopSecrets): string {
  const configForHash = {
    image: serviceEntry.image,
    ports: serviceEntry.ports?.sort() || [],
    volumes: serviceEntry.volumes?.sort() || [],
    command: serviceEntry.command,
    replicas: serviceEntry.replicas || 1,
    restart: (serviceEntry as any).restart,
    proxy: serviceEntry.proxy ? {
      hosts: serviceEntry.proxy.hosts?.sort() || [],
      app_port: serviceEntry.proxy.app_port,
      ssl: serviceEntry.proxy.ssl,
      ssl_redirect: serviceEntry.proxy.ssl_redirect,
      forward_headers: serviceEntry.proxy.forward_headers,
      response_timeout: serviceEntry.proxy.response_timeout,
    } : undefined,
    health_check: serviceEntry.health_check,
    build: serviceEntry.build ? {
      context: serviceEntry.build.context,
      dockerfile: serviceEntry.build.dockerfile,
      target: serviceEntry.build.target,
      platform: serviceEntry.build.platform,
      args: serviceEntry.build.args?.sort() || [],
    } : undefined,
    // Include environment in config hash with actual secret values
    environment: {
      plain: serviceEntry.environment?.plain?.sort() || [],
      secret: serviceEntry.environment?.secret?.sort() || [],
      // Include resolved secret values for change detection
      secretValues: secrets ? 
        serviceEntry.environment?.secret?.reduce((acc, key) => {
          if (secrets[key] !== undefined) {
            acc[key] = secrets[key];
          }
          return acc;
        }, {} as Record<string, string>) || {} : {},
    },
  };
  
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(configForHash))
    .digest('hex')
    .substring(0, 12);
}

/**
 * Creates secrets hash from secret keys (not values for security)
 */
export function createSecretsHash(
  serviceEntry: ServiceEntry,
  secrets: IopSecrets
): string {
  const secretKeys = serviceEntry.environment?.secret || [];
  const secretsForHashing = secretKeys
    .sort()
    .map(key => ({ key, hasValue: secrets[key] !== undefined }));
  
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(secretsForHashing))
    .digest('hex')
    .substring(0, 12);
}

/**
 * Gets the Docker image hash for a locally built image
 */
export async function getLocalImageHash(imageName: string): Promise<string | null> {
  try {
    const result = await execAsync(`docker image ls --format "{{.ID}}" ${imageName}:latest`);
    const imageId = result.stdout.trim();
    return imageId || null;
  } catch (error) {
    return null; // Image doesn't exist locally
  }
}

/**
 * Gets the Docker image hash for a service running on a server
 */
export async function getServerImageHash(
  serviceName: string, 
  projectName: string,
  sshClient: SSHClient
): Promise<string | null> {
  try {
    const containerName = `${projectName}-${serviceName}`;
    const result = await sshClient.exec(`docker inspect ${containerName} --format='{{.Image}}'`);
    return result.trim() || null;
  } catch (error) {
    return null; // Container doesn't exist or error
  }
}

/**
 * Determines if a service is built locally or uses external image
 */
export function isBuiltService(serviceEntry: ServiceEntry): boolean {
  return !!serviceEntry.build;
}

/**
 * Creates a service fingerprint based on service type
 */
export async function createServiceFingerprint(
  serviceEntry: ServiceEntry,
  secrets: IopSecrets,
  projectName?: string
): Promise<ServiceFingerprint> {
  const configHash = createServiceConfigHash(serviceEntry, secrets);
  const secretsHash = createSecretsHash(serviceEntry, secrets);
  
  if (isBuiltService(serviceEntry)) {
    // Built service - get local image hash
    const imageName = projectName ? `${projectName}-${serviceEntry.name}` : serviceEntry.name;
    const localImageHash = await getLocalImageHash(imageName);
    
    return {
      type: 'built',
      configHash,
      secretsHash,
      localImageHash: localImageHash || undefined,
    };
  } else {
    // External service - just track image reference and config
    return {
      type: 'external',
      configHash,
      secretsHash,
      imageReference: serviceEntry.image,
    };
  }
}

/**
 * Determines if a service should be redeployed based on fingerprint comparison
 */
export function shouldRedeploy(
  current: ServiceFingerprint | null,
  desired: ServiceFingerprint
): RedeploymentDecision {
  // No current fingerprint means first deployment
  if (!current) {
    return {
      shouldRedeploy: true,
      reason: 'first deployment',
      priority: 'normal'
    };
  }
  
  // Configuration changes (includes environment variables)
  if (current.configHash !== desired.configHash) {
    return {
      shouldRedeploy: true,
      reason: 'configuration changed',
      priority: 'critical'
    };
  }
  
  // Secrets structure changed
  if (current.secretsHash !== desired.secretsHash) {
    return {
      shouldRedeploy: true,
      reason: 'secrets changed',
      priority: 'critical'
    };
  }
  
  // For built services, check image hash (code changes) after config/secrets
  if (desired.type === 'built') {
    if (current.localImageHash !== desired.localImageHash) {
      return {
        shouldRedeploy: true,
        reason: 'image updated',
        priority: 'normal'
      };
    }
    
    // Also check if server has different image
    if (desired.serverImageHash && current.serverImageHash !== desired.serverImageHash) {
      return {
        shouldRedeploy: true,
        reason: 'server image differs',
        priority: 'normal'
      };
    }
  }
  
  // For external services, check image reference
  if (desired.type === 'external') {
    if (current.imageReference !== desired.imageReference) {
      return {
        shouldRedeploy: true,
        reason: 'image version updated',
        priority: 'normal'
      };
    }
  }
  
  return {
    shouldRedeploy: false,
    reason: 'up-to-date, skipped',
    priority: 'optional'
  };
}

/**
 * Enriches a fingerprint with server-side information
 */
export async function enrichFingerprintWithServerInfo(
  fingerprint: ServiceFingerprint,
  serviceName: string,
  projectName: string,
  sshClient: SSHClient
): Promise<ServiceFingerprint> {
  if (fingerprint.type === 'built') {
    const serverImageHash = await getServerImageHash(serviceName, projectName, sshClient);
    return {
      ...fingerprint,
      serverImageHash: serverImageHash || undefined,
    };
  }
  
  return fingerprint;
}