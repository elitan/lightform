import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { initCommand } from "../src/commands/init";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

// Test in a temporary directory
const TEST_DIR = "./test-tmp";

describe("init command", () => {
  beforeEach(async () => {
    // Create a fresh test directory
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (error) {
      // Ignore if directory doesn't exist
    }

    await mkdir(TEST_DIR, { recursive: true });
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

  test("should create luma.yml and .luma/secrets files", async () => {
    // Run the init command
    await initCommand();

    // Check that files were created
    expect(existsSync("luma.yml")).toBe(true);
    expect(existsSync(".luma")).toBe(true);
    expect(existsSync(join(".luma", "secrets"))).toBe(true);

    // Check file contents
    const configFile = Bun.file("luma.yml");
    const configContent = await configFile.text();
    expect(configContent).toContain("services:");
    expect(configContent).toContain("gmail-web:");

    // Secrets file should be empty
    const secretsFile = Bun.file(join(".luma", "secrets"));
    const secretsContent = await secretsFile.text();
    expect(secretsContent).toBe("");
  });

  test("should not overwrite existing files", async () => {
    // Create the config file with custom content
    const customContent = "name: test-project";
    await Bun.write("luma.yml", customContent);

    // Create the secrets directory and file
    await mkdir(".luma", { recursive: true });
    const customSecrets = "API_KEY=1234";
    await Bun.write(join(".luma", "secrets"), customSecrets);

    // Run the init command
    await initCommand();

    // Verify files still have original content
    const configFile = Bun.file("luma.yml");
    const configContent = await configFile.text();
    expect(configContent).toBe(customContent);

    const secretsFile = Bun.file(join(".luma", "secrets"));
    const secretsContent = await secretsFile.text();
    expect(secretsContent).toBe(customSecrets);
  });
});
