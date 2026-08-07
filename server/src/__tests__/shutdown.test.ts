import { describe, expect, it } from "vitest";
import { drainRunExecutionFinalizersForShutdown } from "../shutdown.ts";

describe("drainRunExecutionFinalizersForShutdown", () => {
  it("reports attempted: false when no drain function is wired", async () => {
    const result = await drainRunExecutionFinalizersForShutdown({
      drainActiveRunExecutions: null,
      timeoutMs: 1_000,
    });
    expect(result).toEqual({ attempted: false, timedOut: false, error: null });
  });

  it("resolves without timeout when the finalizer drain completes", async () => {
    let drained = false;
    const result = await drainRunExecutionFinalizersForShutdown({
      drainActiveRunExecutions: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        drained = true;
      },
      timeoutMs: 5_000,
    });
    expect(drained).toBe(true);
    expect(result).toEqual({ attempted: true, timedOut: false, error: null });
  });

  it("times out instead of hanging on a finalizer drain that never settles", async () => {
    const result = await drainRunExecutionFinalizersForShutdown({
      drainActiveRunExecutions: () => new Promise<void>(() => {}),
      timeoutMs: 25,
    });
    expect(result).toEqual({ attempted: true, timedOut: true, error: null });
  });

  it("captures a rejected finalizer drain instead of throwing", async () => {
    const failure = new Error("drain exploded");
    const result = await drainRunExecutionFinalizersForShutdown({
      drainActiveRunExecutions: async () => {
        throw failure;
      },
      timeoutMs: 1_000,
    });
    expect(result).toEqual({ attempted: true, timedOut: false, error: failure });
  });
});
