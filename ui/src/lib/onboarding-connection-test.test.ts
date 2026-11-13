import { afterEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_CONNECTION_TEST_TIMEOUT_MS, runOnboardingConnectionTest } from "./onboarding-connection-test";

describe("onboarding connection test deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("bounds an unresponsive check and aborts its requests", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const result = runOnboardingConnectionTest(async current => {
      signal = current;
      return new Promise(() => {});
    });
    const failed = expect(result).rejects.toThrow("The connection test took too long. Try connecting again.");
    await vi.advanceTimersByTimeAsync(ONBOARDING_CONNECTION_TEST_TIMEOUT_MS);
    await failed;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after success and preserves genuine failures", async () => {
    vi.useFakeTimers();
    await expect(runOnboardingConnectionTest(async () => "ready")).resolves.toBe("ready");
    const failure = new Error("Paperclip is temporarily unavailable.");
    await expect(runOnboardingConnectionTest(async () => { throw failure; })).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});
