import { describe, expect, it, vi } from "vitest";
import { startListenerWatchdog } from "../services/listener-watchdog.js";

describe("listener watchdog", () => {
  it("does not restart while probes are healthy", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const watchdog = startListenerWatchdog({
      probe: vi.fn(async () => ({ ok: true })),
      intervalMs: 10,
      onFailure,
    });
    await vi.advanceTimersByTimeAsync(50);
    watchdog.stop();
    expect(onFailure).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("reports one restart after a live process loses its listener", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const watchdog = startListenerWatchdog({
      probe: vi.fn(async () => ({ ok: false, error: "fetch failed" })),
      intervalMs: 10,
      failureThreshold: 3,
      onFailure,
    });
    await vi.advanceTimersByTimeAsync(50);
    watchdog.stop();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({ failures: 3, error: "fetch failed" });
    vi.useRealTimers();
  });
});
