import { describe, expect, test } from "bun:test";
import {
  LumaServiceSchema,
  LumaConfigSchema,
  LumaSecretsSchema,
} from "../src/config/types";

describe("type schemas", () => {
  describe("LumaServiceSchema", () => {
    test("should validate a minimal valid service", () => {
      const validService = {
        image: "nginx:latest",
        servers: ["server1.example.com"],
      };

      const result = LumaServiceSchema.safeParse(validService);
      expect(result.success).toBe(true);
    });

    test("should validate a complete service", () => {
      const validService = {
        image: "nginx:latest",
        servers: ["server1.example.com", "server2.example.com"],
        build: {
          context: ".",
          dockerfile: "Dockerfile",
        },
        ports: ["80:80", "443:443"],
        volumes: ["/data:/usr/share/nginx/html"],
        environment: {
          plain: ["DEBUG=false", "LOG_LEVEL=info"],
          secret: ["API_KEY", "DB_PASSWORD"],
        },
        registry: {
          url: "registry.example.com",
          username: "user",
          password: ["REGISTRY_PASSWORD"],
        },
      };

      const result = LumaServiceSchema.safeParse(validService);
      expect(result.success).toBe(true);
    });

    test("should reject a service missing required fields", () => {
      const invalidService = {
        servers: ["server1.example.com"], // missing 'image'
      };

      const result = LumaServiceSchema.safeParse(invalidService);
      expect(result.success).toBe(false);

      if (!result.success) {
        const errorPaths = result.error.errors.map((e) => e.path.join("."));
        expect(errorPaths).toContain("image");
      }
    });

    test("should reject a service with invalid field types", () => {
      const invalidService = {
        image: "nginx:latest",
        servers: "server1.example.com", // should be an array
      };

      const result = LumaServiceSchema.safeParse(invalidService);
      expect(result.success).toBe(false);

      if (!result.success) {
        const errorPaths = result.error.errors.map((e) => e.path.join("."));
        expect(errorPaths).toContain("servers");
      }
    });
  });

  describe("LumaConfigSchema", () => {
    test("should validate a minimal valid config", () => {
      const validConfig = {
        services: {
          web: {
            image: "nginx:latest",
            servers: ["server1.example.com"],
          },
        },
      };

      const result = LumaConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    test("should validate a complete config", () => {
      const validConfig = {
        name: "my-project",
        services: {
          web: {
            image: "nginx:latest",
            servers: ["server1.example.com"],
          },
          db: {
            image: "postgres:14",
            servers: ["db.example.com"],
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

      const result = LumaConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    test("should reject a config missing required fields", () => {
      const invalidConfig = {
        // Missing 'services' field
      };

      const result = LumaConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);

      if (!result.success) {
        const errorPaths = result.error.errors.map((e) => e.path.join("."));
        expect(errorPaths).toContain("services");
      }
    });
  });

  describe("LumaSecretsSchema", () => {
    test("should validate a secrets object", () => {
      const validSecrets = {
        API_KEY: "123456",
        DB_PASSWORD: "secret",
        JWT_SECRET: "very-secret",
      };

      const result = LumaSecretsSchema.safeParse(validSecrets);
      expect(result.success).toBe(true);
    });

    test("should validate an empty secrets object", () => {
      const validSecrets = {};

      const result = LumaSecretsSchema.safeParse(validSecrets);
      expect(result.success).toBe(true);
    });

    test("should reject a secrets object with non-string values", () => {
      const invalidSecrets = {
        API_KEY: "123456",
        CONFIG: { key: "value" }, // Object instead of string
      };

      const result = LumaSecretsSchema.safeParse(invalidSecrets);
      expect(result.success).toBe(false);

      if (!result.success) {
        const errorPaths = result.error.errors.map((e) => e.path.join("."));
        expect(errorPaths).toContain("CONFIG");
      }
    });
  });
});
