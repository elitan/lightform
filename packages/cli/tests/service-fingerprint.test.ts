import { describe, it, expect, beforeEach } from 'bun:test';
import {
  createServiceConfigHash,
  createSecretsHash,
  shouldRedeploy,
  ServiceFingerprint,
  createServiceFingerprint,
  isBuiltService,
  getLocalImageHash
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

      const hash1 = createServiceConfigHash(service, {});
      const hash2 = createServiceConfigHash(service, {});
      
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

      const hash1 = createServiceConfigHash(service1, {});
      const hash2 = createServiceConfigHash(service2, {});
      
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

      const hash1 = createServiceConfigHash(service1, {});
      const hash2 = createServiceConfigHash(service2, {});
      
      expect(hash1).toBe(hash2); // Should be same despite different order
    });

    it('should include environment variables in config hash', () => {
      const service1: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'myapp',
        environment: {
          plain: ['NODE_ENV=production'],
          secret: ['DATABASE_URL']
        }
      };

      const service2: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'myapp',
        environment: {
          plain: ['NODE_ENV=staging'], // Different value
          secret: ['DATABASE_URL']
        }
      };

      const hash1 = createServiceConfigHash(service1, {});
      const hash2 = createServiceConfigHash(service2, {});
      
      expect(hash1).not.toBe(hash2);
    });

    it('should include secret values in config hash', () => {
      const service: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        image: 'myapp',
        environment: {
          secret: ['DATABASE_URL']
        }
      };

      const secrets1 = { DATABASE_URL: 'postgres://old-server/db' };
      const secrets2 = { DATABASE_URL: 'postgres://new-server/db' };

      const hash1 = createServiceConfigHash(service, secrets1);
      const hash2 = createServiceConfigHash(service, secrets2);
      
      expect(hash1).not.toBe(hash2); // Should differ when secret values change
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

  describe('isBuiltService', () => {
    it('should return true for services with build configuration', () => {
      const service: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        build: {
          context: '.',
          dockerfile: 'Dockerfile'
        }
      };

      expect(isBuiltService(service)).toBe(true);
    });

    it('should return false for services with image only', () => {
      const service: ServiceEntry = {
        name: 'db',
        server: 'example.com',
        image: 'postgres:15'
      };

      expect(isBuiltService(service)).toBe(false);
    });
  });

  describe('createServiceFingerprint', () => {
    it('should create built service fingerprint', async () => {
      const service: ServiceEntry = {
        name: 'web',
        server: 'example.com',
        build: {
          context: '.',
          dockerfile: 'Dockerfile'
        },
        environment: {
          secret: ['DATABASE_URL']
        }
      };

      const secrets: IopSecrets = {
        DATABASE_URL: 'postgres://localhost/db'
      };

      const fingerprint = await createServiceFingerprint(service, secrets, 'myproject');

      expect(fingerprint.type).toBe('built');
      expect(fingerprint.configHash).toBeDefined();
      expect(fingerprint.secretsHash).toBeDefined();
      // localImageHash may be undefined if image doesn't exist locally
      expect(typeof fingerprint.localImageHash === 'string' || typeof fingerprint.localImageHash === 'undefined').toBe(true);
      expect(fingerprint.imageReference).toBeUndefined();
    });

    it('should create external service fingerprint', async () => {
      const service: ServiceEntry = {
        name: 'db',
        server: 'example.com',
        image: 'postgres:15',
        environment: {
          secret: ['POSTGRES_PASSWORD']
        }
      };

      const secrets: IopSecrets = {
        POSTGRES_PASSWORD: 'secretpassword'
      };

      const fingerprint = await createServiceFingerprint(service, secrets);

      expect(fingerprint.type).toBe('external');
      expect(fingerprint.configHash).toBeDefined();
      expect(fingerprint.secretsHash).toBeDefined();
      expect(fingerprint.imageReference).toBe('postgres:15');
      expect(fingerprint.localImageHash).toBeUndefined();
    });
  });

  describe('shouldRedeploy', () => {  
    const builtFingerprint: ServiceFingerprint = {
      type: 'built',
      configHash: 'abc123',
      secretsHash: 'ghi789',
      localImageHash: 'sha256:image123'
    };

    const externalFingerprint: ServiceFingerprint = {
      type: 'external',
      configHash: 'abc123',
      secretsHash: 'ghi789',
      imageReference: 'postgres:15'
    };

    it('should require redeploy for first deployment', () => {
      const result = shouldRedeploy(null, builtFingerprint);
      
      expect(result.shouldRedeploy).toBe(true);
      expect(result.reason).toBe('first deployment');
      expect(result.priority).toBe('normal');
    });

    it('should require redeploy when configuration changes', () => {
      const current = { ...builtFingerprint };
      const desired = { ...builtFingerprint, configHash: 'changed123' };
      
      const result = shouldRedeploy(current, desired);
      
      expect(result.shouldRedeploy).toBe(true);
      expect(result.reason).toBe('configuration changed');
      expect(result.priority).toBe('critical');
    });

    it('should require redeploy when secrets structure changes', () => {
      const current = { ...builtFingerprint };
      const desired = { ...builtFingerprint, secretsHash: 'changed789' };
      
      const result = shouldRedeploy(current, desired);
      
      expect(result.shouldRedeploy).toBe(true);
      expect(result.reason).toBe('secrets changed');
      expect(result.priority).toBe('critical');
    });

    it('should require redeploy when built service image changes', () => {
      const current = { ...builtFingerprint, localImageHash: 'sha256:old123' };
      const desired = { ...builtFingerprint, localImageHash: 'sha256:new456' };
      
      const result = shouldRedeploy(current, desired);
      
      expect(result.shouldRedeploy).toBe(true);
      expect(result.reason).toBe('image updated');
      expect(result.priority).toBe('normal');
    });

    it('should require redeploy when external service image reference changes', () => {
      const current = { ...externalFingerprint, imageReference: 'postgres:15' };
      const desired = { ...externalFingerprint, imageReference: 'postgres:16' };
      
      const result = shouldRedeploy(current, desired);
      
      expect(result.shouldRedeploy).toBe(true);
      expect(result.reason).toBe('image version updated');
      expect(result.priority).toBe('normal');
    });

    it('should require redeploy when server image differs from local', () => {
      const current = { ...builtFingerprint, serverImageHash: 'sha256:server123' };
      const desired = { ...builtFingerprint, localImageHash: 'sha256:local456' };
      
      const result = shouldRedeploy(current, desired);
      
      expect(result.shouldRedeploy).toBe(true);
      expect(result.reason).toBe('image updated');
      expect(result.priority).toBe('normal');
    });

    it('should not require redeploy when fingerprints match', () => {
      const current = { ...builtFingerprint, serverImageHash: 'sha256:image123' };
      const desired = { ...builtFingerprint };
      
      const result = shouldRedeploy(current, desired);
      
      expect(result.shouldRedeploy).toBe(false);
      expect(result.reason).toBe('up-to-date, skipped');
      expect(result.priority).toBe('optional');
    });

    it('should not require redeploy for external services when only config matches', () => {
      const current = { ...externalFingerprint };
      const desired = { ...externalFingerprint };
      
      const result = shouldRedeploy(current, desired);
      
      expect(result.shouldRedeploy).toBe(false);
      expect(result.reason).toBe('up-to-date, skipped');
      expect(result.priority).toBe('optional');
    });
  });
});