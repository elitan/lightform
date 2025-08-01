import { describe, it, expect, beforeEach } from 'bun:test';
import {
  createServiceConfigHash,
  createEnvironmentHash,
  createSecretsHash,
  shouldRedeploy,
  ServiceFingerprint
} from '../src/utils/service-fingerprint';
import { ServiceEntry, IopSecrets } from '../src/config/types';

describe('service-fingerprint', () => {
  describe('createServiceConfigHash', () => {
    it('should create consistent hashes for identical configurations', () => {
      const service: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'nginx:latest',
        ports: ['80', '443'],
        volumes: ['/data:/app/data'],
        proxy: { app_port: 3000 }
      };

      const hash1 = createServiceConfigHash(service);
      const hash2 = createServiceConfigHash(service);
      
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(12); // Should be truncated to 12 chars
    });

    it('should create different hashes for different configurations', () => {
      const service1: ServiceEntry = {
        name: 'web',
        server: 'example.com',  
        image: 'nginx:1.21'
      };

      const service2: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'nginx:1.22' // Different image version
      };

      const hash1 = createServiceConfigHash(service1);
      const hash2 = createServiceConfigHash(service2);
      
      expect(hash1).not.toBe(hash2);
    });

    it('should sort arrays for consistent hashing', () => {
      const service1: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'myapp',
        ports: ['80', '443'],
        volumes: ['/data:/app/data', '/logs:/app/logs']
      };

      const service2: ServiceEntry = {
        name: 'web', 
        server: 'example.com',
        image: 'myapp',
        ports: ['443', '80'], // Different order
        volumes: ['/logs:/app/logs', '/data:/app/data'] // Different order
      };

      const hash1 = createServiceConfigHash(service1);
      const hash2 = createServiceConfigHash(service2);
      
      expect(hash1).toBe(hash2); // Should be same despite different order
    });
  });

  describe('createEnvironmentHash', () => {
    it('should create hash from plain and secret environment variables', () => {
      const service: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'myapp',
        environment: {
          plain: ['NODE_ENV=production', 'PORT=3000'],
          secret: ['DATABASE_URL', 'API_KEY']
        }
      };

      const secrets: IopSecrets = {
        DATABASE_URL: 'postgres://localhost/mydb',
        API_KEY: 'secret123'
      };

      const hash = createEnvironmentHash(service, secrets);
      
      expect(hash).toBeDefined();
      expect(hash.length).toBe(12);
    });

    it('should create different hashes for different environment values', () => {
      const service: ServiceEntry = {
        name: 'web',
        server: 'example.com', 
        image: 'myapp',
        environment: {
          secret: ['DATABASE_URL']
        }
      };

      const secrets1: IopSecrets = {
        DATABASE_URL: 'postgres://localhost/prod'
      };

      const secrets2: IopSecrets = {
        DATABASE_URL: 'postgres://localhost/staging'
      };

      const hash1 = createEnvironmentHash(service, secrets1);
      const hash2 = createEnvironmentHash(service, secrets2);
      
      expect(hash1).not.toBe(hash2);
    });

    it('should sort environment variables for consistent hashing', () => {
      const service1: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'myapp',
        environment: {
          plain: ['NODE_ENV=production', 'DEBUG=false']
        }
      };

      const service2: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'myapp', 
        environment: {
          plain: ['DEBUG=false', 'NODE_ENV=production'] // Different order
        }
      };

      const secrets: IopSecrets = {};

      const hash1 = createEnvironmentHash(service1, secrets);
      const hash2 = createEnvironmentHash(service2, secrets);
      
      expect(hash1).toBe(hash2);
    });
  });

  describe('createSecretsHash', () => {
    it('should create hash based on secret keys and their availability', () => {
      const service: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'myapp',
        environment: {
          secret: ['DATABASE_URL', 'API_KEY', 'MISSING_KEY']
        }
      };

      const secrets: IopSecrets = {
        DATABASE_URL: 'postgres://localhost/mydb',
        API_KEY: 'secret123'
        // MISSING_KEY is not defined
      };

      const hash = createSecretsHash(service, secrets);
      
      expect(hash).toBeDefined();
      expect(hash.length).toBe(12);
    });

    it('should create different hashes when secret availability changes', () => {
      const service: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'myapp',
        environment: {
          secret: ['DATABASE_URL']
        }
      };

      const secretsWithKey: IopSecrets = {
        DATABASE_URL: 'postgres://localhost/mydb'
      };

      const secretsWithoutKey: IopSecrets = {};

      const hash1 = createSecretsHash(service, secretsWithKey);
      const hash2 = createSecretsHash(service, secretsWithoutKey);
      
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('shouldRedeploy', () => {  
    const baseFingerprint: ServiceFingerprint = {
      configHash: 'abc123',
      environmentHash: 'def456', 
      secretsHash: 'ghi789'
    };

    it('should require redeploy for first deployment', () => {
      const result = shouldRedeploy(null, baseFingerprint);
      
      expect(result.shouldRedeploy).toBe(true);
      expect(result.reason).toBe('First deployment');
      expect(result.priority).toBe('normal');
    });

    it('should require redeploy when configuration changes', () => {
      const current = { ...baseFingerprint };
      const desired = { ...baseFingerprint, configHash: 'changed123' };
      
      const result = shouldRedeploy(current, desired);
      
      expect(result.shouldRedeploy).toBe(true);
      expect(result.reason).toBe('Service configuration changed');
      expect(result.priority).toBe('critical');
    });

    it('should require redeploy when secrets structure changes', () => {
      const current = { ...baseFingerprint };
      const desired = { ...baseFingerprint, secretsHash: 'changed789' };
      
      const result = shouldRedeploy(current, desired);
      
      expect(result.shouldRedeploy).toBe(true);
      expect(result.reason).toBe('Secrets configuration changed');
      expect(result.priority).toBe('critical');
    });

    it('should require redeploy when environment variables change', () => {
      const current = { ...baseFingerprint };
      const desired = { ...baseFingerprint, environmentHash: 'changed456' };
      
      const result = shouldRedeploy(current, desired);
      
      expect(result.shouldRedeploy).toBe(true);
      expect(result.reason).toBe('Environment variables changed');
      expect(result.priority).toBe('normal');
    });

    it('should require redeploy when build context changes', () => {
      const current = { ...baseFingerprint, buildContextHash: 'build123' };
      const desired = { ...baseFingerprint, buildContextHash: 'build456' };
      
      const result = shouldRedeploy(current, desired);
      
      expect(result.shouldRedeploy).toBe(true);
      expect(result.reason).toBe('Code changes detected in build context');
      expect(result.priority).toBe('normal');
    });

    it('should require redeploy when image digest changes', () => {
      const current = { ...baseFingerprint, imageDigest: 'sha256:old123' };
      const desired = { ...baseFingerprint, imageDigest: 'sha256:new456' };
      
      const result = shouldRedeploy(current, desired);
      
      expect(result.shouldRedeploy).toBe(true);
      expect(result.reason).toBe('New image version available');
      expect(result.priority).toBe('normal');
    });

    it('should not require redeploy when fingerprints match', () => {
      const current = { ...baseFingerprint };
      const desired = { ...baseFingerprint };
      
      const result = shouldRedeploy(current, desired);
      
      expect(result.shouldRedeploy).toBe(false);
      expect(result.reason).toBe('No changes detected');
      expect(result.priority).toBe('optional');
    });
  });
});