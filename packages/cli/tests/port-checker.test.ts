import { describe, it, expect, beforeEach } from "bun:test";
import { parsePortMappings } from "../src/utils/port-checker";
import { validateConfig } from "../src/utils/config-validator";
import { IopConfig } from "../src/config/types";

describe("Port Conflict Detection", () => {
  describe("parsePortMappings", () => {
    it("should parse simple port mappings", () => {
      const ports = ["5432:5432", "8080:80"];
      const result = parsePortMappings(ports);

      expect(result).toEqual([
        { hostPort: 5432, containerPort: 5432, protocol: "tcp" },
        { hostPort: 8080, containerPort: 80, protocol: "tcp" },
      ]);
    });

    it("should parse port mappings with protocols", () => {
      const ports = ["5432:5432/tcp", "8080:80/udp"];
      const result = parsePortMappings(ports);

      expect(result).toEqual([
        { hostPort: 5432, containerPort: 5432, protocol: "tcp" },
        { hostPort: 8080, containerPort: 80, protocol: "udp" },
      ]);
    });

    it("should parse IP-specific port mappings", () => {
      const ports = ["127.0.0.1:5432:5432"];
      const result = parsePortMappings(ports);

      expect(result).toEqual([
        { hostPort: 5432, containerPort: 5432, protocol: "tcp" },
      ]);
    });

    it("should parse single port format", () => {
      const ports = ["5432", "8080/udp"];
      const result = parsePortMappings(ports);

      expect(result).toEqual([
        { hostPort: 5432, containerPort: 5432, protocol: "tcp" },
        { hostPort: 8080, containerPort: 8080, protocol: "udp" },
      ]);
    });
  });

  describe("Configuration Validation", () => {
    it("should detect port conflicts within the same project", () => {
      const config: IopConfig = {
        name: "test-project",
        services: {
          postgres1: {
            image: "postgres:15",
            server: "server1.com",
            ports: ["5432:5432"],
          },
          postgres2: {
            image: "postgres:15",
            server: "server1.com",
            ports: ["5432:5432"], // Same port as postgres1
          },
        },
      };

      const errors = validateConfig(config);

      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe("port_conflict");
      expect(errors[0].port).toBe(5432);
      expect(errors[0].entries).toEqual(["postgres1", "postgres2"]);
      expect(errors[0].server).toBe("server1.com");
    });

    it("should allow same ports on different servers", () => {
      const config: IopConfig = {
        name: "test-project",
        services: {
          postgres1: {
            image: "postgres:15",
            server: "server1.com",
            ports: ["5432:5432"],
          },
          postgres2: {
            image: "postgres:15",
            server: "server2.com", // Different server
            ports: ["5432:5432"], // Same port, but different server
          },
        },
      };

      const errors = validateConfig(config);

      expect(errors).toHaveLength(0);
    });

    it("should detect invalid port specifications", () => {
      const config: IopConfig = {
        name: "test-project",
        services: {
          postgres: {
            image: "postgres:15",
            server: "server1.com",
            ports: ["invalid:port", "5432:5432"],
          },
        },
      };

      const errors = validateConfig(config);

      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe("invalid_port");
      expect(errors[0].entries).toEqual(["postgres"]);
    });

    it("should handle port conflicts between services", () => {
      const config: IopConfig = {
        name: "test-project",
        services: {
          web: {
            image: "web:latest",
            server: "server1.com",
            ports: ["8080:80"],
            replicas: 1,
          },
          postgres: {
            image: "postgres:15",
            server: "server1.com",
            ports: ["8080:5432"], // Conflicts with web service
          },
        },
      };

      const errors = validateConfig(config);

      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe("port_conflict");
      expect(errors[0].port).toBe(8080);
      expect(errors[0].entries).toEqual(["web", "postgres"]);
    });

    it("should handle complex port conflicts", () => {
      const config: IopConfig = {
        name: "test-project",
        services: {
          service1: {
            image: "service1:latest",
            server: "server1.com",
            ports: ["8080:80", "9090:90"],
          },
          service2: {
            image: "service2:latest",
            server: "server1.com",
            ports: ["8080:8080"], // Conflicts with service1
          },
          service3: {
            image: "service3:latest",
            server: "server1.com",
            ports: ["9090:9090"], // Conflicts with service1
          },
        },
      };

      const errors = validateConfig(config);

      expect(errors).toHaveLength(2);

      // Check first conflict (port 8080)
      const conflict8080 = errors.find((e) => e.port === 8080);
      expect(conflict8080).toBeTruthy();
      expect(conflict8080!.entries).toEqual(["service1", "service2"]);

      // Check second conflict (port 9090)
      const conflict9090 = errors.find((e) => e.port === 9090);
      expect(conflict9090).toBeTruthy();
      expect(conflict9090!.entries).toEqual(["service1", "service3"]);
    });
  });
});

describe("Port Conflict Examples", () => {
  it("should demonstrate the original problem scenario", () => {
    // This represents the original user question:
    // Two projects with PostgreSQL both using port 5432

    const project1Config: IopConfig = {
      name: "gmail-clone",
      services: {
        postgres: {
          image: "postgres:15",
          server: "server1.com",
          ports: ["5432:5432"],
        },
      },
    };

    const project2Config: IopConfig = {
      name: "blog-app",
      services: {
        postgres: {
          image: "postgres:15",
          server: "server1.com", // Same server!
          ports: ["5432:5432"], // Same port!
        },
      },
    };

    // Each project individually is valid
    expect(validateConfig(project1Config)).toHaveLength(0);
    expect(validateConfig(project2Config)).toHaveLength(0);

    // But if they were in the same config, there would be a conflict
    const combinedConfig: IopConfig = {
      name: "combined-project",
      services: {
        "gmail-postgres": {
          image: "postgres:15",
          server: "server1.com",
          ports: ["5432:5432"],
        },
        "blog-postgres": {
          image: "postgres:15",
          server: "server1.com",
          ports: ["5432:5432"],
        },
      },
    };

    const errors = validateConfig(combinedConfig);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe("port_conflict");
    expect(errors[0].port).toBe(5432);
  });

  it("should show recommended solutions", () => {
    const config: IopConfig = {
      name: "test-project",
      services: {
        postgres1: {
          image: "postgres:15",
          server: "server1.com",
          ports: ["5432:5432"],
        },
        postgres2: {
          image: "postgres:15",
          server: "server1.com",
          ports: ["5432:5432"],
        },
      },
    };

    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);

    const suggestions = errors[0].suggestions;
    expect(suggestions).toBeTruthy();

    // Check that suggestions include common solutions
    const suggestionText = suggestions!.join("\n");
    expect(suggestionText).toContain("Use different host ports");
    expect(suggestionText).toContain("Remove port mappings");
    expect(suggestionText).toContain("6432:5432"); // Alternative port suggestion
  });
});
