import { describe, it, expect } from 'bun:test';
import { 
  requiresZeroDowntimeDeployment, 
  getDeploymentStrategy,
  getServiceProxyPort,
  isInfrastructurePort 
} from '../src/utils/service-utils';
import { ServiceEntry } from '../src/config/types';

describe('service-utils', () => {
  describe('requiresZeroDowntimeDeployment', () => {
    it('should return true for services with proxy config', () => {
      const service: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'nginx',
        proxy: {
          app_port: 3000
        }
      };
      
      expect(requiresZeroDowntimeDeployment(service)).toBe(true);
    });

    it('should return true for services with health_check config', () => {
      const service: ServiceEntry = {
        name: 'api',
        server: 'example.com',
        image: 'node:18',
        health_check: {
          path: '/health'
        }
      };
      
      expect(requiresZeroDowntimeDeployment(service)).toBe(true);
    });

    it('should return true for services with exposed ports (no mapping)', () => {
      const service: ServiceEntry = {
        name: 'app',
        server: 'example.com',
        image: 'myapp',
        ports: ['3000', '8080']
      };
      
      expect(requiresZeroDowntimeDeployment(service)).toBe(true);
    });

    it('should return true for services with interface-bound exposed ports', () => {
      const service: ServiceEntry = {
        name: 'app',
        server: 'example.com', 
        image: 'myapp',
        ports: [':3000'] // Bind to all interfaces
      };
      
      expect(requiresZeroDowntimeDeployment(service)).toBe(true);
    });

    it('should return false for services with mapped infrastructure ports', () => {
      const service: ServiceEntry = {
        name: 'db',
        server: 'example.com',
        image: 'postgres:15',
        ports: ['5432:5432'] // Infrastructure port mapping
      };
      
      expect(requiresZeroDowntimeDeployment(service)).toBe(false);
    });

    it('should return false for services with localhost-only ports', () => {
      const service: ServiceEntry = {
        name: 'redis',
        server: 'example.com',
        image: 'redis:7',
        ports: ['127.0.0.1:6379:6379'] // Localhost only
      };
      
      expect(requiresZeroDowntimeDeployment(service)).toBe(false);
    });

    it('should return true for services with external interface ports', () => {
      const service: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'nginx',
        ports: ['0.0.0.0:80:80'] // External interface
      };
      
      expect(requiresZeroDowntimeDeployment(service)).toBe(true);
    });

    it('should return false for services with no special characteristics', () => {
      const service: ServiceEntry = {
        name: 'worker',
        server: 'example.com',
        image: 'myworker'
      };
      
      expect(requiresZeroDowntimeDeployment(service)).toBe(false);
    });
  });

  describe('getDeploymentStrategy', () => {
    it('should return zero-downtime for HTTP services', () => {
      const service: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'nginx',
        proxy: { app_port: 80 }
      };
      
      expect(getDeploymentStrategy(service)).toBe('zero-downtime');
    });

    it('should return stop-start for infrastructure services', () => {
      const service: ServiceEntry = {
        name: 'db',
        server: 'example.com',
        image: 'postgres:15',
        ports: ['5432:5432']
      };
      
      expect(getDeploymentStrategy(service)).toBe('stop-start');
    });
  });

  describe('getServiceProxyPort', () => {
    it('should return explicit proxy port when configured', () => {
      const service: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'nginx',
        proxy: { app_port: 8080 }
      };
      
      expect(getServiceProxyPort(service)).toBe(8080);
    });

    it('should infer port from exposed ports configuration', () => {
      const service: ServiceEntry = {
        name: 'app',
        server: 'example.com',
        image: 'myapp',
        ports: ['3000']
      };
      
      expect(getServiceProxyPort(service)).toBe(3000);
    });

    it('should infer port from interface-bound configuration', () => {
      const service: ServiceEntry = {
        name: 'app', 
        server: 'example.com',
        image: 'myapp',
        ports: [':4000']
      };
      
      expect(getServiceProxyPort(service)).toBe(4000);
    });

    it('should return undefined when no port can be determined', () => {
      const service: ServiceEntry = {
        name: 'worker',
        server: 'example.com',
        image: 'myworker'
      };
      
      expect(getServiceProxyPort(service)).toBeUndefined();
    });
  });

  describe('isInfrastructurePort', () => {
    it('should identify common database ports', () => {
      expect(isInfrastructurePort('5432')).toBe(true); // PostgreSQL
      expect(isInfrastructurePort('3306')).toBe(true); // MySQL
      expect(isInfrastructurePort('6379')).toBe(true); // Redis
      expect(isInfrastructurePort('27017')).toBe(true); // MongoDB
    });

    it('should identify infrastructure ports in mappings', () => {
      expect(isInfrastructurePort('5433:5432')).toBe(true);
      expect(isInfrastructurePort('127.0.0.1:3307:3306')).toBe(true);
    });

    it('should not identify HTTP ports as infrastructure', () => {
      expect(isInfrastructurePort('80')).toBe(false);
      expect(isInfrastructurePort('443')).toBe(false);
      expect(isInfrastructurePort('3000')).toBe(false);
      expect(isInfrastructurePort('8080')).toBe(false);
    });
  });
});