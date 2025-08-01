import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { getLocalImageHash, createServiceFingerprint } from '../src/utils/service-fingerprint';
import { ServiceEntry, IopSecrets } from '../src/config/types';
import { exec } from 'child_process';

// Mock the exec function used by getLocalImageHash
const mockExec = mock();
mock.module('child_process', () => ({
  exec: mockExec
}));

describe('Latest Tag Fingerprinting', () => {
  beforeEach(() => {
    mockExec.mockClear();
  });

  describe('getLocalImageHash', () => {
    it('should look for :latest tag when checking local image hash', async () => {
      const mockPromisify = mock();
      mockPromisify.mockResolvedValue({ stdout: 'sha256:1234567890ab' });
      
      // Mock promisify to return our mock function
      mock.module('util', () => ({
        promisify: () => mockPromisify
      }));

      await getLocalImageHash('basic-web1');

      // Verify it looks for the :latest tag
      expect(mockPromisify).toHaveBeenCalledWith('docker image ls --format "{{.ID}}" basic-web1:latest');
    });

    it('should return image ID when :latest tag exists', async () => {
      const mockPromisify = mock();
      mockPromisify.mockResolvedValue({ stdout: 'sha256:1234567890ab\\n' });
      
      mock.module('util', () => ({
        promisify: () => mockPromisify
      }));

      const result = await getLocalImageHash('basic-web1');

      expect(result).toBe('sha256:1234567890ab');
    });

    it('should return null when :latest tag does not exist', async () => {
      const mockPromisify = mock();
      mockPromisify.mockRejectedValue(new Error('No such image'));
      
      mock.module('util', () => ({
        promisify: () => mockPromisify
      }));

      const result = await getLocalImageHash('basic-web1');

      expect(result).toBeNull();
    });
  });

  describe('fingerprinting with :latest tags', () => {
    it('should create fingerprint for built service using project-prefixed image name', async () => {
      const mockPromisify = mock();
      mockPromisify.mockResolvedValue({ stdout: 'sha256:1234567890ab\\n' });
      
      mock.module('util', () => ({
        promisify: () => mockPromisify
      }));

      const service: ServiceEntry = {
        name: 'web1',
        server: 'test.com',
        build: {
          context: '.',
          dockerfile: 'Dockerfile'
        }
      };

      const secrets: IopSecrets = {};
      
      const fingerprint = await createServiceFingerprint(service, secrets, 'basic');

      // Should look for basic-web1:latest (project-prefixed)
      expect(mockPromisify).toHaveBeenCalledWith('docker image ls --format "{{.ID}}" basic-web1:latest');
      expect(fingerprint.localImageHash).toBe('sha256:1234567890ab');
    });

    it('should handle missing :latest tag gracefully during fingerprinting', async () => {
      const mockPromisify = mock();
      mockPromisify.mockRejectedValue(new Error('No such image'));
      
      mock.module('util', () => ({
        promisify: () => mockPromisify
      }));

      const service: ServiceEntry = {
        name: 'web1',
        server: 'test.com',
        build: {
          context: '.',
          dockerfile: 'Dockerfile'
        }
      };

      const secrets: IopSecrets = {};
      
      const fingerprint = await createServiceFingerprint(service, secrets, 'basic');

      expect(fingerprint.localImageHash).toBeUndefined();
    });
  });

  describe('integration with build process', () => {
    it('should demonstrate the fix for the original issue', async () => {
      // Simulate the scenario:
      // 1. Build creates both basic-web1:d21ade7 and basic-web1:latest
      // 2. Fingerprinting looks for basic-web1:latest and finds it
      // 3. Second deployment finds the same image hash and skips rebuild

      const mockPromisify = mock();
      
      // First deployment - image doesn't exist yet
      mockPromisify.mockRejectedValueOnce(new Error('No such image'));
      
      // After build - image exists with consistent hash
      mockPromisify.mockResolvedValue({ stdout: 'sha256:1234567890ab\\n' });
      
      mock.module('util', () => ({
        promisify: () => mockPromisify
      }));

      const service: ServiceEntry = {
        name: 'web1',
        server: 'test.com',
        build: {
          context: '.',
          dockerfile: 'Dockerfile',
          args: ['EXAMPLE_VAR']
        },
        environment: {
          plain: ['EXAMPLE_VAR=web1']
        }
      };

      const secrets: IopSecrets = {};

      // First deployment - no local image
      const firstFingerprint = await createServiceFingerprint(service, secrets, 'basic');
      expect(firstFingerprint.localImageHash).toBeUndefined();

      // After build (with :latest tag created) - same code, should have same hash
      const secondFingerprint = await createServiceFingerprint(service, secrets, 'basic');
      expect(secondFingerprint.localImageHash).toBe('sha256:1234567890ab');

      // Third deployment with same code - should still find same hash
      const thirdFingerprint = await createServiceFingerprint(service, secrets, 'basic');
      expect(thirdFingerprint.localImageHash).toBe('sha256:1234567890ab');

      // The key insight: even though git SHA changes between deployments,
      // if the actual code/build context hasn't changed, the :latest tag
      // will point to the same image ID, avoiding unnecessary rebuilds
    });
  });
});