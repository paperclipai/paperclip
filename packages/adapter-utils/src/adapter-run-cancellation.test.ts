import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginAdapterRunCancellation, bindAdapterRunStop, cancelAdapterRunExecution,
  finishAdapterRunCancellation, hasAdapterRunCancellation, throwIfAdapterRunCancelled,
} from "./adapter-run-cancellation.js";

afterEach(() => finishAdapterRunCancellation("run"));
describe("sandbox adapter cancellation ownership", () => {
  it("waits for both remote stop and final save before completing cancellation", async () => {
    beginAdapterRunCancellation("run");
    let finishStop!: () => void;
    const stop = vi.fn(() => new Promise<void>((resolve) => { finishStop = resolve; }));
    const cleanup = await bindAdapterRunStop("run", stop);
    let completed = false;
    const cancellation = cancelAdapterRunExecution("run").then(() => { completed = true; });
    expect(() => throwIfAdapterRunCancelled("run")).toThrow("cancelled");
    finishStop();
    await cleanup();
    expect(completed).toBe(false);
    finishAdapterRunCancellation("run");
    await cancellation;
    expect(stop).toHaveBeenCalledOnce();
    expect(hasAdapterRunCancellation("run")).toBe(false);
  });

  it("stops a resource acquired after cancellation instead of exposing it", async () => {
    beginAdapterRunCancellation("run");
    const cancellation = cancelAdapterRunExecution("run");
    const stop = vi.fn(async () => {});
    await expect(bindAdapterRunStop("run", stop)).rejects.toThrow("cancelled");
    expect(stop).toHaveBeenCalledOnce();
    finishAdapterRunCancellation("run");
    await cancellation;
  });

  it("does not acknowledge a failed stop as completed or affect another run", async () => {
    beginAdapterRunCancellation("run");
    const failure = new Error("provider unavailable");
    await bindAdapterRunStop("run", async () => { throw failure; });
    await expect(cancelAdapterRunExecution("run")).rejects.toBe(failure);
    expect(hasAdapterRunCancellation("run")).toBe(true);
    await cancelAdapterRunExecution("unrelated");
    expect(() => throwIfAdapterRunCancelled("unrelated")).not.toThrow();
  });
});
