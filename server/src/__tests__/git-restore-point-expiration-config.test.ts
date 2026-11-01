import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

describe("git restore point expiration config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is disabled by default with a three-day delay", () => {
    vi.stubEnv("PAPERCLIP_GIT_RESTORE_POINTS_ENABLED", undefined);
    vi.stubEnv("PAPERCLIP_GIT_RESTORE_POINT_TERMINAL_DELAY_DAYS", undefined);
    expect(loadConfig()).toMatchObject({ gitRestorePointsEnabled: false, gitRestorePointTerminalDelayDays: 3 });
  });

  it("accepts explicit settings", () => {
    vi.stubEnv("PAPERCLIP_GIT_RESTORE_POINTS_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_GIT_RESTORE_POINT_TERMINAL_DELAY_DAYS", "0");
    expect(loadConfig()).toMatchObject({ gitRestorePointsEnabled: true, gitRestorePointTerminalDelayDays: 0 });
  });

  it("expires idle open issues after seven days by default, and never when set to zero", () => {
    vi.stubEnv("PAPERCLIP_GIT_RESTORE_POINT_IDLE_DAYS", undefined);
    expect(loadConfig()).toMatchObject({ gitRestorePointIdleDays: 7 });
    vi.stubEnv("PAPERCLIP_GIT_RESTORE_POINT_IDLE_DAYS", "0");
    expect(loadConfig()).toMatchObject({ gitRestorePointIdleDays: 0 });
  });

  it.each(["", "-1", "many"])("falls back to three days for %j", (value) => {
    vi.stubEnv("PAPERCLIP_GIT_RESTORE_POINT_TERMINAL_DELAY_DAYS", value);
    expect(loadConfig()).toMatchObject({ gitRestorePointTerminalDelayDays: 3 });
  });
});
