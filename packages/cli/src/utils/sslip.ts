import { execSync } from 'child_process';
import crypto from 'crypto';

/**
 * Validates if a string is a valid IPv4 address
 */
function isValidIPv4(ip: string): boolean {
  const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  return ipRegex.test(ip);
}

/**
 * Sanitizes a hostname or IP address for DNS usage
 */
function sanitizeHostForDns(host: string): string {
  return host.replace(/\./g, '-').replace(/[^a-zA-Z0-9-]/g, '');
}

/**
 * Generates a deterministic hash for x.mylightform.cloud domain
 */
function generateDeterministicHash(projectName: string, appName: string, serverHost: string): string {
  const input = `${projectName}:${appName}:${serverHost}`;
  return crypto.createHash('sha256').update(input).digest('hex').substring(0, 8);
}

/**
 * Generates a deterministic x.mylightform.cloud domain for an app
 */
export function generateAppSslipDomain(
  projectName: string,
  appName: string, 
  serverHost: string
): string {
  const hash = generateDeterministicHash(projectName, appName, serverHost);
  const sanitizedHost = sanitizeHostForDns(serverHost);
  
  return `${hash}-${appName}-lightform-${sanitizedHost}.x.mylightform.cloud`;
}

/**
 * Checks if x.mylightform.cloud should be used for domain generation
 */
export function shouldUseSslip(hosts?: string[]): boolean {
  // Use x.mylightform.cloud if no custom hosts are specified
  return !hosts || hosts.length === 0;
}