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
    ]
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
  volumes: ["postgres_data:/var/lib/postgresql/data"]
};

describe("Service Configuration Change Detection", () => {
  test("should detect no changes when configuration is identical", () => {
    const result = checkServiceConfigChanges(mockCurrentContainer, mockDesiredConfig, "test-postgres");
    
    expect(result.hasChanges).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  test("should detect image changes", () => {
    const desiredConfigWithNewImage = { ...mockDesiredConfig, image: "postgres:16" };
    const result = checkServiceConfigChanges(mockCurrentContainer, desiredConfigWithNewImage, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Image changed");
    expect(result.reason).toContain("postgres:15 → postgres:16");
  });

  test("should detect environment variable changes", () => {
    const desiredConfigWithNewEnv = {
      ...mockDesiredConfig,
      envVars: {
        POSTGRES_DB: "myapp",
        POSTGRES_PASSWORD: "supersecret123",
        POSTGRES_USER: "newuser" // Added new env var
      }
    };
    const result = checkServiceConfigChanges(mockCurrentContainer, desiredConfigWithNewEnv, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Environment variables changed");
  });

  test("should detect port mapping changes", () => {
    const desiredConfigWithNewPorts = { ...mockDesiredConfig, ports: ["9002:5432"] };
    const result = checkServiceConfigChanges(mockCurrentContainer, desiredConfigWithNewPorts, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Port mapping changed");
    expect(result.reason).toContain("9002:5432");
  });

  test("should detect volume changes", () => {
    const desiredConfigWithNewVolumes = {
      ...mockDesiredConfig,
      volumes: [
        "postgres_data:/var/lib/postgresql/data",
        "postgres_config:/etc/postgresql" // Added new volume
      ]
    };
    const result = checkServiceConfigChanges(mockCurrentContainer, desiredConfigWithNewVolumes, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Volume count changed");
    expect(result.reason).toContain("1 → 2");
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
          "TERM=xterm"  // Additional system env
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
      }
    };
    const result = checkServiceConfigChanges(mockCurrentContainer, desiredConfigWithNewPassword, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Environment variables changed");
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
      volumes: ["postgres_data:/var/lib/postgresql/data-new"] // Changed mount path
    };
    const result = checkServiceConfigChanges(mockCurrentContainer, desiredConfigWithDifferentPath, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Volume mapping changed");
  });

  test("should detect when removing all environment variables", () => {
    const configWithNoUserEnv = { ...mockDesiredConfig, envVars: {} };
    const result = checkServiceConfigChanges(mockCurrentContainer, configWithNoUserEnv, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Environment variables changed");
  });

  test("should handle malformed container inspect data gracefully", () => {
    const malformedContainer = {
      Config: null,
      NetworkSettings: null,
      Mounts: null
    };
    
    const result = checkServiceConfigChanges(malformedContainer, mockDesiredConfig, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Image changed");
  });

  test("should handle missing Config.Env array", () => {
    const containerMissingEnv = {
      ...mockCurrentContainer,
      Config: {
        Image: "postgres:15"
        // Missing Env array
      }
    };
    
    const result = checkServiceConfigChanges(containerMissingEnv, mockDesiredConfig, "test-postgres");
    
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toContain("Environment variables changed");
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

  test("should filter out additional Docker system variables", () => {
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
          "DEBIAN_FRONTEND=noninteractive", // Additional system vars
          "LC_ALL=C.UTF-8",
          "LANG=C.UTF-8"
        ]
      }
    };

    const result = checkServiceConfigChanges(containerWithManySystemVars, mockDesiredConfig, "test-postgres");
    
    expect(result.hasChanges).toBe(false);
  });
});