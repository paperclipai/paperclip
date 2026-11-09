import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

describe("native harness backup expiration config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is enabled for issues closed seven days by default", () => {
    vi.stubEnv("PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_ENABLED", undefined);
    vi.stubEnv("PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_DRY_RUN", undefined);
    vi.stubEnv("PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_DAYS", undefined);
    expect(loadConfig()).toMatchObject({
      nativeHarnessBackupExpirationEnabled: true,
      nativeHarnessBackupExpirationDryRun: false,
      nativeHarnessBackupExpirationDays: 7,
    });
  });

  it("accepts explicit controls", () => {
    vi.stubEnv("PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_ENABLED", "false");
    vi.stubEnv("PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_DRY_RUN", "true");
    vi.stubEnv("PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_DAYS", "3");
    expect(loadConfig()).toMatchObject({
      nativeHarnessBackupExpirationEnabled: false,
      nativeHarnessBackupExpirationDryRun: true,
      nativeHarnessBackupExpirationDays: 3,
    });
  });

  it.each(["", "-1", "many"])("falls back to seven days for %j", (value) => {
    vi.stubEnv("PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_DAYS", value);
    expect(loadConfig()).toMatchObject({ nativeHarnessBackupExpirationDays: 7 });
  });

  it("never expires sooner than one day", () => {
    vi.stubEnv("PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_DAYS", "0");
    expect(loadConfig()).toMatchObject({ nativeHarnessBackupExpirationDays: 1 });
  });
});
