import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute, testEnvironment } from "@paperclipai/adapter-claude-local/server";

const ORIGINAL_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (ORIGINAL_ANTHROPIC === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC;
  }
});

describe("claude_local environment diagnostics", () => {
  it("returns a warning (not an error) when ANTHROPIC_API_KEY is set in host environment", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-host";

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
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

  it("reports explicit subscription override separately from API-key fallback", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-host";

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
        paperclipAuthMode: "subscription",
        env: {
          ANTHROPIC_API_KEY: "",
        },
      },
    });

    expect(
      result.checks.some(
        (check) =>
          check.code === "claude_subscription_override_active" &&
          check.level === "info",
      ),
    ).toBe(true);
    expect(
      result.checks.some(
        (check) => check.code === "claude_anthropic_api_key_overrides_subscription",
      ),
    ).toBe(false);
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

  it("omits cwd in session params for agent_home workspaces", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-claude-local-agent-home-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const configuredCwd = path.join(root, "configured-cwd");
    const workspaceCwd = path.join(root, "workspace-cwd");
    const fakeClaude = path.join(binDir, "claude");
    const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-test" }));
console.log(JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;

    try {
      process.env.PAPERCLIP_AGENT_RUNTIME_DIR = root;
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(configuredCwd, { recursive: true });
      await fs.mkdir(workspaceCwd, { recursive: true });
      await fs.writeFile(fakeClaude, script, "utf8");
      await fs.chmod(fakeClaude, 0o755);

      const result = await execute({
        runId: "run-agent-home",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Agent",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          cwd: configuredCwd,
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
        context: {
          paperclipWorkspace: {
            source: "agent_home",
            cwd: workspaceCwd,
            workspaceId: "workspace-1",
          },
        },
        onLog: async () => {},
        onMeta: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.sessionParams).toEqual({
        sessionId: "claude-session-1",
        workspaceId: "workspace-1",
      });
    } finally {
      delete process.env.PAPERCLIP_AGENT_RUNTIME_DIR;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
