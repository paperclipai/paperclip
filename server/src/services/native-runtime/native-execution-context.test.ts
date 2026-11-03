import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { NativeExecutionContext } from "./native-execution-context.js";

const execution = { binding: { companyId: "company", agentId: "agent", runId: "run" } } as NativeExecutionInput;
const target = { pluginId: "plugin", leaseId: "lease", taskId: "task", environmentId: "environment" };

afterEach(() => vi.useRealTimers());

describe("Core execution startup context", () => {
  it("retains the selected input and resolves one exact transport target per context", async () => {
    const context = new NativeExecutionContext(execution, 1_000);
    const resolve = vi.fn(async () => ({ instanceSecrets: { binding: "synthetic" }, configuration: {} }));
    try {
      expect(context.execution).toBe(execution);
      context.assertScope(execution.binding);
      expect(() => context.assertScope({ ...execution.binding, runId: "other" })).toThrow("scope_mismatch");
      const first = await context.projection(target, resolve);
      expect(await context.projection(target, resolve)).toEqual(first);
      expect(resolve).toHaveBeenCalledOnce();
      await expect(context.projection({ ...target, taskId: "other" }, resolve)).rejects.toThrow("target_changed");
      context.finish();
      await expect(context.projection(target, resolve)).rejects.toThrow("startup_completed");
    } finally { context.finish(); }
  });

  it("reuses an identical transport target regardless of property insertion order", async () => {
    const context = new NativeExecutionContext(execution, 1_000);
    const resolve = vi.fn(async () => ({ instanceSecrets: {}, configuration: {} }));
    try {
      const first = await context.projection(target, resolve);
      const reordered = { environmentId: target.environmentId, taskId: target.taskId,
        leaseId: target.leaseId, pluginId: target.pluginId };
      expect(await context.projection(reordered, resolve)).toEqual(first);
      expect(resolve).toHaveBeenCalledOnce();
    } finally { context.finish(); }
  });

  it("finishes a pending lookup without aborting a successful backend or completing worker responsibility", async () => {
    vi.useFakeTimers();
    const context = new NativeExecutionContext(execution, 1_000), settled = context.trackWorker();
    const remove = vi.spyOn(context.signal, "removeEventListener");
    let outcome = "pending";
    const waiting = context.projection(target, () => new Promise<never>(() => {}))
      .then(() => { outcome = "resolved"; }, error => { outcome = error.message; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      context.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("native_execution_startup_completed");
      expect(context.signal.aborted).toBe(false);
      expect(context.pending).toBe(true);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      settled();
      expect(await context.drain()).toBe(true);
    } finally { settled(); context.abort(new Error("test cleanup")); context.finish(); await waiting; }
  });

  it("keeps pending worker responsibility after cancellation until actual settlement", async () => {
    vi.useFakeTimers();
    const context = new NativeExecutionContext(execution, 1_000), settled = context.trackWorker();
    let drained = false;
    const drain = context.drain().then(result => { drained = true; return result; });
    try {
      context.abort(new Error("Stop requested"));
      expect(() => context.assertOpen()).toThrow("Stop requested");
      await vi.advanceTimersByTimeAsync(100);
      expect(drained).toBe(false);
      expect(context.pending).toBe(true);
      settled();
      expect(await drain).toBe(true);
      expect(context.pending).toBe(false);
    } finally { settled(); context.finish(); }
  });

  it("reports an unsettled worker at the deadline without treating expiry as completion", async () => {
    vi.useFakeTimers();
    const context = new NativeExecutionContext(execution, 1_000), settled = context.trackWorker();
    const drain = context.drain();
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await drain).toBe(false);
      expect(context.pending).toBe(true);
      expect(() => context.assertOpen()).toThrow("startup_expired");
      settled();
      expect(await context.drain()).toBe(true);
    } finally { settled(); context.finish(); }
  });

  it("rejects a delayed transport lookup before it can send a worker request", async () => {
    vi.useFakeTimers();
    const context = new NativeExecutionContext(execution, 100);
    let resolve!: (value: { instanceSecrets: {}; configuration: {} }) => void;
    const transport = new Promise<{ instanceSecrets: {}; configuration: {} }>(complete => { resolve = complete; });
    const send = vi.fn();
    const operation = context.projection(target, () => transport).then(send);
    const rejected = expect(operation).rejects.toThrow("startup_expired");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    resolve({ instanceSecrets: {}, configuration: {} });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(context.pending).toBe(false);
    context.finish();
  });
});
