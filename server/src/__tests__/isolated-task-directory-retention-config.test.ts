import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

describe("isolated task directory retention config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is disabled by default, dry run when enabled, with a seven-day orphan grace", () => {
    vi.stubEnv("PAPERCLIP_TASK_DIRECTORY_RETENTION_ENABLED", undefined);
    vi.stubEnv("PAPERCLIP_TASK_DIRECTORY_RETENTION_DRY_RUN", undefined);
    vi.stubEnv("PAPERCLIP_TASK_DIRECTORY_ORPHAN_GRACE_DAYS", undefined);
    expect(loadConfig()).toMatchObject({ taskDirectoryRetentionEnabled: false, taskDirectoryRetentionDryRun: true,
      taskDirectoryOrphanGraceDays: 7 });
  });

  it("accepts explicit settings", () => {
    vi.stubEnv("PAPERCLIP_TASK_DIRECTORY_RETENTION_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_TASK_DIRECTORY_RETENTION_DRY_RUN", "false");
    vi.stubEnv("PAPERCLIP_TASK_DIRECTORY_ORPHAN_GRACE_DAYS", "14");
    expect(loadConfig()).toMatchObject({ taskDirectoryRetentionEnabled: true, taskDirectoryRetentionDryRun: false,
      taskDirectoryOrphanGraceDays: 14 });
  });

  it.each([["0", 1], ["", 7], ["-1", 7], ["many", 7]])("clamps the orphan grace for %j", (value, expected) => {
    vi.stubEnv("PAPERCLIP_TASK_DIRECTORY_ORPHAN_GRACE_DAYS", value);
    expect(loadConfig()).toMatchObject({ taskDirectoryOrphanGraceDays: expected });
  });
});
