import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const mocks = vi.hoisted(() => {
  const state: {
    isRemote: boolean;
    prepareRuntimeResult: { workspaceRemoteDir?: string | null; assetDirs?: Record<string, string> } | null;
  } = { isRemote: false, prepareRuntimeResult: null };
  return {
    state,
    ensureRuntimeInstalledMock: vi.fn(async () => {}),
    ensureCommandMock: vi.fn(async () => {}),
    resolveCommandForLogsMock: vi.fn(async () => "pi"),
    runProcessMock: vi.fn(),
    prepareRuntimeMock: vi.fn(
      async (input: { assets?: Array<{ key: string; localDir: string; followSymlinks?: boolean }> }) => {
        const override = state.prepareRuntimeResult;
        const assetDirs =
          override?.assetDirs ??
          Object.fromEntries(
            (input.assets ?? []).map((asset) => [asset.key, `/remote/workspace/.paperclip-runtime/pi/${asset.key}`]),
          );
        const workspaceRemoteDir = override && "workspaceRemoteDir" in override
          ? override.workspaceRemoteDir
          : "/remote/workspace";
        return { workspaceRemoteDir, assetDirs, restoreWorkspace: async () => {} };
      },
    ),
  };
});

const {
  state: remoteState,
  ensureRuntimeInstalledMock,
  ensureCommandMock,
  resolveCommandForLogsMock,
  runProcessMock,
  prepareRuntimeMock,
} = mocks;

vi.mock("@paperclipai/adapter-utils/execution-target", async () => ({
  ...await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target"),
  adapterExecutionTargetUsesPaperclipBridge: () => false,
  ensureAdapterExecutionTargetFile: vi.fn(async () => {}),
  adapterExecutionTargetIsRemote: () => mocks.state.isRemote,
  adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) =>
    mocks.state.isRemote ? "/remote/workspace" : cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown, _cwd: string) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: mocks.state.isRemote ? "remote" : "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  describeAdapterExecutionTarget: () => (mocks.state.isRemote ? "remote" : "local"),
  ensureAdapterExecutionTargetCommandResolvable: (...args: unknown[]) =>
    (mocks.ensureCommandMock as (...args: unknown[]) => unknown)(...args),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: (...args: unknown[]) =>
    (mocks.ensureRuntimeInstalledMock as (...args: unknown[]) => unknown)(...args),
  prepareAdapterExecutionTargetRuntime: (...args: unknown[]) =>
    (mocks.prepareRuntimeMock as (...args: unknown[]) => unknown)(...args),
  readAdapterExecutionTarget: (input: { executionTarget?: unknown }) => input.executionTarget ??
    (mocks.state.isRemote ? { kind: "remote", transport: "ssh" } : { kind: "local" }),
  resolveAdapterExecutionTargetCommandForLogs: (...args: unknown[]) =>
    (mocks.resolveCommandForLogsMock as (...args: unknown[]) => unknown)(...args),
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: (...args: unknown[]) =>
    (mocks.runProcessMock as (...args: unknown[]) => unknown)(...args),
}));

import { execute } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-local-"));
  tempRoots.push(root);
  return root;
}

function makeSuccessfulRunResult() {
  return {
    pid: null,
    startedAt: new Date().toISOString(),
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({
      type: "turn_end",
      message: { role: "assistant", content: "done" },
      toolResults: [],
    }),
    stderr: "",
  };
}

async function makeCtx(runId: string, cwd: string): Promise<AdapterExecutionContext> {
  return {
    runId,
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Pi Agent",
      adapterType: "pi_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd },
    context: {},
    authToken: "run-token",
    onLog: async () => {},
  };
}

describe("pi sandbox cancellation", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });
  async function cancellableContext(stop: () => Promise<void>) {
    const ctx = await makeCtx("remote-cancellation", await makeTempRoot());
    const controller = new AbortController();
    const remoteExecute = vi.fn(async () => makeSuccessfulRunResult());
    ctx.signal = controller.signal;
    ctx.stopRemoteStartup = vi.fn(stop);
    ctx.onCancellationReady = vi.fn(async () => {});
    ctx.executionTarget = { kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd: "/remote/workspace",
      runner: { execute: remoteExecute } };
    remoteState.isRemote = true;
    runProcessMock.mockImplementation(async (_runId, target) => {
      expect(ctx.onCancellationReady).toHaveBeenCalledOnce();
      return target.runner.execute({ command: "pi" });
    });
    return { ctx, controller, remoteExecute };
  }

  it("settles remote cancellation only after the sandbox stop receipt, even if the command RPC hangs", async () => {
    let confirmStop!: () => void;
    const receipt = new Promise<void>(resolve => { confirmStop = resolve; });
    const f = await cancellableContext(() => receipt);
    f.remoteExecute.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const execution = execute(f.ctx).finally(() => { settled = true; });
    await vi.waitFor(() => expect(f.remoteExecute).toHaveBeenCalledOnce());
    f.controller.abort(new Error("Interrupted to send queued messages"));
    await vi.waitFor(() => expect(f.ctx.stopRemoteStartup).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    confirmStop();
    expect(await execution).toMatchObject({ errorCode: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged" } } });
    expect(runProcessMock).toHaveBeenCalledOnce();
  });

  it("keeps ownership of the command when remote termination cannot be verified", async () => {
    const f = await cancellableContext(async () => { throw new Error("stop unverified"); });
    let finishCommand!: (result: ReturnType<typeof makeSuccessfulRunResult>) => void;
    f.remoteExecute.mockImplementation(() => new Promise(resolve => { finishCommand = resolve; }));
    let settled = false;
    const execution = execute(f.ctx).catch(error => error).finally(() => { settled = true; });
    await vi.waitFor(() => expect(f.remoteExecute).toHaveBeenCalledOnce());
    f.controller.abort();
    await vi.waitFor(() => expect(f.ctx.stopRemoteStartup).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishCommand(makeSuccessfulRunResult());
    expect(await execution).toEqual(new Error("stop unverified"));
    expect(runProcessMock).toHaveBeenCalledOnce();
  });

  it("does not start Pi when cancellation was requested before registration", async () => {
    const f = await cancellableContext(async () => {});
    f.ctx.onCancellationReady = vi.fn(async () => { f.controller.abort(); });
    expect(await execute(f.ctx)).toMatchObject({ errorCode: "cancelled",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      resultJson: { executionCancellation: { state: "acknowledged" } } });
    expect(runProcessMock).not.toHaveBeenCalled();
    expect(prepareRuntimeMock).not.toHaveBeenCalled();
    expect(f.ctx.stopRemoteStartup).toHaveBeenCalledOnce();
  });

  it("does not acknowledge an early cancellation when its acquired sandbox cannot stop", async () => {
    const f = await cancellableContext(async () => { throw new Error("stop unverified"); });
    f.ctx.onCancellationReady = vi.fn(async () => { f.controller.abort(); });
    await expect(execute(f.ctx)).rejects.toThrow("stop unverified");
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it("does not stop the sandbox after a normal completed turn", async () => {
    const f = await cancellableContext(async () => {});
    expect(await execute(f.ctx)).toMatchObject({ exitCode: 0 });
    f.controller.abort();
    await Promise.resolve();
    expect(f.ctx.stopRemoteStartup).not.toHaveBeenCalled();
  });

  it("removes the cancellation listener after command failure", async () => {
    const f = await cancellableContext(async () => {});
    f.remoteExecute.mockRejectedValue(new Error("command failed"));
    await expect(execute(f.ctx)).rejects.toThrow("command failed");
    f.controller.abort();
    await Promise.resolve();
    expect(f.ctx.stopRemoteStartup).not.toHaveBeenCalled();
  });

  it("cancels a pending preparation RPC before starting Pi", async () => {
    const f = await cancellableContext(async () => {});
    f.remoteExecute.mockImplementation(() => new Promise(() => {}));
    ensureRuntimeInstalledMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as { target: NonNullable<AdapterExecutionContext["executionTarget"]> };
      expect(f.ctx.onCancellationReady).toHaveBeenCalledOnce();
      if (input.target.kind !== "remote" || input.target.transport !== "sandbox") {
        throw new Error("expected sandbox target");
      }
      await input.target.runner!.execute({ command: "prepare" });
    });
    const execution = execute(f.ctx);
    await vi.waitFor(() => expect(f.remoteExecute).toHaveBeenCalledOnce());
    f.controller.abort();
    expect(await execution).toMatchObject({
      errorCode: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    expect(runProcessMock).not.toHaveBeenCalled();
    expect(f.ctx.stopRemoteStartup).toHaveBeenCalledOnce();
  });

});
