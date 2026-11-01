import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

describe("git restore point retention config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps restore points 90 days after their issue tree closes by default", () => {
    vi.stubEnv("PAPERCLIP_GIT_RESTORE_POINT_RETENTION_DAYS", undefined);
    expect(loadConfig()).toMatchObject({ gitRestorePointRetentionDays: 90 });
  });

  it("accepts an explicit retention and never goes below one day", () => {
    vi.stubEnv("PAPERCLIP_GIT_RESTORE_POINT_RETENTION_DAYS", "30");
    expect(loadConfig()).toMatchObject({ gitRestorePointRetentionDays: 30 });
    vi.stubEnv("PAPERCLIP_GIT_RESTORE_POINT_RETENTION_DAYS", "0");
    expect(loadConfig()).toMatchObject({ gitRestorePointRetentionDays: 1 });
  });

  it.each(["", "-1", "many"])("falls back to 90 days for %j", (value) => {
    vi.stubEnv("PAPERCLIP_GIT_RESTORE_POINT_RETENTION_DAYS", value);
    expect(loadConfig()).toMatchObject({ gitRestorePointRetentionDays: 90 });
  });
});
