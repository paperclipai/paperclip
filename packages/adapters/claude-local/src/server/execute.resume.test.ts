import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
  probeClaudeTranscript,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]): Promise<RunProcessResult> => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: args.includes("--version")
      ? "2.1.284 (Claude Code)\n"
      : [
          JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
          JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }),
          JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
        ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: claude"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
  probeClaudeTranscript: vi.fn<(...args: Parameters<typeof import("./transcript-probe.js").probeClaudeTranscript>) => Promise<boolean | null>>(),
}));

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

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

vi.mock("./transcript-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transcript-probe.js")>();
  return { ...actual, probeClaudeTranscript: probeClaudeTranscript.mockImplementation(actual.probeClaudeTranscript) };
});

import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { execute } from "./execute.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

const writeLocalClaudeTranscript = async (configDir: string, cwd: string, sessionId: string) => {
  const encodedCwd = (process.platform === "win32" ? cwd : await realpath(cwd)).replace(/[^a-zA-Z0-9-]/g, "-");
  const transcriptPath = path.join(configDir, "projects", encodedCwd, `${sessionId}.jsonl`);
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  await writeFile(transcriptPath, `${JSON.stringify({ type: "result", session_id: sessionId })}\n`);
};

describe("claude remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetClaudeCliCapabilitiesCacheForTests();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.each(["linux", "win32"] as const)("acknowledges local resume cancellation during a transcript miss before provider dispatch (%s)", async (platform) => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-cancel-transcript-miss-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const configDir = path.join(rootDir, "config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sessionId = "12345678-1234-4abc-9def-123456789012";
    await writeLocalClaudeTranscript(configDir, workspaceDir, sessionId);

    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const controller = new AbortController();
    let finishProbe!: (value: boolean | null) => void;
    let probeEntered!: () => void;
    const entered = new Promise<void>((resolve) => { probeEntered = resolve; });
    probeClaudeTranscript.mockImplementationOnce(() => new Promise((resolve) => { finishProbe = resolve; probeEntered(); }));
    const onCancellationReady = vi.fn(async () => {});
    const onSpawn = vi.fn();

    const executing = execute({
      runId: `run-claude-cancel-transcript-miss-${platform}`,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId,
        sessionParams: { sessionId, cwd: workspaceDir },
        sessionDisplayId: sessionId,
        taskKey: null,
      },
      config: {
        model: "claude-opus-5",
        engine: "cli",
        command: "claude",
        env: { ANTHROPIC_API_KEY: "fixture-anthropic-key", CLAUDE_CONFIG_DIR: configDir },
      },
      context: {
        ...createPromptContextFixture(),
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      signal: controller.signal,
      onCancellationReady,
      onSpawn,
      onLog: async () => {},
    });

    await entered;
    expect(onCancellationReady).toHaveBeenCalledTimes(1);
    controller.abort();
    finishProbe(false);
    const result = await executing;
    expect(probeClaudeTranscript).toHaveBeenCalledTimes(1);
    expect(onCancellationReady).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe("cancelled");
    expect(result.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged" });
    expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
    expect(onSpawn).not.toHaveBeenCalled();
    const providerCalls = runChildProcess.mock.calls.filter((call) => !(call[2] as string[]).includes("--version"));
    expect(providerCalls).toHaveLength(0);
  });

  it("retries an unknown resumed session when terminal-result cleanup stopped the CLI", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-cli-cleaned-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const configDir = path.join(rootDir, "config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const missingSessionId = "12345678-1234-4abc-9def-123456789012";
    await writeLocalClaudeTranscript(configDir, workspaceDir, missingSessionId);

    runChildProcess
      .mockResolvedValueOnce({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        stdout: JSON.stringify({
          type: "result",
          session_id: missingSessionId,
          is_error: true,
          subtype: "error_during_execution",
          result: `No conversation found with session id ${missingSessionId}`,
        }),
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
        processTreeStopped: true,
        terminalResultCleanup: {
          kind: "terminal_result_cleanup",
          stopped: true,
          stopReason: "unmanaged_background_task_stopped",
          reason: "unmanaged background task stopped; no durable live path",
          terminalResultSeen: true,
          signal: "SIGTERM",
          forceKilled: false,
        },
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "session-fresh", model: "claude-sonnet" }),
          JSON.stringify({ type: "result", session_id: "session-fresh", subtype: "success", is_error: false, result: "Recovered" }),
        ].join("\n"),
        stderr: "",
        pid: 124,
        startedAt: new Date().toISOString(),
      });

    const result = await execute({
      runId: "run-claude-cleaned-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: missingSessionId,
        sessionParams: { sessionId: missingSessionId, cwd: workspaceDir },
        sessionDisplayId: missingSessionId,
        taskKey: null,
      },
      config: {
        model: "claude-opus-5",
        engine: "cli",
        command: "claude",
        env: { ANTHROPIC_API_KEY: "fixture-anthropic-key", CLAUDE_CONFIG_DIR: configDir },
      },
      context: {
        ...createPromptContextFixture(),
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(runChildProcess).toHaveBeenCalledTimes(2);
    const providerCalls = runChildProcess.mock.calls.filter((call) => !(call[2] as string[]).includes("--version"));
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[0]?.[2]).toContain("--resume");
    expect(providerCalls[1]?.[2]).not.toContain("--resume");
  });

  it("does not retry a successful result that mentions an unknown session after cleanup", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-cli-cleaned-success-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const configDir = path.join(rootDir, "config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sessionId = "12345678-1234-4abc-9def-123456789012";
    await writeLocalClaudeTranscript(configDir, workspaceDir, sessionId);

    runChildProcess.mockResolvedValueOnce({
      // Windows cleanup can produce a nonzero synthetic exit even after the
      // CLI emitted a successful terminal result.
      exitCode: process.platform === "win32" ? 1 : null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: JSON.stringify({
        type: "result",
        session_id: sessionId,
        is_error: false,
        subtype: "success",
        result: "I fixed the unknown session issue and completed the assignment.",
      }),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
      terminalResultCleanup: {
        kind: "terminal_result_cleanup",
        stopped: true,
        stopReason: "unmanaged_background_task_stopped",
        reason: "unmanaged background task stopped; no durable live path",
        terminalResultSeen: true,
        signal: "SIGTERM",
        forceKilled: false,
      },
      processTreeStopped: true,
    });

    await execute({
      runId: "run-claude-cleaned-success",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId,
        sessionParams: { sessionId, cwd: workspaceDir },
        sessionDisplayId: sessionId,
        taskKey: null,
      },
      config: {
        model: "claude-opus-5",
        engine: "cli",
        command: "claude",
        env: { ANTHROPIC_API_KEY: "fixture-anthropic-key", CLAUDE_CONFIG_DIR: configDir },
      },
      context: {
        ...createPromptContextFixture(),
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async () => {},
    });

    const providerCalls = runChildProcess.mock.calls.filter((call) => !(call[2] as string[]).includes("--version"));
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.[2]).toContain("--resume");
  });

  it.skipIf(process.platform !== "win32")("acknowledges Windows cancellation before provider dispatch", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-cancel-before-dispatch-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const configDir = path.join(rootDir, "config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sessionId = "12345678-1234-4abc-9def-123456789012";
    await writeLocalClaudeTranscript(configDir, workspaceDir, sessionId);

    const controller = new AbortController();
    const onSpawn = vi.fn();
    const result = await execute({
      runId: "run-claude-cancel-before-dispatch",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId,
        sessionParams: { sessionId, cwd: workspaceDir },
        sessionDisplayId: sessionId,
        taskKey: null,
      },
      config: {
        model: "claude-opus-5",
        engine: "cli",
        command: "claude",
        env: { ANTHROPIC_API_KEY: "fixture-anthropic-key", CLAUDE_CONFIG_DIR: configDir },
      },
      context: {
        ...createPromptContextFixture(),
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      signal: controller.signal,
      onCancellationReady: async () => controller.abort(),
      onSpawn,
      onLog: async () => {},
    });

    expect(result.errorCode).toBe("cancelled");
    expect(result.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged" });
    expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
    expect(onSpawn).not.toHaveBeenCalled();
    const providerCalls = runChildProcess.mock.calls.filter((call) => !(call[2] as string[]).includes("--version"));
    expect(providerCalls).toHaveLength(0);
  });

  it("acknowledges a dispatched POSIX resume cancellation after the process tree stops", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-posix-resume-stop-confirmed-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const configDir = path.join(rootDir, "config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sessionId = "12345678-1234-4abc-9def-123456789012";
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    await writeLocalClaudeTranscript(configDir, workspaceDir, sessionId);

    const controller = new AbortController();
    const collectInstructions = vi.fn(async () => {});
    probeClaudeTranscript.mockResolvedValueOnce(true);
    runChildProcess.mockImplementationOnce((async (...args: unknown[]) => {
      const [, , , options] = args as [string, string, string[], {
        onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
      }];
      const startedAt = new Date().toISOString();
      await options.onSpawn?.({ pid: 123, processGroupId: 123, startedAt });
      controller.abort();
      return {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        stdout: JSON.stringify({ type: "result", session_id: sessionId, subtype: "success", is_error: false, result: "done" }),
        stderr: "",
        pid: 123,
        startedAt,
        processTreeStopped: true,
      };
    }) as unknown as typeof runChildProcess);

    const result = await execute({
      runId: "run-claude-posix-resume-stop-confirmed",
      agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId, sessionParams: { sessionId, cwd: workspaceDir }, sessionDisplayId: sessionId, taskKey: null },
      config: { model: "claude-opus-5", engine: "cli", command: "claude", env: { ANTHROPIC_API_KEY: "fixture-anthropic-key", CLAUDE_CONFIG_DIR: configDir } },
      context: { ...createPromptContextFixture(), paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      signal: controller.signal,
      onProviderStopped: collectInstructions,
      onLog: async () => {},
    });

    expect(result.errorCode).toBe("cancelled");
    expect(result.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged" });
    expect(collectInstructions).toHaveBeenCalledTimes(1);
    const providerCalls = runChildProcess.mock.calls.filter((call) => !(call[2] as string[]).includes("--version"));
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.[2]).toContain("--resume");
  });

  it("does not collect instructions after a dispatched POSIX resume cancellation without stop proof", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-posix-resume-stop-unconfirmed-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const configDir = path.join(rootDir, "config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sessionId = "12345678-1234-4abc-9def-123456789012";
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    await writeLocalClaudeTranscript(configDir, workspaceDir, sessionId);

    const controller = new AbortController();
    const collectInstructions = vi.fn(async () => {});
    probeClaudeTranscript.mockResolvedValueOnce(true);
    runChildProcess.mockImplementationOnce((async (...args: unknown[]) => {
      const [, , , options] = args as [string, string, string[], {
        onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
      }];
      const startedAt = new Date().toISOString();
      await options.onSpawn?.({ pid: 123, processGroupId: 123, startedAt });
      controller.abort();
      return {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        stdout: JSON.stringify({ type: "result", session_id: sessionId, subtype: "success", is_error: false, result: "done" }),
        stderr: "",
        pid: 123,
        startedAt,
        processTreeStopped: false,
      };
    }) as unknown as typeof runChildProcess);

    const result = await execute({
      runId: "run-claude-posix-resume-stop-unconfirmed",
      agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId, sessionParams: { sessionId, cwd: workspaceDir }, sessionDisplayId: sessionId, taskKey: null },
      config: { model: "claude-opus-5", engine: "cli", command: "claude", env: { ANTHROPIC_API_KEY: "fixture-anthropic-key", CLAUDE_CONFIG_DIR: configDir } },
      context: { ...createPromptContextFixture(), paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      signal: controller.signal,
      onProviderStopped: collectInstructions,
      onLog: async () => {},
    });

    expect(result.errorCode).toBe("provider_stop_unconfirmed");
    expect(result.resultJson?.providerStopUnconfirmed).toBe(true);
    expect(collectInstructions).not.toHaveBeenCalled();
    const providerCalls = runChildProcess.mock.calls.filter((call) => !(call[2] as string[]).includes("--version"));
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.[2]).toContain("--resume");
  });

  it.skipIf(process.platform !== "win32")("holds an otherwise successful Windows resume when process-tree stop is unverified", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-unverified-stop-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const configDir = path.join(rootDir, "config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sessionId = "12345678-1234-4abc-9def-123456789012";
    await writeLocalClaudeTranscript(configDir, workspaceDir, sessionId);
    runChildProcess.mockResolvedValueOnce({
      exitCode: 0, signal: null, timedOut: false,
      stdout: JSON.stringify({ type: "result", session_id: sessionId, subtype: "success", is_error: false, result: "done" }),
      stderr: "", pid: 123, startedAt: new Date().toISOString(), processTreeStopped: false,
    });
    const collect = vi.fn(async () => {});
    const result = await execute({
      runId: "run-claude-unverified-stop",
      agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId, sessionParams: { sessionId, cwd: workspaceDir }, sessionDisplayId: sessionId, taskKey: null },
      config: { model: "claude-opus-5", engine: "cli", command: "claude", env: { ANTHROPIC_API_KEY: "fixture-anthropic-key", CLAUDE_CONFIG_DIR: configDir } },
      context: { ...createPromptContextFixture(), paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onProviderStopped: collect,
      onLog: async () => {},
    });
    expect(result.errorCode).toBe("provider_stop_unconfirmed");
    expect(result.errorMessage).toMatch(/could not be verified/i);
    expect(result.sessionId).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
    expect(result.clearSession).toBe(false);
    expect(collect).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("does not retry a POSIX resume when terminal cleanup has no group stop proof", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-unverified-stop-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const configDir = path.join(rootDir, "config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sessionId = "12345678-1234-4abc-9def-123456789012";
    await writeLocalClaudeTranscript(configDir, workspaceDir, sessionId);
    runChildProcess.mockResolvedValueOnce({
      exitCode: 1, signal: "SIGTERM", timedOut: false,
      stdout: JSON.stringify({ type: "result", session_id: sessionId, subtype: "error_during_execution", is_error: true, result: `No conversation found with session id ${sessionId}` }),
      stderr: "", pid: 123, startedAt: new Date().toISOString(), processTreeStopped: false,
    });
    const collect = vi.fn(async () => {});
    const result = await execute({
      runId: "run-claude-unverified-stop",
      agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId, sessionParams: { sessionId, cwd: workspaceDir }, sessionDisplayId: sessionId, taskKey: null },
      config: { model: "claude-opus-5", engine: "cli", command: "claude", env: { ANTHROPIC_API_KEY: "fixture-anthropic-key", CLAUDE_CONFIG_DIR: configDir } },
      context: { ...createPromptContextFixture(), paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onProviderStopped: collect,
      onLog: async () => {},
    });
    expect(result.errorCode).toBe("provider_stop_unconfirmed");
    expect(result.errorMessage).toMatch(/could not be verified/i);
    expect(result.sessionId).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
    expect(result.clearSession).toBe(false);
    expect(collect).not.toHaveBeenCalled();
    expect(runChildProcess.mock.calls.filter((call) => !(call[2] as string[]).includes("--version"))).toHaveLength(1);
  });

  it.skipIf(process.platform !== "win32")("does not acknowledge cancellation as pre-start after dispatch without stop proof", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-cancel-after-dispatch-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const configDir = path.join(rootDir, "config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sessionId = "12345678-1234-4abc-9def-123456789012";
    await writeLocalClaudeTranscript(configDir, workspaceDir, sessionId);

    const controller = new AbortController();
    runChildProcess.mockImplementationOnce((async (...args: unknown[]) => {
      const [, , , options] = args as [
        string,
        string,
        string[],
        { onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void> },
      ];
      await options.onSpawn?.({ pid: 123, processGroupId: null, startedAt: new Date().toISOString() });
      controller.abort();
      throw new Error("synthetic process failure without stop proof");
    }) as unknown as typeof runChildProcess);

    await expect(execute({
      runId: "run-claude-cancel-after-dispatch",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId,
        sessionParams: { sessionId, cwd: workspaceDir },
        sessionDisplayId: sessionId,
        taskKey: null,
      },
      config: {
        model: "claude-opus-5",
        engine: "cli",
        command: "claude",
        env: { ANTHROPIC_API_KEY: "fixture-anthropic-key", CLAUDE_CONFIG_DIR: configDir },
      },
      context: {
        ...createPromptContextFixture(),
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      signal: controller.signal,
      onCancellationReady: async () => {},
      onLog: async () => {},
    })).rejects.toThrow("synthetic process failure without stop proof");
  });

  it.skipIf(process.platform !== "win32")("does not retry an unknown resumed session without Windows process-tree stop proof", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-unknown-session-no-stop-proof-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const configDir = path.join(rootDir, "config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sessionId = "12345678-1234-4abc-9def-123456789012";
    await writeLocalClaudeTranscript(configDir, workspaceDir, sessionId);

    runChildProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: "SIGTERM",
      timedOut: false,
      stdout: JSON.stringify({
        type: "result",
        session_id: sessionId,
        is_error: true,
        subtype: "error_during_execution",
        result: `No conversation found with session id ${sessionId}`,
      }),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
      terminalResultCleanup: {
        kind: "terminal_result_cleanup",
        stopped: true,
        stopReason: "unmanaged_background_task_stopped",
        reason: "unmanaged background task stopped; no durable live path",
        terminalResultSeen: true,
        signal: "SIGTERM",
        forceKilled: false,
      },
      processTreeStopped: false,
    });

    const result = await execute({
      runId: "run-claude-unknown-session-no-stop-proof",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId,
        sessionParams: { sessionId, cwd: workspaceDir },
        sessionDisplayId: sessionId,
        taskKey: null,
      },
      config: {
        model: "claude-opus-5",
        engine: "cli",
        command: "claude",
        env: { ANTHROPIC_API_KEY: "fixture-anthropic-key", CLAUDE_CONFIG_DIR: configDir },
      },
      context: {
        ...createPromptContextFixture(),
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async () => {},
    });

    const providerCalls = runChildProcess.mock.calls.filter((call) => !(call[2] as string[]).includes("--version"));
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.[2]).toContain("--resume");
    expect(result.clearSession).not.toBe(true);
  });

});
