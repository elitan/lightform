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

  test("should create lightform.yml and .lightform/secrets files", async () => {
    // Run the init command in non-interactive mode
    await initCommand(["--non-interactive"]);

    // Check that files were created
    expect(existsSync("lightform.yml")).toBe(true);
    expect(existsSync(".lightform")).toBe(true);
    expect(existsSync(join(".lightform", "secrets"))).toBe(true);

    // Check file contents
    const configFile = Bun.file("lightform.yml");
    const configContent = await configFile.text();
    expect(configContent).toContain("apps:");
    expect(configContent).toContain("web:");

    // Secrets file should contain example content
    const secretsFile = Bun.file(join(".lightform", "secrets"));
    const secretsContent = await secretsFile.text();
    expect(secretsContent).toContain("# Add your secret environment variables here");
    expect(secretsContent).toContain("# DATABASE_URL=postgres://user:password@localhost:5432/mydb");
    expect(secretsContent).toContain("# POSTGRES_PASSWORD=supersecret");
    expect(secretsContent).toContain("# API_KEY=your-api-key");
  });

  test("should not overwrite existing files", async () => {
    // Create the config file with custom content
    const customContent = "name: test-project";
    await Bun.write("lightform.yml", customContent);

    // Create the secrets directory and file
    await mkdir(".lightform", { recursive: true });
    const customSecrets = "API_KEY=1234";
    await Bun.write(join(".lightform", "secrets"), customSecrets);

    // Run the init command in non-interactive mode
    await initCommand(["--non-interactive"]);

    // Verify files still have original content
    const configFile = Bun.file("lightform.yml");
    const configContent = await configFile.text();
    expect(configContent).toBe(customContent);

    const secretsFile = Bun.file(join(".lightform", "secrets"));
    const secretsContent = await secretsFile.text();
    expect(secretsContent).toBe(customSecrets);
  });

  test("should create .gitignore and add secrets file when .gitignore doesn't exist", async () => {
    // Run the init command in non-interactive mode
    await initCommand(["--non-interactive"]);

    // Check that .gitignore was created
    expect(existsSync(".gitignore")).toBe(true);

    // Check that secrets file is in .gitignore
    const gitignoreFile = Bun.file(".gitignore");
    const gitignoreContent = await gitignoreFile.text();
    expect(gitignoreContent).toContain(".lightform/secrets");
  });

  test("should add secrets file to existing .gitignore", async () => {
    // Create existing .gitignore with some content
    const existingContent = `node_modules/
dist/
*.log
`;
    await Bun.write(".gitignore", existingContent);

    // Run the init command in non-interactive mode
    await initCommand(["--non-interactive"]);

    // Check that .gitignore exists and contains both old and new content
    const gitignoreFile = Bun.file(".gitignore");
    const gitignoreContent = await gitignoreFile.text();

    expect(gitignoreContent).toContain("node_modules/");
    expect(gitignoreContent).toContain("dist/");
    expect(gitignoreContent).toContain("*.log");
    expect(gitignoreContent).toContain(".lightform/secrets");
  });

  test("should not duplicate secrets file in .gitignore if already present", async () => {
    // Create .gitignore that already contains the secrets file
    const existingContent = `node_modules/
dist/
.lightform/secrets
*.log
`;
    await Bun.write(".gitignore", existingContent);

    // Run the init command in non-interactive mode
    await initCommand(["--non-interactive"]);

    // Check that .gitignore doesn't have duplicate entries
    const gitignoreFile = Bun.file(".gitignore");
    const gitignoreContent = await gitignoreFile.text();

    const lines = gitignoreContent.split("\n");
    const secretsLines = lines.filter(
      (line) => line.trim() === ".lightform/secrets"
    );
    expect(secretsLines.length).toBe(1);
  });

  test("should handle different variations of secrets path in .gitignore", async () => {
    // Test with leading slash
    await Bun.write(".gitignore", "/.lightform/secrets\n");
    await initCommand(["--non-interactive"]);

    let gitignoreContent = await Bun.file(".gitignore").text();
    let lines = gitignoreContent.split("\n");
    let secretsLines = lines.filter(
      (line) =>
        line.trim() === ".lightform/secrets" || line.trim() === "/.lightform/secrets"
    );
    expect(secretsLines.length).toBe(1);

    // Clean up and test with forward slashes on Windows
    await Bun.write(".gitignore", ".lightform/secrets\n");
    await initCommand(["--non-interactive"]);

    gitignoreContent = await Bun.file(".gitignore").text();
    lines = gitignoreContent.split("\n");
    secretsLines = lines.filter(
      (line) =>
        line.trim() === ".lightform/secrets" || line.trim() === "/.lightform/secrets"
    );
    expect(secretsLines.length).toBe(1);
  });

  test("should handle empty .gitignore file", async () => {
    // Create empty .gitignore
    await Bun.write(".gitignore", "");

    // Run the init command in non-interactive mode
    await initCommand(["--non-interactive"]);

    // Check that secrets file is added to .gitignore
    const gitignoreFile = Bun.file(".gitignore");
    const gitignoreContent = await gitignoreFile.text();
    expect(gitignoreContent.trim()).toBe(".lightform/secrets");
  });
});
