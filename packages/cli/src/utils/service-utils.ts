import { ServiceEntry } from "../config/types";

/**
 * Determines if a service requires zero-downtime deployment based on its characteristics
 */
export function requiresZeroDowntimeDeployment(service: ServiceEntry): boolean {
  // Explicit HTTP service indicators
  if (service.proxy) return true;
  
  if (service.health_check) return true;
  
  // Check for exposed ports (indicates HTTP service)
  if (service.ports) {
    return service.ports.some((port: string) => {
      // Exposed ports: "3000", ":3000" (bind to all interfaces)
      if (!port.includes(':')) return true; // "3000"
      if (port.startsWith(':')) return true; // ":3000"
      
      // Port mappings typically indicate infrastructure services
      const parts = port.split(':');
      if (parts.length === 2) {
        // Format: "hostPort:containerPort" 
        // Check if this is an infrastructure port
        const containerPort = parts[1];
        if (isInfrastructurePort(containerPort)) {
          return false; // Infrastructure services use stop-start
        }
        return true; // HTTP services exposed to host
      }
      if (parts.length === 3) {
        // Format: "ip:hostPort:containerPort"
        const ip = parts[0];
        const containerPort = parts[2];
        
        // Localhost-only infrastructure services
        if ((ip === '127.0.0.1' || ip === 'localhost') && isInfrastructurePort(containerPort)) {
          return false;
        }
        
        // External interface binding
        return ip !== '127.0.0.1' && ip !== 'localhost';
      }
      
      return false;
    });
  }
  
  return false;
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