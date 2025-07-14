import { describe, expect, test } from "bun:test";
import { DockerClient } from "../src/docker";
import type { ServiceEntry, LightformSecrets } from "../src/config/types";

describe("Docker service network aliases", () => {
  test("serviceToContainerOptions should include service name as network alias", () => {
    // Arrange
    const service: ServiceEntry = {
      name: "db",
      image: "postgres:15",
      server: "server.example.com",
      environment: {
        plain: ["POSTGRES_DB=testdb"],
        secret: ["POSTGRES_PASSWORD"]
      },
      ports: ["5432:5432"],
      volumes: ["postgres_data:/var/lib/postgresql/data"]
    };

    const projectName = "test-project";
    const secrets: LightformSecrets = {
      POSTGRES_PASSWORD: "secret123"
    };

    // Act
    const options = DockerClient.serviceToContainerOptions(service, projectName, secrets);

    // Assert
    expect(options.name).toBe("test-project-db");
    expect(options.image).toBe("postgres:15");
    expect(options.network).toBe("test-project-network");
    expect(options.networkAliases).toBeDefined();
    expect(options.networkAliases).toContain("db");
    expect(options.networkAliases?.length).toBe(1);
    expect(options.ports).toContain("5432:5432");
    expect(options.volumes).toContain("postgres_data:/var/lib/postgresql/data");
    expect(options.labels).toMatchObject({
      "lightform.managed": "true",
      "lightform.project": "test-project",
      "lightform.type": "service",
      "lightform.service": "db"
    });
  });

  test("serviceToContainerOptions should work with different service names", () => {
    // Arrange
    const service: ServiceEntry = {
      name: "redis-cache",
      image: "redis:7",
      server: "server.example.com"
    };

    const projectName = "my-app";
    const secrets: LightformSecrets = {};

    // Act
    const options = DockerClient.serviceToContainerOptions(service, projectName, secrets);

    // Assert
    expect(options.name).toBe("my-app-redis-cache");
    expect(options.networkAliases).toContain("redis-cache");
  });

  test("serviceToContainerOptions should handle services without environment variables", () => {
    // Arrange
    const service: ServiceEntry = {
      name: "nginx",
      image: "nginx:latest",
      server: "server.example.com",
      ports: ["80:80"]
    };

    const projectName = "web-project";
    const secrets: LightformSecrets = {};

    // Act
    const options = DockerClient.serviceToContainerOptions(service, projectName, secrets);

    // Assert
    expect(options.name).toBe("web-project-nginx");
    expect(options.networkAliases).toContain("nginx");
    expect(options.envVars).toBeDefined();
    expect(Object.keys(options.envVars!).length).toBe(0);
  });

  test("serviceToContainerOptions should include secret environment variables", () => {
    // Arrange
    const service: ServiceEntry = {
      name: "app-service",
      image: "myapp:latest",
      server: "server.example.com",
      environment: {
        plain: ["NODE_ENV=production"],
        secret: ["DATABASE_URL", "API_SECRET"]
      }
    };

    const projectName = "production-app";
    const secrets: LightformSecrets = {
      DATABASE_URL: "postgres://user:pass@db:5432/myapp",
      API_SECRET: "super-secret-key"
    };

    // Act
    const options = DockerClient.serviceToContainerOptions(service, projectName, secrets);

    // Assert
    expect(options.networkAliases).toContain("app-service");
    expect(options.envVars!["NODE_ENV"]).toBe("production");
    expect(options.envVars!["DATABASE_URL"]).toBe("postgres://user:pass@db:5432/myapp");
    expect(options.envVars!["API_SECRET"]).toBe("super-secret-key");
  });
});