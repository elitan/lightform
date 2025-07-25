import { describe, expect, test } from "bun:test";
import {
  ServiceEntryWithoutNameSchema,
  IopConfigSchema,
  IopSecretsSchema,
} from "../src/config/types";

describe("type schemas", () => {
  describe("ServiceEntryWithoutNameSchema", () => {
    test("should validate a minimal valid service", () => {
      const validService = {
        image: "nginx:latest",
        server: "server1.example.com",
      };

      const result = ServiceEntryWithoutNameSchema.safeParse(validService);
      expect(result.success).toBe(true);
    });

    test("should validate a complete service", () => {
      const validService = {
        image: "nginx:latest",
        server: "server1.example.com",
        ports: ["80:80", "443:443"],
        volumes: ["/data:/usr/share/nginx/html"],
        environment: {
          plain: ["DEBUG=false", "LOG_LEVEL=info"],
          secret: ["API_KEY", "DB_PASSWORD"],
        },
        registry: {
          url: "registry.example.com",
          username: "user",
          password_secret: "REGISTRY_PASSWORD",
        },
      };

      const result = ServiceEntryWithoutNameSchema.safeParse(validService);
      expect(result.success).toBe(true);
    });

    test("should reject a service missing required fields", () => {
      const invalidService = {
        server: "server1.example.com", // missing 'image'
      };

      const result = ServiceEntryWithoutNameSchema.safeParse(invalidService);
      expect(result.success).toBe(false);

      if (!result.success) {
        const errorPaths = result.error.errors.map((e) => e.path.join("."));
        expect(errorPaths).toContain("image");
      }
    });

    test("should reject a service with invalid field types", () => {
      const invalidService = {
        image: "nginx:latest",
        server: ["server1.example.com"], // should be a string, not array
      };

      const result = ServiceEntryWithoutNameSchema.safeParse(invalidService);
      expect(result.success).toBe(false);

      if (!result.success) {
        const errorPaths = result.error.errors.map((e) => e.path.join("."));
        expect(errorPaths).toContain("server");
      }
    });
  });

  describe("IopConfigSchema", () => {
    test("should validate a minimal valid config", () => {
      const validConfig = {
        name: "test-project",
        services: {
          web: {
            image: "nginx:latest",
            server: "server1.example.com",
          },
        },
      };

      const result = IopConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    test("should validate a complete config", () => {
      const validConfig = {
        name: "my-project",
        services: {
          web: {
            image: "nginx:latest",
            server: "server1.example.com",
          },
          db: {
            image: "postgres:14",
            server: "db.example.com",
          },
        },
        docker: {
          registry: "registry.example.com",
          username: "admin",
        },
        ssh: {
          username: "deployer",
          port: 2222,
        },
      };

      const result = IopConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    test("should reject a config missing required fields", () => {
      const invalidConfig = {
        // Missing required 'name' field
        services: {
          web: {
            image: "nginx:latest",
            server: "server1.example.com",
          },
        },
      };

      const result = IopConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);

      if (!result.success) {
        const errorPaths = result.error.errors.map((e) => e.path.join("."));
        expect(errorPaths).toContain("name");
      }
    });
  });

  describe("IopSecretsSchema", () => {
    test("should validate a secrets object", () => {
      const validSecrets = {
        API_KEY: "123456",
        DB_PASSWORD: "secret",
        JWT_SECRET: "very-secret",
      };

      const result = IopSecretsSchema.safeParse(validSecrets);
      expect(result.success).toBe(true);
    });

    test("should validate an empty secrets object", () => {
      const validSecrets = {};

      const result = IopSecretsSchema.safeParse(validSecrets);
      expect(result.success).toBe(true);
    });

    test("should reject a secrets object with non-string values", () => {
      const invalidSecrets = {
        API_KEY: "123456",
        CONFIG: { key: "value" }, // Object instead of string
      };

      const result = IopSecretsSchema.safeParse(invalidSecrets);
      expect(result.success).toBe(false);

      if (!result.success) {
        const errorPaths = result.error.errors.map((e) => e.path.join("."));
        expect(errorPaths).toContain("CONFIG");
      }
    });
  });
});
