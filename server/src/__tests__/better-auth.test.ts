import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";

const betterAuthMock = vi.fn((config: unknown) => ({ config }));
const drizzleAdapterMock = vi.fn(() => ({ adapter: "drizzle" }));

vi.mock("better-auth", () => ({
  betterAuth: betterAuthMock,
}));

vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: drizzleAdapterMock,
}));

function buildConfig(overrides?: Partial<Config>): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    host: "127.0.0.1",
    port: 3100,
    allowedHostnames: [],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    databaseMode: "embedded-postgres",
    databaseUrl: undefined,
    embeddedPostgresDataDir: "/tmp/paperclip-db",
    embeddedPostgresPort: 54329,
    databaseBackupEnabled: true,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: "/tmp/paperclip-backups",
    serveUi: true,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: "/tmp/paperclip.key",
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: "/tmp/paperclip-storage",
    storageS3Bucket: "paperclip",
    storageS3Region: "us-east-1",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    heartbeatSchedulerEnabled: true,
    heartbeatSchedulerIntervalMs: 30000,
    companyDeletionEnabled: false,
    ...overrides,
  };
}

describe("createBetterAuthInstance", () => {
  beforeEach(() => {
    betterAuthMock.mockClear();
    drizzleAdapterMock.mockClear();
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  });

  it("enables trusted proxy header inference in auto mode", async () => {
    const { createBetterAuthInstance } = await import("../auth/better-auth.js");

    createBetterAuthInstance({} as never, buildConfig(), ["http://127.0.0.1:3100"]);

    expect(betterAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedOrigins: ["http://127.0.0.1:3100"],
        advanced: {
          trustedProxyHeaders: true,
        },
      }),
    );
    expect(betterAuthMock.mock.calls[0]?.[0]).not.toHaveProperty("baseURL");
  });

  it("preserves explicit baseURL mode without proxy header inference", async () => {
    const { createBetterAuthInstance } = await import("../auth/better-auth.js");

    createBetterAuthInstance(
      {} as never,
      buildConfig({
        authBaseUrlMode: "explicit",
        authPublicBaseUrl: "https://paperclip.example.com",
      }),
      ["https://paperclip.example.com"],
    );

    expect(betterAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://paperclip.example.com",
        trustedOrigins: ["https://paperclip.example.com"],
      }),
    );
    expect(betterAuthMock.mock.calls[0]?.[0]).not.toHaveProperty("advanced");
  });
});
