import { ServiceEntry } from "../config/types";

/**
 * Determines if a service requires zero-downtime deployment based on its characteristics
 */
export function requiresZeroDowntimeDeployment(service: ServiceEntry): boolean {
  // Only services with proxy configuration get zero-downtime deployment
  // All other services (including those with health_check or exposed ports) get stop-start
  return Boolean(service.proxy);
}

/**
 * Determines deployment strategy for a service
 */
export function getDeploymentStrategy(service: ServiceEntry): 'zero-downtime' | 'stop-start' {
  return requiresZeroDowntimeDeployment(service) ? 'zero-downtime' : 'stop-start';
}

/**
 * Gets the effective port for proxy configuration
 */
export function getServiceProxyPort(service: ServiceEntry): number | undefined {
  // Explicit proxy port takes precedence
  if (service.proxy?.app_port) {
    return service.proxy.app_port;
  }
  
  // Infer from exposed ports
  if (service.ports) {
    for (const port of service.ports) {
      if (!port.includes(':') && !isNaN(parseInt(port))) {
        return parseInt(port); // "3000" -> 3000
      }
      if (port.startsWith(':') && !isNaN(parseInt(port.substring(1)))) {
        return parseInt(port.substring(1)); // ":3000" -> 3000
      }
    }
  }
  
  return undefined;
}

/**
 * Checks if a port configuration indicates infrastructure service
 */
export function isInfrastructurePort(port: string): boolean {
  // Common infrastructure ports that are typically mapped, not exposed
  const infraPorts = ['5432', '3306', '6379', '27017', '9200', '5672'];
  
  if (port.includes(':')) {
    const parts = port.split(':');
    const containerPort = parts[parts.length - 1];
    return infraPorts.includes(containerPort);
  }
  
  return infraPorts.includes(port);
}