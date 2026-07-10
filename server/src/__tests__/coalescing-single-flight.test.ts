import { describe, expect, it, vi } from "vitest";
import {
  createCoalescingSingleFlight,
  createStartupThenPeriodicSingleFlight,
} from "../lib/coalescing-single-flight.js";

describe("coalescing single flight", () => {
  it("serializes overlapping triggers and coalesces them into one follow-up pass", async () => {
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (run.mock.calls.length === 1) {
          markFirstEntered();
          await firstReleased;
        }
      } finally {
        active -= 1;
      }
    });
    const singleFlight = createCoalescingSingleFlight(run);

    const first = singleFlight.trigger();
    await firstEntered;
    const second = singleFlight.trigger();
    const third = singleFlight.trigger();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(run).toHaveBeenCalledTimes(1);
    expect(singleFlight.isRunning()).toBe(true);

    releaseFirst();
    await first;

    expect(run).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(singleFlight.isRunning()).toBe(false);
  });

  it("clears the flight after failure so a later trigger can retry", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("first pass failed"))
      .mockResolvedValueOnce(undefined);
    const singleFlight = createCoalescingSingleFlight(run);

    await expect(singleFlight.trigger()).rejects.toThrow("first pass failed");
    await expect(singleFlight.trigger()).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledTimes(2);
    expect(singleFlight.isRunning()).toBe(false);
  });

  it("keeps startup semantics pending until a full startup pass succeeds", async () => {
    const phases: string[] = [];
    const errors: Array<{ error: unknown; phase: string }> = [];
    const run = vi.fn(async (phase: "startup" | "periodic") => {
      phases.push(phase);
      if (run.mock.calls.length === 1) throw new Error("partial startup failure");
    });
    const singleFlight = createStartupThenPeriodicSingleFlight(run, (error, phase) => {
      errors.push({ error, phase });
    });

    await singleFlight.trigger();
    await singleFlight.trigger();
    await singleFlight.trigger();

    expect(phases).toEqual(["startup", "startup", "periodic"]);
    expect(errors).toEqual([
      { error: expect.objectContaining({ message: "partial startup failure" }), phase: "startup" },
    ]);
  });
});
