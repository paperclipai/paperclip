import { describe, expect, it, vi } from "vitest";
import type {
  BeforeAdapterExecuteParams,
  BeforeAdapterExecuteResult,
} from "@paperclipai/plugin-sdk";
import {
  runBeforeAdapterExecuteBroadcast,
  type BroadcastableWorker,
} from "../services/plugin-worker-manager.js";

function mkParams(overrides: Partial<BeforeAdapterExecuteParams> = {}): BeforeAdapterExecuteParams {
  return {
    agentId: "agent-1",
    companyId: "co-1",
    runId: "run-1",
    adapterType: "claude_local",
    runtimeConfig: {},
    adapterEnv: {},
    context: {},
    ...overrides,
  };
}

function mkWorker(
  pluginId: string,
  supports: boolean,
  returns: BeforeAdapterExecuteResult | Error | undefined,
  status: string = "running",
): BroadcastableWorker {
  const call = vi.fn().mockImplementation(async () => {
    if (returns instanceof Error) throw returns;
    return returns ?? {};
  });
  return {
    pluginId,
    status,
    supportedMethods: supports ? ["beforeAdapterExecute"] : [],
    call: call as BroadcastableWorker["call"],
  };
}

describe("runBeforeAdapterExecuteBroadcast", () => {
  it("returns empty result when no workers are registered", async () => {
    const result = await runBeforeAdapterExecuteBroadcast(mkParams(), []);
    expect(result).toEqual({});
  });

  it("returns empty result when no worker supports the hook", async () => {
    const workers = [
      mkWorker("a", false, { env: { A: "1" } }),
      mkWorker("b", false, undefined),
    ];
    const result = await runBeforeAdapterExecuteBroadcast(mkParams(), workers);
    expect(result).toEqual({});
    expect((workers[0].call as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("skips workers whose status is not running", async () => {
    const workers = [
      mkWorker("stopped", true, { env: { A: "1" } }, "stopped"),
      mkWorker("crashing", true, { env: { B: "2" } }, "crashing"),
      mkWorker("running", true, { env: { C: "3" } }, "running"),
    ];
    const result = await runBeforeAdapterExecuteBroadcast(mkParams(), workers);
    expect(result.env).toEqual({ C: "3" });
  });

  it("merges env from a single plugin", async () => {
    const workers = [mkWorker("solo", true, { env: { FOO: "bar", BAZ: "qux" } })];
    const result = await runBeforeAdapterExecuteBroadcast(mkParams(), workers);
    expect(result.env).toEqual({ FOO: "bar", BAZ: "qux" });
    expect(result.block).toBeUndefined();
  });

  it("merges env across multiple plugins, later overrides earlier per key", async () => {
    const workers = [
      mkWorker("first", true, { env: { SHARED: "a", FIRST_ONLY: "1" } }),
      mkWorker("second", true, { env: { SHARED: "b", SECOND_ONLY: "2" } }),
    ];
    const result = await runBeforeAdapterExecuteBroadcast(mkParams(), workers);
    expect(result.env).toEqual({ SHARED: "b", FIRST_ONLY: "1", SECOND_ONLY: "2" });
  });

  it("merges runtimeConfig fields shallow, later overrides earlier", async () => {
    const workers = [
      mkWorker("a", true, { runtimeConfig: { timeout: 100, model: "x" } }),
      mkWorker("b", true, { runtimeConfig: { timeout: 200, extra: "y" } }),
    ];
    const result = await runBeforeAdapterExecuteBroadcast(mkParams(), workers);
    expect(result.runtimeConfig).toEqual({ timeout: 200, model: "x", extra: "y" });
  });

  it("first plugin returning block wins; subsequent plugins are not called", async () => {
    const secondCall = vi.fn();
    const workers: BroadcastableWorker[] = [
      mkWorker("a", true, { env: { A: "1" } }),
      mkWorker("b", true, { block: { reason: "policy_violation", message: "nope" } }),
      {
        pluginId: "c",
        status: "running",
        supportedMethods: ["beforeAdapterExecute"],
        call: secondCall as unknown as BroadcastableWorker["call"],
      },
    ];
    const result = await runBeforeAdapterExecuteBroadcast(mkParams(), workers);
    expect(result.block).toEqual({ reason: "policy_violation", message: "nope" });
    expect(secondCall).not.toHaveBeenCalled();
    // Env from pre-block plugins is NOT merged into the final result —
    // a block supersedes everything, the caller should treat the run as aborted.
    expect(result.env).toBeUndefined();
  });

  it("swallows a plugin throw, invokes onError, and proceeds to next plugin", async () => {
    const onError = vi.fn();
    const workers = [
      mkWorker("bad", true, new Error("worker crashed")),
      mkWorker("good", true, { env: { FROM_GOOD: "yes" } }),
    ];
    const result = await runBeforeAdapterExecuteBroadcast(mkParams(), workers, { onError });
    expect(result.env).toEqual({ FROM_GOOD: "yes" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe("bad");
    expect((onError.mock.calls[0][1] as Error).message).toBe("worker crashed");
  });

  it("does not error when onError is omitted (discards the error silently)", async () => {
    const workers = [
      mkWorker("bad", true, new Error("boom")),
      mkWorker("good", true, { env: { OK: "1" } }),
    ];
    const result = await runBeforeAdapterExecuteBroadcast(mkParams(), workers);
    expect(result.env).toEqual({ OK: "1" });
  });

  it("passes the timeoutMs through to each worker.call", async () => {
    const workers = [mkWorker("a", true, { env: {} }), mkWorker("b", true, { env: {} })];
    await runBeforeAdapterExecuteBroadcast(mkParams(), workers, { timeoutMs: 5000 });
    for (const w of workers) {
      expect(w.call).toHaveBeenCalledWith("beforeAdapterExecute", expect.any(Object), 5000);
    }
  });

  it("ignores non-string env values from a misbehaving plugin", async () => {
    const workers = [
      mkWorker("misbehaving", true, { env: { GOOD: "1", BAD: 42 as unknown as string, NULL: null as unknown as string } }),
    ];
    const result = await runBeforeAdapterExecuteBroadcast(mkParams(), workers);
    expect(result.env).toEqual({ GOOD: "1" });
  });

  it("omits empty env/runtimeConfig from the merged result", async () => {
    const workers = [mkWorker("noop", true, {})];
    const result = await runBeforeAdapterExecuteBroadcast(mkParams(), workers);
    expect(result).toEqual({});
  });
});
