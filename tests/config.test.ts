import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";
import { loadConfig, loadSecrets } from "../src/config";
import fs from "node:fs/promises";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

// Test in a temporary directory
const TEST_DIR = "./test-config-tmp";

describe("config module", () => {
  beforeEach(async () => {
    // Create a fresh test directory
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (error) {
      // Ignore if directory doesn't exist
    }

    await mkdir(TEST_DIR, { recursive: true });
    await mkdir(join(TEST_DIR, ".luma"), { recursive: true });
    process.chdir(TEST_DIR);
  });

  afterEach(() => {
    // Clean up and go back to original directory
    process.chdir("..");
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (error) {
      console.error(`Failed to clean up test directory: ${error}`);
    }
  });

  describe("loadConfig", () => {
    test("should load a valid config file", async () => {
      // Create a valid config file
      const validConfig = `
name: test-project
services:
  web-app:
    image: test/webapp:latest
    servers:
      - server1.example.com
    ports:
      - "80:8080"
    volumes:
      - data:/app/data
    environment:
      plain:
        - NODE_ENV=production
      secret:
        - API_KEY
`;
      await Bun.write("luma.yml", validConfig);

      // Load the config
      const config = await loadConfig();

      // Verify the loaded config
      expect(config.name).toBe("test-project");
      expect(config.services).toBeDefined();
      expect(config.services!["web-app"]).not.toBeUndefined();
      expect(config.services!["web-app"].image).toBe("test/webapp:latest");
      expect(config.services!["web-app"].servers).toContain(
        "server1.example.com"
      );
      expect(config.services!["web-app"].ports).toContain("80:8080");
      expect(config.services!["web-app"].volumes).toContain("data:/app/data");
      expect(config.services!["web-app"].environment?.plain).toContain(
        "NODE_ENV=production"
      );
      expect(config.services!["web-app"].environment?.secret).toContain(
        "API_KEY"
      );
    });

    test("should throw an error for invalid config", async () => {
      // Create an invalid config file (missing required 'image' field)
      const invalidConfig = `
name: test-project
services:
  web-app:
    # Missing required 'image' field
    servers:
      - server1.example.com
`;
      await Bun.write("luma.yml", invalidConfig);

      // Expect loadConfig to throw
      await expect(loadConfig()).rejects.toThrow();
    });

    test("should throw an error if config file doesn't exist", async () => {
      // Don't create a config file
      await expect(loadConfig()).rejects.toThrow();
    });
  });

  describe("loadSecrets", () => {
    test("should load secrets file correctly", async () => {
      // Create a secrets file
      const secretsContent = `
# This is a comment
API_KEY=1234567890
DATABASE_URL=postgres://user:pass@host:5432/db
SECRET_WITH_EQUALS=value=with=equals
`;
      await Bun.write(join(".luma", "secrets"), secretsContent);

      // Load secrets
      const secrets = await loadSecrets();

      // Verify the loaded secrets
      expect(secrets.API_KEY).toBe("1234567890");
      expect(secrets.DATABASE_URL).toBe("postgres://user:pass@host:5432/db");
      expect(secrets.SECRET_WITH_EQUALS).toBe("value=with=equals");
      expect(Object.keys(secrets).length).toBe(3); // Comments should be ignored
    });

    test("should return empty object when secrets file doesn't exist", async () => {
      // No secrets file exists
      const secrets = await loadSecrets();

      // Should return an empty object
      expect(Object.keys(secrets).length).toBe(0);
    });

    test("should handle quoted values", async () => {
      // Create a secrets file with quoted values
      const secretsContent = `
QUOTED_VALUE_1="this is a quoted value"
QUOTED_VALUE_2='another quoted value'
`;
      await Bun.write(join(".luma", "secrets"), secretsContent);

      // Load secrets
      const secrets = await loadSecrets();

      // Verify quotes are stripped
      expect(secrets.QUOTED_VALUE_1).toBe("this is a quoted value");
      expect(secrets.QUOTED_VALUE_2).toBe("another quoted value");
    });
  });
});
