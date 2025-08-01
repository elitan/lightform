import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ServiceEntry, IopSecrets } from '../config/types';
// Note: Using glob functionality from @types/glob 
// If glob is not available, we'll use a simpler approach

export interface ServiceFingerprint {
  // Core configuration
  configHash: string;
  
  // Build context (for built services)
  buildContextHash?: string;
  dockerfileHash?: string;
  
  // Image tracking (for pre-built services)
  imageDigest?: string;
  
  // Runtime configuration
  secretsHash: string;
  environmentHash: string;
}

export interface RedeploymentDecision {
  shouldRedeploy: boolean;
  reason: string;
  priority: 'critical' | 'normal' | 'optional';
}

/**
 * Creates a configuration hash for a service entry
 */
export function createServiceConfigHash(serviceEntry: ServiceEntry): string {
  const configForHash = {
    image: serviceEntry.image,
    ports: serviceEntry.ports?.sort() || [],
    volumes: serviceEntry.volumes?.sort() || [],
    command: serviceEntry.command,
    replicas: serviceEntry.replicas || 1,
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
  };
  
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(configForHash))
    .digest('hex')
    .substring(0, 12);
}

/**
 * Creates environment hash from resolved environment variables
 */
export function createEnvironmentHash(
  serviceEntry: ServiceEntry,
  secrets: IopSecrets
): string {
  const envVars: Record<string, string> = {};
  
  // Add plain environment variables
  if (serviceEntry.environment?.plain) {
    for (const envVar of serviceEntry.environment.plain) {
      const [key, ...valueParts] = envVar.split('=');
      if (key && valueParts.length > 0) {
        envVars[key] = valueParts.join('=');
      }
    }
  }
  
  // Add secret environment variables
  if (serviceEntry.environment?.secret) {
    for (const secretKey of serviceEntry.environment.secret) {
      if (secrets[secretKey] !== undefined) {
        envVars[secretKey] = secrets[secretKey];
      }
    }
  }
  
  // Sort keys for consistent hashing
  const sortedEnvVars = Object.keys(envVars)
    .sort()
    .reduce((result: Record<string, string>, key: string) => {
      result[key] = envVars[key];
      return result;
    }, {} as Record<string, string>);
  
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(sortedEnvVars))
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
 * Reads and parses .dockerignore file
 */
async function parseDockerignore(buildContext: string): Promise<string[]> {
  try {
    const dockerignorePath = path.join(buildContext, '.dockerignore');
    const content = await fs.readFile(dockerignorePath, 'utf8');
    return content
      .split('\\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Calculates build context hash for services that need building
 */
export async function calculateBuildContextHash(
  serviceEntry: ServiceEntry
): Promise<string | undefined> {
  if (!serviceEntry.build) return undefined;
  
  const buildContext = serviceEntry.build.context;
  const dockerfile = serviceEntry.build.dockerfile || 'Dockerfile';
  
  try {
    const hash = crypto.createHash('sha256');
    
    // Hash Dockerfile content
    const dockerfilePath = path.join(buildContext, dockerfile);
    try {
      const dockerfileContent = await fs.readFile(dockerfilePath, 'utf8');
      hash.update(`dockerfile:${dockerfileContent}`);
    } catch (error) {
      // If Dockerfile doesn't exist, still create a hash but mark it as missing
      hash.update(`dockerfile:MISSING`);
    }
    
    // Get .dockerignore patterns
    const ignorePatterns = await parseDockerignore(buildContext);
    
    // Simple file walking without glob dependency
    // For now, just hash the Dockerfile and a few key files
    const files: string[] = [];
    
    // Add some common files that affect builds
    const commonFiles = [
      'package.json',
      'package-lock.json', 
      'yarn.lock',
      'bun.lockb',
      'requirements.txt',
      'Cargo.toml',
      'go.mod',
      'pom.xml'
    ];
    
    for (const file of commonFiles) {
      try {
        const filePath = path.join(buildContext, file);
        await fs.access(filePath);
        files.push(file);
      } catch {
        // File doesn't exist, skip it
      }
    }
    
    // Files are already sorted
    const sortedFiles = files.sort();
    
    // Hash file paths and contents (but limit file count for performance)
    const maxFiles = 100; // Limit to avoid performance issues
    const filesToHash = sortedFiles.slice(0, maxFiles);
    
    for (const file of filesToHash) {
      const filePath = path.join(buildContext, file);
      try {
        const stats = await fs.stat(filePath);
        if (stats.isFile() && stats.size < 1024 * 1024) { // Only hash files < 1MB
          const content = await fs.readFile(filePath);
          hash.update(`${file}:${content.toString()}`);
        } else {
          // For large files, just hash the path and mtime
          hash.update(`${file}:${stats.mtime.getTime()}`);
        }
      } catch {
        // Skip files that can't be read
        hash.update(`${file}:UNREADABLE`);
      }
    }
    
    return hash.digest('hex').substring(0, 12);
  } catch (error) {
    // If we can't calculate build context hash, return undefined
    // This will cause the service to be redeployed (safe fallback)
    return undefined;
  }
}

/**
 * Creates a complete service fingerprint
 */
export async function createServiceFingerprint(
  serviceEntry: ServiceEntry,
  secrets: IopSecrets
): Promise<ServiceFingerprint> {
  const configHash = createServiceConfigHash(serviceEntry);
  const environmentHash = createEnvironmentHash(serviceEntry, secrets);
  const secretsHash = createSecretsHash(serviceEntry, secrets);
  
  let buildContextHash: string | undefined;
  if (serviceEntry.build) {
    buildContextHash = await calculateBuildContextHash(serviceEntry);
  }
  
  return {
    configHash,
    buildContextHash,
    environmentHash,
    secretsHash,
  };
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
      reason: 'First deployment',
      priority: 'normal'
    };
  }
  
  // Critical: Configuration changes
  if (current.configHash !== desired.configHash) {
    return {
      shouldRedeploy: true,
      reason: 'Service configuration changed',
      priority: 'critical'
    };
  }
  
  // Critical: Secrets structure changed
  if (current.secretsHash !== desired.secretsHash) {
    return {
      shouldRedeploy: true,
      reason: 'Secrets configuration changed',
      priority: 'critical'
    };
  }
  
  // Normal: Environment variables changed
  if (current.environmentHash !== desired.environmentHash) {
    return {
      shouldRedeploy: true,
      reason: 'Environment variables changed',
      priority: 'normal'
    };
  }
  
  // Normal: Build context changed (for built services)
  if (desired.buildContextHash && current.buildContextHash !== desired.buildContextHash) {
    return {
      shouldRedeploy: true,
      reason: 'Code changes detected in build context',
      priority: 'normal'
    };
  }
  
  // Normal: Image digest changed (for pre-built services)
  if (desired.imageDigest && current.imageDigest !== desired.imageDigest) {
    return {
      shouldRedeploy: true,
      reason: 'New image version available',
      priority: 'normal'
    };
  }
  
  return {
    shouldRedeploy: false,
    reason: 'No changes detected',
    priority: 'optional'
  };
}