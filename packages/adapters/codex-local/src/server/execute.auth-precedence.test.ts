import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_SANDBOX_AUTH_EXISTS_COMMAND,
  CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING,
  CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING_LOG_LINE,
} from "./auth-precedence.js";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  prepareAdapterExecutionTargetRuntime: vi.fn(async () => ({
    target: { kind: "remote", transport: "sandbox", remoteCwd: "/sandbox/workspace" },
    workspaceRemoteDir: "/sandbox/workspace",
    runtimeRootDir: "/sandbox/.paperclip-runtime",
    assetDirs: { home: "/sandbox/.paperclip-runtime/codex/home" },
    restoreWorkspace: vi.fn(async () => undefined),
  })),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  runAdapterExecutionTargetShellCommand: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: null,
    startedAt: new Date().toISOString(),
  })),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    prepareAdapterExecutionTargetRuntime,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
    runAdapterExecutionTargetShellCommand,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";

describe("codex sandbox auth precedence warning", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("logs and emits a run event when sandbox login is shadowed by host auth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-precedence-"));
    cleanupDirs.push(root);
    const workspaceDir = path.join(root, "workspace");
    const hostCodexHome = path.join(root, "host-codex-home");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(hostCodexHome, { recursive: true });
    await fs.writeFile(
      path.join(hostCodexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "fake-host-auth" }),
      "utf8",
    );

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const events: Array<{ eventType: string; level?: string; message?: string; payload?: Record<string, unknown> }> = [];

    await execute({
      runId: "run-auth-precedence",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: { engine: "cli" },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        cwd: workspaceDir,
        env: { CODEX_HOME: hostCodexHome },
      },
      context: {},
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "fixture",
        remoteCwd: "/workspace",
        runner: { execute: vi.fn() },
      },
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      onEvent: async (event) => {
        events.push(event);
      },
    });

    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledWith(expect.objectContaining({
      assets: [expect.objectContaining({ key: "home", localDir: hostCodexHome })],
    }));
    expect(runAdapterExecutionTargetShellCommand).toHaveBeenCalledWith(
      "run-auth-precedence",
      expect.objectContaining({ kind: "remote", transport: "sandbox", remoteCwd: "/sandbox/workspace" }),
      CODEX_SANDBOX_AUTH_EXISTS_COMMAND,
      expect.objectContaining({ env: {}, timeoutSec: 5 }),
    );
    expect(logs).toContainEqual({
      stream: "stderr",
      chunk: CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING_LOG_LINE,
    });
    expect(events).toContainEqual({
      eventType: "codex.auth_precedence_warning",
      stream: "system",
      level: "warn",
      message: CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING,
      payload: {
        configuredApiKey: false,
        hostAuthJson: true,
        sandboxAuthJson: true,
        winner: "host_auth_json",
        sandboxLoginShadowed: true,
      },
    });
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledOnce();
  });
});
