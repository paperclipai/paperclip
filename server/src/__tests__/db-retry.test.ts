import { describe, expect, it, vi } from "vitest";
import { isTransientDbError, withTransientRetry } from "../lib/db-retry.js";

describe("isTransientDbError", () => {
  it("flags serialization failures, deadlocks, and connection drops", () => {
    expect(isTransientDbError({ code: "40001" })).toBe(true);
    expect(isTransientDbError({ code: "40P01" })).toBe(true);
    expect(isTransientDbError({ code: "08006" })).toBe(true);
    expect(isTransientDbError({ code: "ECONNRESET" })).toBe(true);
  });

  it("does not flag unique violations or non-pg errors", () => {
    expect(isTransientDbError({ code: "23505" })).toBe(false);
    expect(isTransientDbError(new Error("boom"))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });
});

describe("withTransientRetry", () => {
  it("returns on first success without retrying", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(withTransientRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ code: "40001" })
      .mockResolvedValueOnce("recovered");
    await expect(withTransientRetry(fn, { baseDelayMs: 0 })).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("re-throws a non-transient error immediately", async () => {
    const fn = vi.fn().mockRejectedValue({ code: "23505" });
    await expect(withTransientRetry(fn, { baseDelayMs: 0 })).rejects.toMatchObject({ code: "23505" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts on persistent transient failure", async () => {
    const fn = vi.fn().mockRejectedValue({ code: "40P01" });
    await expect(
      withTransientRetry(fn, { maxAttempts: 3, baseDelayMs: 0 }),
    ).rejects.toMatchObject({ code: "40P01" });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
