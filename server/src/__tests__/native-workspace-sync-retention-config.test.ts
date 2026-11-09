import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

describe("native workspace sync retention config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is enabled with a seven day window by default", () => {
    vi.stubEnv("PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_ENABLED", undefined);
    vi.stubEnv("PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_DRY_RUN", undefined);
    vi.stubEnv("PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_DAYS", undefined);
    expect(loadConfig()).toMatchObject({
      nativeWorkspaceSyncRetentionEnabled: true,
      nativeWorkspaceSyncRetentionDryRun: false,
      nativeWorkspaceSyncRetentionDays: 7,
    });
  });

  it("accepts explicit controls", () => {
    vi.stubEnv("PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_ENABLED", "false");
    vi.stubEnv("PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_DRY_RUN", "true");
    vi.stubEnv("PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_DAYS", "3");
    expect(loadConfig()).toMatchObject({
      nativeWorkspaceSyncRetentionEnabled: false,
      nativeWorkspaceSyncRetentionDryRun: true,
      nativeWorkspaceSyncRetentionDays: 3,
    });
  });

  it.each(["", "-1", "many"])("falls back to seven days for %j", (value) => {
    vi.stubEnv("PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_DAYS", value);
    expect(loadConfig()).toMatchObject({ nativeWorkspaceSyncRetentionDays: 7 });
  });

  it("never keeps folders for less than one day", () => {
    vi.stubEnv("PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_DAYS", "0");
    expect(loadConfig()).toMatchObject({ nativeWorkspaceSyncRetentionDays: 1 });
  });
});
