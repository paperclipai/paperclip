import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-claude-local/server";

const ORIGINAL_ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_PAPERCLIP_HOME = process.env.PAPERCLIP_HOME;

afterEach(() => {
  if (ORIGINAL_ANTHROPIC === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC;
  }
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
  }
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_PAPERCLIP_HOME === undefined) {
    delete process.env.PAPERCLIP_HOME;
  } else {
    process.env.PAPERCLIP_HOME = ORIGINAL_PAPERCLIP_HOME;
  }
});

describe("claude_local environment diagnostics", () => {
  it("reports that inherited ANTHROPIC_API_KEY is masked from Claude local runs", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-host";

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
      },
    });

    expect(result.status).toBe("pass");
    expect(
      result.checks.some(
        (check) =>
          check.code === "claude_inherited_anthropic_api_key_masked" &&
          check.level === "info",
      ),
    ).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
  });

  it("returns a warning (not an error) when ANTHROPIC_API_KEY is set in adapter env", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
        env: {
          ANTHROPIC_API_KEY: "sk-test-config",
        },
      },
    });

    expect(result.status).toBe("warn");
    expect(
      result.checks.some(
        (check) =>
          check.code === "claude_anthropic_api_key_overrides_subscription" &&
          check.level === "warn",
      ),
    ).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
  });

  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-claude-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "claude_cwd_valid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  it("runs the hello probe with the agent-managed Claude config dir when testing an existing agent", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-claude-managed-home-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const sharedHome = path.join(root, "shared-home");
    const sharedConfigDir = path.join(sharedHome, ".claude");
    const paperclipHome = path.join(root, "paperclip-home");
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const fakeClaude = path.join(binDir, "claude");
    const expectedConfigDir = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "claude-home",
      ".claude",
    );

    try {
      await fs.mkdir(sharedConfigDir, { recursive: true });
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(
        path.join(sharedConfigDir, ".credentials.json"),
        JSON.stringify({ accessToken: "fake-token" }),
        "utf8",
      );
      await fs.writeFile(
        fakeClaude,
        `#!/bin/sh
if [ "$CLAUDE_CONFIG_DIR" != "${expectedConfigDir}" ]; then
  echo "unexpected CLAUDE_CONFIG_DIR: $CLAUDE_CONFIG_DIR" >&2
  exit 1
fi
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"hello"}'
`,
        "utf8",
      );
      await fs.chmod(fakeClaude, 0o755);

      process.env.HOME = sharedHome;
      process.env.PAPERCLIP_HOME = paperclipHome;
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.ANTHROPIC_API_KEY;

      const result = await testEnvironment({
        companyId: "company-1",
        agentId: "agent-1",
        adapterType: "claude_local",
        config: {
          command: "claude",
          cwd,
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.some((check) => check.code === "claude_hello_probe_passed")).toBe(true);
      expect(await fs.stat(expectedConfigDir)).toBeTruthy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
