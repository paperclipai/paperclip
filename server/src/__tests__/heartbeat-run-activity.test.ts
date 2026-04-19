import { describe, expect, it } from "vitest";
import {
  LIVE_HEARTBEAT_RUN_FRESHNESS_WINDOW_MS,
  classifyHeartbeatRunFreshness,
  heartbeatRunActivityAgeMs,
  isHeartbeatRunActivityWarningRecoverable,
  isHeartbeatRunFresh,
} from "../services/heartbeat-run-activity.ts";

describe("heartbeat run activity helpers", () => {
  it("treats recent activity as fresh and older activity as quiet", () => {
    const now = new Date("2026-04-19T10:00:00.000Z").getTime();
    const freshRun = {
      lastActivityAt: new Date(now - 30_000),
      updatedAt: new Date(now - 30_000),
      startedAt: new Date(now - 60_000),
      createdAt: new Date(now - 90_000),
    };
    const quietRun = {
      lastActivityAt: new Date(now - LIVE_HEARTBEAT_RUN_FRESHNESS_WINDOW_MS - 1_000),
      updatedAt: new Date(now - LIVE_HEARTBEAT_RUN_FRESHNESS_WINDOW_MS - 1_000),
      startedAt: new Date(now - LIVE_HEARTBEAT_RUN_FRESHNESS_WINDOW_MS - 5_000),
      createdAt: new Date(now - LIVE_HEARTBEAT_RUN_FRESHNESS_WINDOW_MS - 10_000),
    };

    expect(isHeartbeatRunFresh(freshRun, now)).toBe(true);
    expect(classifyHeartbeatRunFreshness(freshRun, now)).toBe("fresh");
    expect(heartbeatRunActivityAgeMs(freshRun, now)).toBe(30_000);

    expect(isHeartbeatRunFresh(quietRun, now)).toBe(false);
    expect(classifyHeartbeatRunFreshness(quietRun, now)).toBe("quiet");
  });

  it("treats detached and suspect warnings as recoverable by fresh activity", () => {
    expect(isHeartbeatRunActivityWarningRecoverable("process_detached")).toBe(true);
    expect(isHeartbeatRunActivityWarningRecoverable("process_suspect")).toBe(true);
    expect(isHeartbeatRunActivityWarningRecoverable("process_lost")).toBe(false);
    expect(isHeartbeatRunActivityWarningRecoverable(null)).toBe(false);
  });
});
