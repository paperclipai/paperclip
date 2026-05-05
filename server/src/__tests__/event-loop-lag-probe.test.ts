import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "../middleware/logger.js";
import { startEventLoopLagProbe } from "../event-loop-lag-probe.js";

describe("event-loop lag probe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(logger.warn).mockReset();
    vi.mocked(logger.error).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("emits warn log when lag exceeds 500ms threshold", async () => {
    const T = 1_000_000;
    let time = T;
    const now = () => time;

    startEventLoopLagProbe({ now });
    // expected inside probe = T + 500

    // Simulate 700ms lag: set time to T+1200 before the timer fires
    time = T + 1200;
    await vi.advanceTimersByTimeAsync(500);

    expect(logger.warn).toHaveBeenCalledWith({ lagMs: 700 }, "event-loop lag detected");
  });

  it("does not emit warn when lag is at or below threshold", async () => {
    const T = 1_000_000;
    let time = T;
    const now = () => time;

    startEventLoopLagProbe({ now });

    // Exactly on time — no lag
    time = T + 500;
    await vi.advanceTimersByTimeAsync(500);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sends SIGTERM after critical lag sustained beyond 30 seconds", async () => {
    const T = 1_000_000;
    let time = T;
    const now = () => time;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

    startEventLoopLagProbe({ now });

    // Run 13 probe cycles each with 2100ms lag (> 2000ms critical threshold).
    // criticalSinceMs is set on the first critical probe.
    // Each cycle advances time by 2600ms (500ms expected interval + 2100ms lag).
    // After 12 additional cycles: 12 * 2600 = 31200ms > 30000ms → SIGTERM fires.
    for (let i = 0; i < 13; i++) {
      const nextExpected = time + 500;
      time = nextExpected + 2100;
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(logger.error).toHaveBeenCalledWith(
      { lagMs: 2100 },
      "event-loop lag critical — triggering graceful restart",
    );
  });

  it("resets critical state when lag recovers below critical threshold", async () => {
    const T = 1_000_000;
    let time = T;
    const now = () => time;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

    startEventLoopLagProbe({ now });

    // One critical probe cycle
    time = T + 2600;
    await vi.advanceTimersByTimeAsync(500);

    // Recover: next probe fires on time (no lag)
    time = T + 2600 + 500;
    await vi.advanceTimersByTimeAsync(500);

    // SIGTERM must NOT have been called
    expect(killSpy).not.toHaveBeenCalled();
  });
});
