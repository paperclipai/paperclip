import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs, defaultRunChildProcess } =
  vi.hoisted(() => {
    const claudeStdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    ].join("\n");
    // Default: STS probe succeeds (exit 0), Claude spawn returns a normal result.
    const defaultRunChildProcess = async (_runId: string, command: string): Promise<RunProcessResult> => {
      if (command === "aws") {
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: '{"Account":"123456789012","Arn":"arn:aws:sts::123456789012:assumed-role/x"}',
          stderr: "",
          pid: 100,
          startedAt: new Date().toISOString(),
        };
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: claudeStdout,
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    };
    return {
      defaultRunChildProcess,
      runChildProcess: vi.fn(defaultRunChildProcess),
      ensureCommandResolvable: vi.fn(async () => undefined),
      resolveCommandForLogs: vi.fn(async () => "claude"),
    };
  });

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

const EXPIRED_STS_STDERR =
  "An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired";

async function runExecute(input: {
  workspaceDir: string;
  bedrock: boolean;
  refreshCommand?: string;
}) {
  const logs: Array<{ stream: string; chunk: string }> = [];
  const result = await execute({
    runId: "run-preflight",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Clara",
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
      ...(input.refreshCommand ? { bedrockCredentialRefreshCommand: input.refreshCommand } : {}),
      ...(input.bedrock
        ? { env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" } }
        : {}),
    },
    context: {
      paperclipWorkspace: {
        cwd: input.workspaceDir,
        source: "project_primary",
      },
    },
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
  });
  return { result, logs };
}

describe("claude execute Bedrock pre-flight credential gate", () => {
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    // clearAllMocks() wipes call history but NOT per-test mockImplementation
    // overrides, so restore the default probe/spawn behavior before each test to
    // keep cases that rely on it isolated from cases that set their own.
    runChildProcess.mockImplementation(defaultRunChildProcess);
    // execute() folds process.env into effectiveEnv, so a host that itself runs
    // on Bedrock (CLAUDE_CODE_USE_BEDROCK=1) would make isBedrockAuth() true even
    // for the non-Bedrock case. Neutralize the ambient Bedrock signals so each
    // test controls auth mode purely through its own config.
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    vi.stubEnv("ANTHROPIC_BEDROCK_BASE_URL", "");
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("defers (no spawn) when the pre-flight STS probe detects an expired token", async () => {
    // Probe reports expired; Claude spawn must NOT run.
    runChildProcess.mockImplementation(async (_runId: string, command: string) => {
      if (command === "aws") {
        return {
          exitCode: 255,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: EXPIRED_STS_STDERR,
          pid: 100,
          startedAt: new Date().toISOString(),
        };
      }
      throw new Error(`Claude CLI should not spawn when credentials are expired (got command=${command})`);
    });

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-preflight-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const { result, logs } = await runExecute({ workspaceDir, bedrock: true });

    // (a) CLI is never spawned — only the aws probe ran.
    const commandsRun = runChildProcess.mock.calls.map((call) => call[1]);
    expect(commandsRun).toContain("aws");
    expect(commandsRun).not.toContain("claude");

    // (b) transient defer contract.
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorCode).toBe("claude_transient_upstream");
    expect(result.errorMessage).toContain("Bedrock credential expired");
    expect(result.retryNotBefore).toBeTruthy();
    expect(new Date(result.retryNotBefore as string).getTime()).toBeGreaterThan(Date.now());
    // resultJson carries the recovery triple heartbeat.ts reads.
    expect(result.resultJson?.errorFamily).toBe("transient_upstream");
    expect(result.resultJson?.retryNotBefore).toBe(result.retryNotBefore);
    expect(result.resultJson?.transientRetryNotBefore).toBe(result.retryNotBefore);

    // (c) exactly one greppable alert on entering the deferred state.
    const alerts = logs.filter((entry) => entry.chunk.includes("BEDROCK_CREDENTIAL_EXPIRED"));
    expect(alerts).toHaveLength(1);
  });

  it("self-heals: refresh command recovers expired creds, re-probe passes, and the CLI spawns (MAS-751)", async () => {
    // First STS probe = expired; refresh command (sh) succeeds; second STS
    // probe = valid; Claude then spawns normally.
    let awsProbeCalls = 0;
    runChildProcess.mockImplementation(async (_runId: string, command: string) => {
      if (command === "aws") {
        awsProbeCalls += 1;
        if (awsProbeCalls === 1) {
          return {
            exitCode: 255,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: EXPIRED_STS_STDERR,
            pid: 100,
            startedAt: new Date().toISOString(),
          };
        }
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: '{"Account":"123456789012","Arn":"arn:aws:sts::123456789012:assumed-role/x"}',
          stderr: "",
          pid: 101,
          startedAt: new Date().toISOString(),
        };
      }
      if (command === "sh") {
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "refreshed",
          stderr: "",
          pid: 102,
          startedAt: new Date().toISOString(),
        };
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m" }),
          JSON.stringify({ type: "result", session_id: "s", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
        ].join("\n"),
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    });

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-preflight-refresh-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const { result } = await runExecute({
      workspaceDir,
      bedrock: true,
      refreshCommand: "ada credentials update --once",
    });

    const commandsRun = runChildProcess.mock.calls.map((call) => call[1]);
    // probe -> refresh (sh) -> re-probe -> claude
    expect(commandsRun).toContain("sh");
    expect(commandsRun).toContain("claude");
    expect(awsProbeCalls).toBe(2);
    expect(result.errorCode).toBeFalsy();
    expect(result.summary).toBe("hello");
  });

  it("defers when a configured refresh command fails to recover expired creds (MAS-751)", async () => {
    runChildProcess.mockImplementation(async (_runId: string, command: string) => {
      if (command === "aws") {
        return {
          exitCode: 255,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: EXPIRED_STS_STDERR,
          pid: 100,
          startedAt: new Date().toISOString(),
        };
      }
      if (command === "sh") {
        // Refresh command itself fails (e.g. SSO session also expired).
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "ada: could not refresh credentials",
          pid: 102,
          startedAt: new Date().toISOString(),
        };
      }
      throw new Error(`Claude CLI should not spawn when refresh fails (got command=${command})`);
    });

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-preflight-refresh-fail-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const { result } = await runExecute({
      workspaceDir,
      bedrock: true,
      refreshCommand: "ada credentials update --once",
    });

    const commandsRun = runChildProcess.mock.calls.map((call) => call[1]);
    expect(commandsRun).toContain("sh"); // refresh attempted
    expect(commandsRun).not.toContain("claude"); // but never spawned
    // Falls back to the transient defer contract.
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorCode).toBe("claude_transient_upstream");
    expect(result.retryNotBefore).toBeTruthy();
  });

  it("spawns the CLI as normal when the pre-flight probe reports valid credentials", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-preflight-ok-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const { result } = await runExecute({ workspaceDir, bedrock: true });

    const commandsRun = runChildProcess.mock.calls.map((call) => call[1]);
    expect(commandsRun).toContain("aws");
    expect(commandsRun).toContain("claude");
    expect(result.errorCode).toBeFalsy();
    expect(result.summary).toBe("hello");
  });

  it("skips the pre-flight probe entirely for non-Bedrock auth", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-preflight-skip-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const { result } = await runExecute({ workspaceDir, bedrock: false });

    const commandsRun = runChildProcess.mock.calls.map((call) => call[1]);
    expect(commandsRun).not.toContain("aws");
    expect(commandsRun).toContain("claude");
    expect(result.summary).toBe("hello");
  });

  it("fails open and spawns when the probe times out (never hangs the heartbeat)", async () => {
    runChildProcess.mockImplementation(async (_runId: string, command: string) => {
      if (command === "aws") {
        return {
          exitCode: null,
          signal: null,
          timedOut: true,
          stdout: "",
          stderr: "",
          pid: 100,
          startedAt: new Date().toISOString(),
        };
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m" }),
          JSON.stringify({ type: "result", session_id: "s", result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
        ].join("\n"),
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    });

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-preflight-timeout-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const { result } = await runExecute({ workspaceDir, bedrock: true });

    const commandsRun = runChildProcess.mock.calls.map((call) => call[1]);
    expect(commandsRun).toContain("aws");
    expect(commandsRun).toContain("claude");
    expect(result.errorCode).toBeFalsy();
  });
});
