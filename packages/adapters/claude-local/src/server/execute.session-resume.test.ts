import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]): Promise<RunProcessResult> => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: args.includes("--version")
      ? "2.1.284 (Claude Code)\n"
      : JSON.stringify({
          type: "result",
          session_id: "12345678-1234-4abc-9def-123456789012",
          subtype: "success",
          is_error: false,
          result: "hello",
        }),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { execute } from "./execute.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

describe("Claude CLI session transcript preflight", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetClaudeCliCapabilitiesCacheForTests();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const runLocalCliSessionTurn = async (input: {
    runId: string;
    workspaceDir: string;
    configDir: string;
    sessionParams?: Record<string, unknown> | null;
    pluginImportMode?: string;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  }) => execute({
    runId: input.runId,
    agent: {
      id: "agent-claude-session-preflight",
      companyId: "company-claude-session-preflight",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: typeof input.sessionParams?.sessionId === "string" ? input.sessionParams.sessionId : null,
      sessionParams: input.sessionParams ?? null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      model: "claude-opus-5",
      engine: "cli",
      command: "claude",
      env: {
        CLAUDE_CONFIG_DIR: input.configDir,
        ...(input.pluginImportMode
          ? { PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE: input.pluginImportMode }
          : {}),
      },
    },
    context: {
      ...createPromptContextFixture(),
      paperclipWorkspace: { cwd: input.workspaceDir, source: "project_primary" },
    },
    onLog: input.onLog ?? (async () => {}),
  });

  const writeLocalClaudeTranscript = async (configDir: string, cwd: string, sessionId: string) => {
    const encodedCwd = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
    const transcriptPath = path.join(configDir, "projects", encodedCwd, `${sessionId}.jsonl`);
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, `${JSON.stringify({ type: "result", session_id: sessionId })}\n`);
  };

  it.each([
    ["without plugin import", undefined],
    ["with cache-mode environment", "cache"],
  ] as const)("resumes a local CLI session with a real transcript on the next run %s", async (_label, pluginImportMode) => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-existing-transcript-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const configDir = path.join(rootDir, "config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sessionId = "12345678-1234-4abc-9def-123456789012";
    let invocation = 0;
    runChildProcess.mockImplementation(async (_runId, _command, args) => {
      if (args.includes("--version")) {
        return {
          exitCode: 0, signal: null, timedOut: false, stdout: "2.1.284 (Claude Code)\n",
          stderr: "", pid: 123, startedAt: new Date().toISOString(),
        };
      }
      invocation += 1;
      return {
        exitCode: 0, signal: null, timedOut: false,
        stdout: JSON.stringify({
          type: "result", session_id: sessionId, subtype: "success", is_error: false,
          result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        }),
        stderr: "", pid: 123 + invocation, startedAt: new Date().toISOString(),
      };
    });

    const first = await runLocalCliSessionTurn({ runId: "run-session-first", workspaceDir, configDir, pluginImportMode });
    expect(first.sessionParams?.sessionId).toBe(sessionId);
    await writeLocalClaudeTranscript(configDir, workspaceDir, sessionId);

    const second = await runLocalCliSessionTurn({
      runId: "run-session-second", workspaceDir, configDir,
      sessionParams: first.sessionParams, pluginImportMode,
    });

    expect(second.exitCode).toBe(0);
    const providerCalls = runChildProcess.mock.calls.filter((call) => !(call[2] as string[]).includes("--version"));
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[1]?.[2]).toContain("--resume");
    expect(providerCalls[1]?.[2]).toContain(sessionId);
  });

  it.each([
    ["without plugin import", undefined],
    ["with cache-mode environment", "cache"],
  ] as const)("skips only a locally missing CLI transcript on the next run %s", async (_label, pluginImportMode) => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-missing-transcript-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const configDir = path.join(rootDir, "config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sessionId = "12345678-1234-4abc-9def-123456789012";
    let invocation = 0;
    runChildProcess.mockImplementation(async (_runId, _command, args) => {
      if (args.includes("--version")) {
        return {
          exitCode: 0, signal: null, timedOut: false, stdout: "2.1.284 (Claude Code)\n",
          stderr: "", pid: 123, startedAt: new Date().toISOString(),
        };
      }
      invocation += 1;
      const outputSessionId = invocation === 1 ? sessionId : "87654321-4321-4abc-9def-210987654321";
      return {
        exitCode: 0, signal: null, timedOut: false,
        stdout: JSON.stringify({
          type: "result", session_id: outputSessionId, subtype: "success", is_error: false,
          result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        }),
        stderr: "", pid: 123 + invocation, startedAt: new Date().toISOString(),
      };
    });

    const first = await runLocalCliSessionTurn({ runId: "run-missing-session-first", workspaceDir, configDir, pluginImportMode });
    const logMessages: string[] = [];
    const second = await runLocalCliSessionTurn({
      runId: "run-missing-session-second", workspaceDir, configDir,
      sessionParams: first.sessionParams, pluginImportMode,
      onLog: async (_stream, chunk) => { logMessages.push(chunk); },
    });

    expect(second.exitCode).toBe(0);
    const providerCalls = runChildProcess.mock.calls.filter((call) => !(call[2] as string[]).includes("--version"));
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[1]?.[2]).not.toContain("--resume");
    expect(logMessages.join("")).toContain("has no transcript in the active local config directory");
  });

  it.each([
    ["timeout", { exitCode: 1, signal: null, timedOut: true }],
    ["cancellation", { exitCode: null, signal: "SIGTERM", timedOut: false }],
  ] as const)("does not start a fresh attempt after a resumed CLI %s", async (_label, processState) => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-resume-stop-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const configDir = path.join(rootDir, "config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sessionId = "12345678-1234-4abc-9def-123456789012";
    await writeLocalClaudeTranscript(configDir, workspaceDir, sessionId);
    runChildProcess.mockResolvedValueOnce({
      ...processState,
      stdout: JSON.stringify({
        type: "result", session_id: sessionId, subtype: "error_during_execution", is_error: true,
        result: `No conversation found with session id ${sessionId}`,
      }),
      stderr: "", pid: 123, startedAt: new Date().toISOString(),
    });

    await runLocalCliSessionTurn({
      runId: `run-resume-${_label}`, workspaceDir, configDir,
      sessionParams: { sessionId, cwd: workspaceDir },
    });

    const providerCalls = runChildProcess.mock.calls.filter((call) => !(call[2] as string[]).includes("--version"));
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.[2]).toContain("--resume");
  });
});
