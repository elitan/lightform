import { describe, test, expect } from "bun:test";
import { validateConfig, ConfigValidationError } from "../src/utils/config-validator";
import { LightformConfig } from "../src/config/types";

describe("Reserved Names Validation", () => {
  test("should reject app with reserved name 'proxy'", () => {
    const config: LightformConfig = {
      name: "test-project",
      apps: {
        proxy: {
          image: "test/proxy",
          server: "test.com",
        },
      },
    };

    const errors = validateConfig(config);
    
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe("reserved_name");
    expect(errors[0].message).toContain("proxy");
    expect(errors[0].message).toContain("reserved");
    expect(errors[0].entries).toEqual(["proxy"]);
    expect(errors[0].suggestions).toBeDefined();
    expect(errors[0].suggestions?.some(s => s.includes("proxy-app"))).toBe(true);
  });

  test("should reject service with reserved name 'status'", () => {
    const config: LightformConfig = {
      name: "test-project",
      services: {
        status: {
          image: "test/status",
          server: "test.com",
        },
      },
    };

    const errors = validateConfig(config);
    
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe("reserved_name");
    expect(errors[0].message).toContain("status");
    expect(errors[0].entries).toEqual(["status"]);
  });

  test("should reject app with reserved name 'init'", () => {
    const config: LightformConfig = {
      name: "test-project",
      apps: {
        init: {
          image: "test/init",
          server: "test.com",
        },
      },
    };

    const errors = validateConfig(config);
    
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe("reserved_name");
    expect(errors[0].message).toContain("init");
  });

  test("should reject multiple reserved names", () => {
    const config: LightformConfig = {
      name: "test-project",
      apps: {
        proxy: {
          image: "test/proxy",
          server: "test.com",
        },
        init: {
          image: "test/init", 
          server: "test.com",
        },
      },
      services: {
        status: {
          image: "test/status",
          server: "test.com",
        },
      },
    };

    const errors = validateConfig(config);
    
    expect(errors).toHaveLength(3);
    expect(errors.map(e => e.entries[0]).sort()).toEqual(["init", "proxy", "status"]);
    expect(errors.every(e => e.type === "reserved_name")).toBe(true);
  });

  test("should allow non-reserved names", () => {
    const config: LightformConfig = {
      name: "test-project",
      apps: {
        web: {
          image: "test/web",
          server: "test.com",
        },
        api: {
          image: "test/api",
          server: "test.com",
        },
      },
      services: {
        database: {
          image: "postgres:15",
          server: "test.com",
        },
        redis: {
          image: "redis:alpine",
          server: "test.com",
        },
      },
    };

    const errors = validateConfig(config);
    
    // Should not have any reserved name errors
    const reservedNameErrors = errors.filter(e => e.type === "reserved_name");
    expect(reservedNameErrors).toHaveLength(0);
  });

  test("should allow names similar to reserved names", () => {
    const config: LightformConfig = {
      name: "test-project",
      apps: {
        "proxy-app": {
          image: "test/proxy-app",
          server: "test.com",
        },
        "web-proxy": {
          image: "test/web-proxy",
          server: "test.com",
        },
        "status-checker": {
          image: "test/status-checker",
          server: "test.com",
        },
      },
    };

    const errors = validateConfig(config);
    
    // Should not have any reserved name errors
    const reservedNameErrors = errors.filter(e => e.type === "reserved_name");
    expect(reservedNameErrors).toHaveLength(0);
  });

  test("should work with array format configuration", () => {
    const config: LightformConfig = {
      name: "test-project",
      apps: [
        {
          name: "proxy",
          image: "test/proxy",
          server: "test.com",
        },
      ],
      services: [
        {
          name: "status",
          image: "test/status",
          server: "test.com",
        },
      ],
    };

    const errors = validateConfig(config);
    
    const reservedNameErrors = errors.filter(e => e.type === "reserved_name");
    expect(reservedNameErrors).toHaveLength(2);
    expect(reservedNameErrors.map(e => e.entries[0]).sort()).toEqual(["proxy", "status"]);
  });

  test("should include helpful suggestions", () => {
    const config: LightformConfig = {
      name: "test-project",
      apps: {
        proxy: {
          image: "test/proxy",
          server: "test.com",
        },
      },
    };

    const errors = validateConfig(config);
    
    expect(errors).toHaveLength(1);
    const suggestions = errors[0].suggestions || [];
    
    // Check that suggestions contain helpful alternatives
    expect(suggestions.some(s => s.includes("proxy-app"))).toBe(true);
    expect(suggestions.some(s => s.includes("proxy-service"))).toBe(true);
    expect(suggestions.some(s => s.includes("web-proxy"))).toBe(true);
    expect(suggestions.some(s => s.includes("Reserved names:"))).toBe(true);
    expect(suggestions.some(s => s.includes("init, status, proxy"))).toBe(true);
  });
});