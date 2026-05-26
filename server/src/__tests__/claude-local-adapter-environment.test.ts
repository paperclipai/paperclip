import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-claude-local/server";

const ORIGINAL_ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK;
const ORIGINAL_BEDROCK_URL = process.env.ANTHROPIC_BEDROCK_BASE_URL;

afterEach(() => {
  if (ORIGINAL_ANTHROPIC === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC;
  }
  if (ORIGINAL_BEDROCK === undefined) {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
  } else {
    process.env.CLAUDE_CODE_USE_BEDROCK = ORIGINAL_BEDROCK;
  }
  if (ORIGINAL_BEDROCK_URL === undefined) {
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
  } else {
    process.env.ANTHROPIC_BEDROCK_BASE_URL = ORIGINAL_BEDROCK_URL;
  }
});

describe("claude_local environment diagnostics", () => {
  it("returns a warning (not an error) when ANTHROPIC_API_KEY is set in host environment", async () => {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
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
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;

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

  it("returns bedrock auth info when CLAUDE_CODE_USE_BEDROCK is set in host environment", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
      },
    });

    expect(
      result.checks.some(
        (check) =>
          check.code === "claude_bedrock_auth" && check.level === "info",
      ),
    ).toBe(true);
    expect(
      result.checks.some(
        (check) => check.code === "claude_subscription_mode_possible",
      ),
    ).toBe(false);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
  });

  it("returns bedrock auth info when CLAUDE_CODE_USE_BEDROCK is set in adapter env", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
        },
      },
    });

    expect(
      result.checks.some(
        (check) =>
          check.code === "claude_bedrock_auth" && check.level === "info",
      ),
    ).toBe(true);
    expect(
      result.checks.some(
        (check) => check.code === "claude_subscription_mode_possible",
      ),
    ).toBe(false);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
  });

  it("bedrock auth takes precedence over missing ANTHROPIC_API_KEY", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
      },
    });

    const codes = result.checks.map((c) => c.code);
    expect(codes).toContain("claude_bedrock_auth");
    expect(codes).not.toContain("claude_subscription_mode_possible");
    expect(codes).not.toContain("claude_anthropic_api_key_overrides_subscription");
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

  it("defaults remote probes to the environment remote cwd when adapter cwd is unset", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: process.execPath,
      },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "test-provider",
        remoteCwd: "/srv/paperclip/workspace",
        runner: {
          execute: async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
            pid: null,
            startedAt: new Date().toISOString(),
          }),
        },
      },
      environmentName: "Linux Box",
    });

    expect(result.checks.some((check) => check.code === "claude_cwd_valid")).toBe(true);
    expect(
      result.checks.some(
        (check) =>
          check.code === "claude_cwd_valid" &&
          check.message === "Working directory is valid: /srv/paperclip/workspace",
      ),
    ).toBe(true);
    expect(result.checks.some((check) => check.code === "claude_cwd_invalid")).toBe(false);
  });

  it("uses --allowedTools instead of --dangerously-skip-permissions for sandbox hello probes", async () => {
    const executeCalls: Array<{ command: string; args?: string[] }> = [];

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: "claude",
      },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "cloudflare",
        remoteCwd: "/workspace/paperclip",
        runner: {
          execute: async (input) => {
            executeCalls.push({ command: input.command, args: input.args });
            if (input.command === "claude") {
              return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                stdout: [
                  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
                  JSON.stringify({
                    type: "result",
                    result: "hello",
                    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
                  }),
                ].join("\n"),
                stderr: "",
                pid: null,
                startedAt: new Date().toISOString(),
              };
            }
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "",
              pid: null,
              startedAt: new Date().toISOString(),
            };
          },
        },
      },
      environmentName: "QA Cloudflare",
    });

    expect(result.checks.some((check) => check.code === "claude_hello_probe_passed")).toBe(true);
    const probeCall = executeCalls.find((call) => call.command === "claude");
    expect(probeCall?.args).not.toContain("--dangerously-skip-permissions");
    expect(probeCall?.args).not.toContain("--permission-mode");
    // Sandbox probes pass `--allowedTools` so any tool invocation triggered
    // by the probe prompt cannot stall waiting for an interactive permission
    // approval that no human is present to answer.
    expect(probeCall?.args).toContain("--allowedTools");
  });
});
