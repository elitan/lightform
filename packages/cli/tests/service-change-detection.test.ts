import { describe, expect, test, mock } from "bun:test";
import { DockerClient } from "../src/docker";
import { checkServiceConfigChanges } from "../src/commands/deploy";
import type { ServiceEntry, LightformSecrets, LightformConfig, AppEntry } from "../src/config/types";

// Mock service configuration
const baseService: ServiceEntry = {
  name: "postgres",
  image: "postgres:15",
  server: "server.example.com",
  ports: ["5432:5432"],
  volumes: ["postgres_data:/var/lib/postgresql/data"],
  environment: {
    plain: ["POSTGRES_DB=myapp"],
    secret: ["POSTGRES_PASSWORD"]
  }
};

const baseSecrets: LightformSecrets = {
  POSTGRES_PASSWORD: "supersecret123"
};

// Mock current container inspect data
const mockCurrentContainer = {
  Config: {
    Image: "postgres:15",
    Env: [
      "POSTGRES_DB=myapp",
      "POSTGRES_PASSWORD=supersecret123",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "HOSTNAME=container123"
    ],
    Labels: {
      "lightform.config-hash": "abc123def456" // Same hash as desired = no changes
    }
  },
  NetworkSettings: {
    Ports: {
      "5432/tcp": [{ HostPort: "5432" }]
    }
  },
  Mounts: [
    {
      Source: "postgres_data",
      Destination: "/var/lib/postgresql/data"
    }
  ]
};

// Mock desired config
const mockDesiredConfig = {
  image: "postgres:15",
  envVars: {
    POSTGRES_DB: "myapp",
    POSTGRES_PASSWORD: "supersecret123"
  },
  ports: ["5432:5432"],
  volumes: ["postgres_data:/var/lib/postgresql/data"],
  configHash: "abc123def456" // Mock hash for testing
};

describe("Service Configuration Change Detection", () => {
  test("should detect no changes when configuration is identical", () => {
    const result = checkServiceConfigChanges(mockCurrentContainer, mockDesiredConfig, "test-postgres");
    
    expect(result.hasChanges).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  test("should detect image changes", () => {
    const desiredConfigWithNewImage = { ...mockDesiredConfig, image: "postgres:16", configHash: "xyz789new123" };
    const result = checkServiceConfigChanges(mockCurrentContainer, desiredConfigWithNewImage, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Configuration changed");
    expect(result.reason).toContain("abc123def456 → xyz789new123");
  });

  test("should detect environment variable changes", () => {
    const desiredConfigWithNewEnv = {
      ...mockDesiredConfig,
      envVars: {
        POSTGRES_DB: "myapp",
        POSTGRES_PASSWORD: "supersecret123",
        POSTGRES_USER: "newuser" // Added new env var
      },
      configHash: "new456hash789" // Different hash due to env change
    };
    const result = checkServiceConfigChanges(mockCurrentContainer, desiredConfigWithNewEnv, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Configuration changed");
  });

  test("should detect port mapping changes", () => {
    const desiredConfigWithNewPorts = { ...mockDesiredConfig, ports: ["9002:5432"], configHash: "port456change789" };
    const result = checkServiceConfigChanges(mockCurrentContainer, desiredConfigWithNewPorts, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Configuration changed");
  });

  test("should detect volume changes", () => {
    const desiredConfigWithNewVolumes = {
      ...mockDesiredConfig,
      volumes: [
        "postgres_data:/var/lib/postgresql/data",
        "postgres_config:/etc/postgresql" // Added new volume
      ],
      configHash: "vol456change789"
    };
    const result = checkServiceConfigChanges(mockCurrentContainer, desiredConfigWithNewVolumes, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Configuration changed");
  });

  test("should ignore system environment variables", () => {
    const containerWithMoreSystemEnv = {
      ...mockCurrentContainer,
      Config: {
        ...mockCurrentContainer.Config,
        Env: [
          "POSTGRES_DB=myapp",
          "POSTGRES_PASSWORD=supersecret123",
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "HOSTNAME=container123",
          "HOME=/root", // Additional system env
          "TERM=xterm",  // Additional system env
          "GOSU_VERSION=1.17", // PostgreSQL specific system vars
          "PG_MAJOR=17",
          "PG_VERSION=17.5-1.pgdg120+1",
          "PGDATA=/var/lib/postgresql/data"
        ]
      }
    };

    const result = checkServiceConfigChanges(containerWithMoreSystemEnv, mockDesiredConfig, "test-postgres");
    
    expect(result.hasChanges).toBe(false);
  });

  test("should handle services with no ports", () => {
    const configWithNoPorts = { ...mockDesiredConfig, ports: [] };
    const containerWithNoPorts = {
      ...mockCurrentContainer,
      NetworkSettings: { Ports: {} }
    };

    const result = checkServiceConfigChanges(containerWithNoPorts, configWithNoPorts, "test-service");
    
    expect(result.hasChanges).toBe(false);
  });

  test("should handle services with no volumes", () => {
    const configWithNoVolumes = { ...mockDesiredConfig, volumes: [] };
    const containerWithNoVolumes = {
      ...mockCurrentContainer,
      Mounts: []
    };

    const result = checkServiceConfigChanges(containerWithNoVolumes, configWithNoVolumes, "test-service");
    
    expect(result.hasChanges).toBe(false);
  });

  test("should detect password changes in environment variables", () => {
    const desiredConfigWithNewPassword = {
      ...mockDesiredConfig,
      envVars: {
        POSTGRES_DB: "myapp",
        POSTGRES_PASSWORD: "newsupersecret123" // Changed password
      },
      configHash: "pwd456change789"
    };
    const result = checkServiceConfigChanges(mockCurrentContainer, desiredConfigWithNewPassword, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Configuration changed");
  });

  test("should handle empty environment variables correctly", () => {
    const configWithNoEnv = { ...mockDesiredConfig, envVars: {} };
    const containerWithNoEnv = {
      ...mockCurrentContainer,
      Config: {
        ...mockCurrentContainer.Config,
        Env: [
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "HOSTNAME=container123"
        ]
      }
    };

    const result = checkServiceConfigChanges(containerWithNoEnv, configWithNoEnv, "test-service");
    
    expect(result.hasChanges).toBe(false);
  });

  test("should detect volume mount path changes", () => {
    const desiredConfigWithDifferentPath = {
      ...mockDesiredConfig,
      volumes: ["postgres_data:/var/lib/postgresql/data-new"], // Changed mount path
      configHash: "path456change789"
    };
    const result = checkServiceConfigChanges(mockCurrentContainer, desiredConfigWithDifferentPath, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Configuration changed");
  });

  test("should detect when removing all environment variables", () => {
    const configWithNoUserEnv = { ...mockDesiredConfig, envVars: {}, configHash: "noenv456hash789" };
    const result = checkServiceConfigChanges(mockCurrentContainer, configWithNoUserEnv, "test-postgres");
    
    // With the fallback approach (no config hash), removing all env vars should trigger change
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Configuration changed");
  });

  test("should handle malformed container inspect data gracefully", () => {
    const malformedContainer = {
      Config: null,
      NetworkSettings: null,
      Mounts: null
    };
    
    const result = checkServiceConfigChanges(malformedContainer, mockDesiredConfig, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Upgrading to hash-based configuration tracking");
  });

  test("should handle missing Config.Env array", () => {
    const containerMissingEnv = {
      ...mockCurrentContainer,
      Config: {
        Image: "postgres:15"
        // Missing Env array and Labels (no hash)
      }
    };
    
    const result = checkServiceConfigChanges(containerMissingEnv, mockDesiredConfig, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Upgrading to hash-based configuration tracking");
  });

  test("should correctly compare complex port mappings", () => {
    const complexPortConfig = {
      ...mockDesiredConfig,
      ports: ["5432:5432", "8080:80", "9000:9000"]
    };
    
    const complexPortContainer = {
      ...mockCurrentContainer,
      NetworkSettings: {
        Ports: {
          "5432/tcp": [{ HostPort: "5432" }],
          "80/tcp": [{ HostPort: "8080" }],
          "9000/tcp": [{ HostPort: "9000" }]
        }
      }
    };

    const result = checkServiceConfigChanges(complexPortContainer, complexPortConfig, "test-service");
    
    expect(result.hasChanges).toBe(false);
  });

  test("should filter out all system variables not in our desired config", () => {
    const containerWithManySystemVars = {
      ...mockCurrentContainer,
      Config: {
        ...mockCurrentContainer.Config,
        Env: [
          "POSTGRES_DB=myapp",
          "POSTGRES_PASSWORD=supersecret123",
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "HOSTNAME=container123",
          "HOME=/root",
          "TERM=xterm",
          "DEBIAN_FRONTEND=noninteractive", // System vars
          "LC_ALL=C.UTF-8",
          "LANG=C.UTF-8",
          "GOSU_VERSION=1.17", // PostgreSQL specific system vars  
          "PG_MAJOR=17",
          "PG_VERSION=17.5-1.pgdg120+1",
          "PGDATA=/var/lib/postgresql/data",
          "SOME_RANDOM_SYSTEM_VAR=value" // Any system var not in our config
        ]
      }
    };

    const result = checkServiceConfigChanges(containerWithManySystemVars, mockDesiredConfig, "test-postgres");
    
    expect(result.hasChanges).toBe(false);
  });

  test("should upgrade containers without config hash to hash-based tracking", () => {
    const containerWithoutHash = {
      ...mockCurrentContainer,
      Config: {
        ...mockCurrentContainer.Config,
        Labels: {} // No config hash label
      }
    };

    const result = checkServiceConfigChanges(containerWithoutHash, mockDesiredConfig, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Upgrading to hash-based configuration tracking");
  });
});