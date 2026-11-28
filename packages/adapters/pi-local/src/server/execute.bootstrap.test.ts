import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, testHome } = await vi.hoisted(async () => {
  const [{ default: os }, { default: nodePath }] = await Promise.all([
    import("node:os"),
    import("node:path"),
  ]);
  const home = nodePath.join(os.tmpdir(), `paperclip-pi-bootstrap-${process.pid}-${Date.now()}`);
  process.env.HOME = home;
  const behavior = { kind: "ok" as "ok" | "spawn_refused" | "start_then_fail" | "remote_fail_without_receipt" };
  const piStdout = JSON.stringify({
    type: "turn_end",
    message: {
      role: "assistant",
      content: "done",
      usage: { input: 10, output: 20, cacheRead: 0, cost: { total: 0.01 } },
    },
    toolResults: [],
  });
  return {
    testHome: home,
    mocks: {
      behavior,
      ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
      ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
      prepareAdapterExecutionTargetRuntime: vi.fn(async () => ({
        workspaceRemoteDir: "/remote/workspace",
        runtimeRootDir: "/remote/runtime",
        assetDirs: { skills: "/remote/skills", attribution: "/remote/attribution" },
        restoreWorkspace: async () => {},
      })),
      startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
      ensureAdapterExecutionTargetFile: vi.fn(async () => undefined),
      ensurePiModelConfiguredAndAvailable: vi.fn(async () => [
        { id: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini" },
      ]),
      runAdapterExecutionTargetProcess: vi.fn(async (
        _runId: string,
        _target: unknown,
        _command: string,
        _args: string[],
        options: { onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void> },
      ) => {
        if (behavior.kind === "spawn_refused") {
          throw Object.assign(
            new Error('Failed to start command "pi" in "/workspace": spawn pi EMFILE'),
            { code: "EMFILE" },
          );
        }
        if (behavior.kind === "remote_fail_without_receipt") {
          throw new Error("sandbox provider lost the session");
        }
        if (behavior.kind === "start_then_fail") {
          await options.onSpawn?.({ pid: 4242, processGroupId: null, startedAt: new Date().toISOString() });
          throw new Error("provider process crashed");
        }
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: piStdout,
          stderr: "",
          pid: 4242,
          startedAt: new Date().toISOString(),
        };
      }),
    },
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: mocks.ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled: mocks.ensureAdapterExecutionTargetRuntimeCommandInstalled,
    prepareAdapterExecutionTargetRuntime: mocks.prepareAdapterExecutionTargetRuntime,
    startAdapterExecutionTargetPaperclipBridge: mocks.startAdapterExecutionTargetPaperclipBridge,
    ensureAdapterExecutionTargetFile: mocks.ensureAdapterExecutionTargetFile,
    runAdapterExecutionTargetProcess: mocks.runAdapterExecutionTargetProcess,
  };
});

vi.mock("./models.js", async () => {
  const actual = await vi.importActual<typeof import("./models.js")>("./models.js");
  return { ...actual, ensurePiModelConfiguredAndAvailable: mocks.ensurePiModelConfiguredAndAvailable };
});

import { execute } from "./execute.js";

describe("pi pre-provider failure accounting", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-bootstrap-workspace-"));
    mocks.behavior.kind = "ok";
    mocks.ensureAdapterExecutionTargetCommandResolvable.mockResolvedValue(undefined);
    mocks.ensureAdapterExecutionTargetRuntimeCommandInstalled.mockResolvedValue(undefined);
    mocks.ensurePiModelConfiguredAndAvailable.mockResolvedValue([
      { id: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini" },
    ]);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  });

  const context = () => ({
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Pi Builder",
      adapterType: "pi_local" as const,
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "pi", model: "openai/gpt-5.4-mini", env: { HOME: testHome } },
    context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
    onLog: async () => {},
  });

  it("reports a model discovery failure as a pre-provider failure instead of throwing", async () => {
    mocks.ensurePiModelConfiguredAndAvailable.mockRejectedValueOnce(
      new Error("`pi --list-models` timed out."),
    );

    const result = await execute(context());

    expect(result).toMatchObject({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "pi_bootstrap_failed",
      errorFamily: "transient_upstream",
      usageComplete: false,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    });
    expect(result.errorMessage).toContain("`pi --list-models` timed out.");
    expect(mocks.runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("classifies a configuration failure as a configuration error family", async () => {
    mocks.ensurePiModelConfiguredAndAvailable.mockRejectedValueOnce(
      new Error("Configured Pi model is unavailable: openai/gpt-5.4-mini."),
    );

    const result = await execute(context());

    expect(result).toMatchObject({
      errorCode: "pi_bootstrap_failed",
      errorFamily: "configuration",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    });
  });

  it("reports a refused process start as a pre-provider failure", async () => {
    mocks.behavior.kind = "spawn_refused";

    const result = await execute(context());

    expect(result).toMatchObject({
      errorCode: "pi_bootstrap_failed",
      errorFamily: "transient_upstream",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    });
    expect(result.errorMessage).toContain("EMFILE");
  });

  it("classifies a refused model discovery spawn as a transient upstream failure", async () => {
    mocks.ensurePiModelConfiguredAndAvailable.mockRejectedValueOnce(
      Object.assign(
        new Error('Failed to start command "pi" in "/workspace": spawn pi EMFILE'),
        { code: "EMFILE" },
      ),
    );

    const result = await execute(context());

    expect(result).toMatchObject({
      errorCode: "pi_bootstrap_failed",
      errorFamily: "transient_upstream",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    });
    expect(mocks.runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("keeps a failure after the provider process started unproven", async () => {
    mocks.behavior.kind = "start_then_fail";

    await expect(execute(context())).rejects.toThrow("provider process crashed");
  });

  it("keeps a sandbox dispatch failure conservative because the sandbox runner reports no spawn receipt", async () => {
    mocks.behavior.kind = "remote_fail_without_receipt";

    await expect(
      execute({
        ...context(),
        executionTarget: {
          kind: "remote" as const,
          transport: "sandbox" as const,
          remoteCwd: "/remote/workspace",
          timeoutMs: 60_000,
          runner: {
            execute: async () => ({
              exitCode: 0,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "",
              pid: null,
              startedAt: null,
            }),
          },
        },
      }),
    ).rejects.toThrow("sandbox provider lost the session");
    expect(mocks.runAdapterExecutionTargetProcess).toHaveBeenCalledOnce();
  });

  it("never labels a completed provider run as a pre-provider failure", async () => {
    const result = await execute(context());

    expect(result.errorCode ?? null).toBeNull();
    expect(result.executionRecovery).toBeUndefined();
    expect(mocks.runAdapterExecutionTargetProcess).toHaveBeenCalledOnce();
  });
});
