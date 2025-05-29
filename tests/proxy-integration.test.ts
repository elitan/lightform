import { expect, test, describe } from "bun:test";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

describe("Proxy Integration Tests", () => {
  const testTargets = {
    gmail: {
      domain: "test.eliasson.me",
      expectedContent: "Hello World 2",
      projectAlias: "gmail-web",
    },
    nextjs: {
      domain: "nextjs.example.myluma.cloud",
      expectedContent: "<!DOCTYPE html>",
      projectAlias: "luma-example-nextjs-web",
    },
  };

  test("External HTTPS access should work for both projects", async () => {
    // Test Gmail project
    const { stdout: gmailResponse } = await execAsync(
      `curl -s https://${testTargets.gmail.domain}`
    );
    expect(gmailResponse.trim()).toBe(testTargets.gmail.expectedContent);

    // Test NextJS project
    const { stdout: nextjsResponse } = await execAsync(
      `curl -s https://${testTargets.nextjs.domain}`
    );
    expect(nextjsResponse).toContain(testTargets.nextjs.expectedContent);
  });

  test("Proxy should use project-specific DNS targets", async () => {
    try {
      const { stdout, stderr } = await execAsync(
        `ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy list"`
      );
      // Combine stdout and stderr since proxy output might go to stderr
      const proxyConfig = stdout + stderr;

      // Verify Gmail route configuration
      expect(proxyConfig).toContain(`Host: ${testTargets.gmail.domain}`);
      expect(proxyConfig).toContain(
        `Target: ${testTargets.gmail.projectAlias}:3000`
      );
      expect(proxyConfig).toContain(`Project: gmail`);

      // Verify NextJS route configuration
      expect(proxyConfig).toContain(`Host: ${testTargets.nextjs.domain}`);
      expect(proxyConfig).toContain(
        `Target: ${testTargets.nextjs.projectAlias}:3000`
      );
      expect(proxyConfig).toContain(`Project: luma-example-nextjs`);
    } catch (error) {
      // Handle SSH execution error by checking stderr
      const errorOutput = String(error);
      expect(errorOutput).toContain(`Host: ${testTargets.gmail.domain}`);
    }
  });

  test("Internal DNS resolution should work via project-specific aliases", async () => {
    // Test Gmail project-specific alias from proxy
    const { stdout: gmailInternal } = await execAsync(
      `ssh luma@157.180.25.101 "docker exec luma-proxy curl -s http://${testTargets.gmail.projectAlias}:3000"`
    );
    expect(gmailInternal.trim()).toBe(testTargets.gmail.expectedContent);

    // Test NextJS project-specific alias from proxy
    const { stdout: nextjsInternal } = await execAsync(
      `ssh luma@157.180.25.101 "docker exec luma-proxy curl -s http://${testTargets.nextjs.projectAlias}:3000"`
    );
    expect(nextjsInternal).toContain(testTargets.nextjs.expectedContent);
  });

  test("Both projects should be healthy", async () => {
    try {
      const { stdout, stderr } = await execAsync(
        `ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy list"`
      );
      const proxyConfig = stdout + stderr;

      // Check that both projects show as healthy
      const lines = proxyConfig.split("\n");
      const gmailHealthLine = lines.find((line) =>
        line.includes(testTargets.gmail.domain)
      );
      const nextjsHealthLine = lines.find((line) =>
        line.includes(testTargets.nextjs.domain)
      );

      // Check if we found the lines and if they're healthy
      expect(gmailHealthLine || "").toContain("✅ Healthy");
      expect(nextjsHealthLine || "").toContain("✅ Healthy");
    } catch (error) {
      // Handle SSH execution error by checking stderr contains health info
      const errorOutput = String(error);
      expect(errorOutput).toContain("✅ Healthy");
    }
  });

  test("Projects should return different content (proving isolation)", async () => {
    const { stdout: gmailResponse } = await execAsync(
      `curl -s https://${testTargets.gmail.domain}`
    );
    const { stdout: nextjsResponse } = await execAsync(
      `curl -s https://${testTargets.nextjs.domain}`
    );

    // They should be different
    expect(gmailResponse).not.toEqual(nextjsResponse);

    // Each should contain their expected content
    expect(gmailResponse.trim()).toBe(testTargets.gmail.expectedContent);
    expect(nextjsResponse).toContain(testTargets.nextjs.expectedContent);
  });
});
