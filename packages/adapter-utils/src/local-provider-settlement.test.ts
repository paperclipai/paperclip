import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types.js";
import { withLocalProviderSettlement } from "./local-provider-settlement.js";
import { createProviderStoppedBoundary } from "./provider-stopped-boundary.js";
import { runAdapterExecutionTargetProcess } from "./execution-target.js";

const failed: AdapterExecutionResult = {
  exitCode: 1, signal: null, timedOut: false, errorCode: "provider_quota",
  summary: "Completed the first edit.", resultJson: { pendingToolOperations: ["unconfirmed"] },
};
const context = (extra: Partial<AdapterExecutionContext> = {}) => ({
  runId: "settlement-test", onLog: async () => {}, ...extra,
}) as AdapterExecutionContext;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("local provider settlement for fresh-context continuation", () => {
  it("waits for a real failed provider and adapter cleanup, preserving its completed edit", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "paperclip-settlement-"));
    const marker = path.join(cwd, "completed.txt");
    const cleanupStarted = deferred();
    const finishCleanup = deferred();
    let returned = false;
    const collect = vi.fn(async () => {});
    try {
      const execution = withLocalProviderSettlement(context({ onProviderStopped: collect }), async ctx => {
        const stop = createProviderStoppedBoundary(ctx.onProviderStopped);
        try {
          const processResult = await runAdapterExecutionTargetProcess(
            ctx.runId, null, process.execPath,
            ["-e", "require('node:fs').writeFileSync(process.argv[1], 'completed edit'); process.stderr.write('quota exceeded'); process.exitCode = 1", marker],
            { cwd, env: {}, timeoutSec: 10, graceSec: 1, onLog: ctx.onLog, onProcessStopped: stop.beginInvocation() },
          );
          expect(processResult.exitCode).toBe(1);
          return failed;
        } finally {
          await stop.collectBeforeRestore();
          cleanupStarted.resolve();
          await finishCleanup.promise;
        }
      }).then(result => { returned = true; return result; });
      await cleanupStarted.promise;
      expect(collect).toHaveBeenCalledOnce();
      expect(returned).toBe(false);
      expect(await readFile(marker, "utf8")).toBe("completed edit");
      finishCleanup.resolve();
      const result = await execution;
      expect(result).toMatchObject({ ...failed, executionSettlement: {
        providerStopped: true, workspaceSettled: true, actionOutcomes: "unknown",
      } });
      expect(result.executionRecovery).toBeUndefined();
      expect(await readFile(marker, "utf8")).toBe("completed edit");
    } finally {
      finishCleanup.resolve();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("withholds evidence when a later invocation has no stop receipt", async () => {
    const result = await withLocalProviderSettlement(context(), async ctx => {
      const stop = createProviderStoppedBoundary(ctx.onProviderStopped);
      const earlier = stop.beginInvocation(); earlier();
      stop.beginInvocation(); earlier();
      await stop.collectBeforeRestore();
      return failed;
    });
    expect(result.executionSettlement).toBeUndefined();
  });

  it("does not turn bootstrap failure into settlement", async () => {
    const bootstrap = { ...failed, executionRecovery: { kind: "bootstrap" as const, providerWorkStarted: false as const } };
    expect(await withLocalProviderSettlement(context(), async () => bootstrap)).toBe(bootstrap);
  });

  it.each(["cleanup failed", "instruction collection failed"])("preserves a finalization rejection: %s", async message => {
    const ctx = context(message.startsWith("instruction") ? { onProviderStopped: async () => { throw new Error(message); } } : {});
    await expect(withLocalProviderSettlement(ctx, async inner => {
      await inner.onProviderStopped?.();
      throw new Error(message);
    })).rejects.toThrow(message);
  });

  it("withholds settlement on a returned restore failure", async () => {
    const result = await withLocalProviderSettlement(context(), async ctx => {
      await ctx.onProviderStopped?.();
      return { ...failed, errorCode: "workspace_restore_failed" };
    });
    expect(result.executionSettlement).toBeUndefined();
  });

  it.each([
    { executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/work" } },
    { executionTransport: { remoteExecution: { host: "fixture", port: 22, username: "agent", remoteCwd: "/work" } } },
  ])("does not infer remote copy-back settlement from provider stop", async remote => {
    const result = await withLocalProviderSettlement(context(remote as Partial<AdapterExecutionContext>), async ctx => {
      await ctx.onProviderStopped?.();
      return failed;
    });
    expect(result.executionSettlement).toBeUndefined();
  });
});
