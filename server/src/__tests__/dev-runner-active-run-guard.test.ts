import { describe, expect, it, vi } from "vitest";
import { waitForActiveRunsToClear } from "../../../scripts/dev-runner-active-run-guard.ts";

describe("waitForActiveRunsToClear", () => {
  it("returns immediately when no active runs", async () => {
    const result = await waitForActiveRunsToClear({
      fetchActiveRunCount: async () => 0,
      log: vi.fn(),
    });

    expect(result).toEqual({ waited: false, timedOut: false, finalRunCount: 0 });
  });

  it("waits for active runs to complete", async () => {
    let callCount = 0;
    const log = vi.fn();

    const result = await waitForActiveRunsToClear({
      fetchActiveRunCount: async () => {
        callCount++;
        return callCount <= 2 ? 3 : 0;
      },
      pollIntervalMs: 10,
      log,
    });

    expect(result).toEqual({ waited: true, timedOut: false, finalRunCount: 0 });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("waiting for 3 active runs"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("proceeding with restart"),
    );
  });

  it("times out after max wait and proceeds", async () => {
    const log = vi.fn();

    const result = await waitForActiveRunsToClear({
      fetchActiveRunCount: async () => 2,
      timeoutMs: 50,
      pollIntervalMs: 10,
      log,
    });

    expect(result.waited).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.finalRunCount).toBe(2);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Timeout reached"),
    );
  });

  it("handles fetch errors gracefully on initial check", async () => {
    const result = await waitForActiveRunsToClear({
      fetchActiveRunCount: async () => { throw new Error("connection refused"); },
      log: vi.fn(),
    });

    expect(result).toEqual({ waited: false, timedOut: false, finalRunCount: 0 });
  });

  it("treats fetch errors during polling as zero runs", async () => {
    let callCount = 0;
    const log = vi.fn();

    const result = await waitForActiveRunsToClear({
      fetchActiveRunCount: async () => {
        callCount++;
        if (callCount === 1) return 1;
        throw new Error("server restarted");
      },
      pollIntervalMs: 10,
      log,
    });

    expect(result).toEqual({ waited: true, timedOut: false, finalRunCount: 0 });
  });

  it("uses singular form for one active run", async () => {
    let callCount = 0;
    const log = vi.fn();

    const result = await waitForActiveRunsToClear({
      fetchActiveRunCount: async () => {
        callCount++;
        return callCount <= 1 ? 1 : 0;
      },
      pollIntervalMs: 10,
      log,
    });

    expect(result.waited).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("1 active run to complete"),
    );
  });
});
