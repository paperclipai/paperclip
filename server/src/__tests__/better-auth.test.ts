import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { deriveEffectiveAuthBaseUrl } from "../auth/better-auth.js";

function createConfig(overrides: Partial<Config> = {}): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    host: "127.0.0.1",
    port: 3100,
    allowedHostnames: [],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    databaseMode: "postgres",
    databaseUrl: "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip",
    embeddedPostgresDataDir: "/tmp/paperclip-test-db",
    embeddedPostgresPort: 54329,
    databaseBackupEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: "/tmp/paperclip-test-backups",
    serveUi: false,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: "/tmp/paperclip-master.key",
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: "/tmp/paperclip-storage",
    storageS3Bucket: "paperclip-test",
    storageS3Region: "us-east-1",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    feedbackExportBackendUrl: undefined,
    feedbackExportBackendToken: undefined,
    heartbeatSchedulerEnabled: false,
    heartbeatSchedulerIntervalMs: 30000,
    closedIssueArchiveEnabled: false,
    closedIssueArchiveIntervalMs: 3600000,
    closedIssueArchiveAgeDays: 14,
    companyDeletionEnabled: false,
    telemetryEnabled: true,
    ...overrides,
  };
}

describe("deriveEffectiveAuthBaseUrl", () => {
  it("derives a localhost base URL for authenticated private loopback dev", () => {
    expect(deriveEffectiveAuthBaseUrl(createConfig(), 3210)).toBe("http://localhost:3210");
  });

  it("preserves explicit public auth base URLs", () => {
    expect(
      deriveEffectiveAuthBaseUrl(
        createConfig({
          authBaseUrlMode: "explicit",
          authPublicBaseUrl: "https://paperclip.example.com",
        }),
        3210,
      ),
    ).toBe("https://paperclip.example.com");
  });

  it("does not invent a base URL for non-loopback private hosts", () => {
    expect(
      deriveEffectiveAuthBaseUrl(
        createConfig({
          host: "paperclip.internal",
        }),
        3210,
      ),
    ).toBeUndefined();
  });
});
