import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-claude-local/server";

function normalizeResolvedCommandForAssert(value: string | null): string | null {
  if (value == null) return null;
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function rmWithRetry(target: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        attempt === 9 ||
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "EBUSY"
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || null,
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeWindowsCommandShim(commandPath: string): Promise<string> {
  const shimPath = `${commandPath}.cmd`;
  const escapedCommandPath = commandPath.replaceAll('"', '""');
  const shim = `@echo off\r\nnode "${escapedCommandPath}" %*\r\n`;
  await fs.writeFile(shimPath, shim, "utf8");
  return shimPath;
}

async function writeFakeClaudeRateLimitedCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1775260800, rateLimitType: "seven_day_sonnet", overageStatus: "rejected", overageDisabledReason: "out_of_credits", isUsingOverage: false }, uuid: "4895ab2a-02cc-47a9-b54e-2cbd794731da", session_id: "claude-session-1" }));
console.log("You're out of extra usage · resets Apr 4, 3am (Asia/Jerusalem)");
process.exit(1);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("claude execute", () => {
  it("logs HOME, CLAUDE_CONFIG_DIR, and the resolved executable path in invocation metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-meta-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "claude");
    const capturePath = path.join(root, "capture.json");
    const claudeConfigDir = path.join(root, "claude-config");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await writeFakeClaudeCommand(commandPath);
    const resolvedCommandPath =
      process.platform === "win32" ? await writeWindowsCommandShim(commandPath) : commandPath;

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    let loggedCommand: string | null = null;
    let loggedEnv: Record<string, string> = {};
    try {
      const result = await execute({
        runId: "run-meta",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
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
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          loggedCommand = meta.command;
          loggedEnv = meta.env ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(normalizeResolvedCommandForAssert(loggedCommand)).toBe(
        normalizeResolvedCommandForAssert(resolvedCommandPath),
      );
      expect(loggedEnv.HOME).toBe(root);
      expect(loggedEnv.CLAUDE_CONFIG_DIR).toBe(claudeConfigDir);
      expect(normalizeResolvedCommandForAssert(loggedEnv.PAPERCLIP_RESOLVED_COMMAND ?? null)).toBe(
        normalizeResolvedCommandForAssert(resolvedCommandPath),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      await rmWithRetry(root);
    }
  });

  it("classifies rate-limit failures with a dedicated error code", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-rate-limit-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "claude");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeClaudeRateLimitedCommand(commandPath);
    if (process.platform === "win32") {
      await writeWindowsCommandShim(commandPath);
    }
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

    try {
      const result = await execute({
        runId: "run-rate-limit",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
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
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("claude_rate_limited");
      expect(result.errorMessage).toContain("Claude exited with code 1");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rmWithRetry(root);
    }
  }, 15000);
});
