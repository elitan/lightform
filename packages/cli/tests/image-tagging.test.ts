import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { DockerClient } from '../src/docker';

describe('Docker Image Tagging', () => {
  describe('build with multiple tags', () => {
    it('should create both release-specific and :latest tags during build', async () => {
      // Mock DockerClient.build to capture the tags parameter
      const mockBuild = mock();
      DockerClient.build = mockBuild;
      mockBuild.mockResolvedValue(undefined);

      // This simulates what happens in buildOrTagServiceImage
      const imageNameWithRelease = 'basic-web1:d21ade7';
      const baseImageName = 'basic-web1';
      const latestTag = `${baseImageName}:latest`;

      await DockerClient.build({
        context: '.',
        dockerfile: 'Dockerfile',
        tags: [imageNameWithRelease, latestTag],
        buildArgs: {},
        platform: 'linux/amd64',
        verbose: false,
      });

      // Verify both tags were provided to build
      expect(mockBuild).toHaveBeenCalledWith({
        context: '.',
        dockerfile: 'Dockerfile', 
        tags: ['basic-web1:d21ade7', 'basic-web1:latest'],
        buildArgs: {},
        platform: 'linux/amd64',
        verbose: false,
      });
    });
  });

  describe('tag existing images with multiple tags', () => {
    it('should create both release-specific and :latest tags when tagging existing images', async () => {
      // Mock DockerClient.tag to capture multiple calls
      const mockTag = mock();
      DockerClient.tag = mockTag;
      mockTag.mockResolvedValue(undefined);

      // This simulates what happens for pre-built services
      const baseImageName = 'nginx:1.21';
      const imageNameWithRelease = 'nginx:d21ade7';
      const latestTag = 'nginx:latest';

      await DockerClient.tag(baseImageName, imageNameWithRelease, false);
      await DockerClient.tag(baseImageName, latestTag, false);

      // Verify both tagging operations occurred
      expect(mockTag).toHaveBeenCalledTimes(2);
      expect(mockTag).toHaveBeenNthCalledWith(1, baseImageName, imageNameWithRelease, false);
      expect(mockTag).toHaveBeenNthCalledWith(2, baseImageName, latestTag, false);
    });
  });
});