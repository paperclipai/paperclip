import { describe, expect, it } from "vitest";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "public",
    host: "127.0.0.1",
    port: 3100,
    allowedHostnames: [],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    databaseMode: "embedded-postgres",
    databaseUrl: undefined,
    embeddedPostgresDataDir: "/tmp/pg",
    embeddedPostgresPort: 54329,
    databaseBackupEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: "/tmp/backup",
    serveUi: false,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: "/tmp/key",
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: "/tmp/storage",
    storageS3Bucket: "paperclip",
    storageS3Region: "us-east-1",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    heartbeatSchedulerEnabled: false,
    heartbeatSchedulerIntervalMs: 30000,
    companyDeletionEnabled: false,
    ...overrides,
  } as Config;
}

const fakeDb = {} as any;

describe("auth-secret-guard", () => {
  it("throws in authenticated mode when only the dev secret is available", () => {
    const original = {
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      PAPERCLIP_AGENT_JWT_SECRET: process.env.PAPERCLIP_AGENT_JWT_SECRET,
    };
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;

    try {
      expect(() =>
        createBetterAuthInstance(fakeDb, fakeConfig({ deploymentMode: "authenticated" }), []),
      ).toThrow("BETTER_AUTH_SECRET");
    } finally {
      if (original.BETTER_AUTH_SECRET !== undefined) process.env.BETTER_AUTH_SECRET = original.BETTER_AUTH_SECRET;
      if (original.PAPERCLIP_AGENT_JWT_SECRET !== undefined) process.env.PAPERCLIP_AGENT_JWT_SECRET = original.PAPERCLIP_AGENT_JWT_SECRET;
    }
  });

  it("does not throw in authenticated mode when a real secret is set", () => {
    const original = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "a-very-strong-random-secret-value";

    try {
      expect(() =>
        createBetterAuthInstance(fakeDb, fakeConfig({ deploymentMode: "authenticated" }), []),
      ).not.toThrow();
    } finally {
      if (original !== undefined) {
        process.env.BETTER_AUTH_SECRET = original;
      } else {
        delete process.env.BETTER_AUTH_SECRET;
      }
    }
  });

  it("does not throw in local_trusted mode even with the dev secret", () => {
    const original = {
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      PAPERCLIP_AGENT_JWT_SECRET: process.env.PAPERCLIP_AGENT_JWT_SECRET,
    };
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;

    try {
      expect(() =>
        createBetterAuthInstance(fakeDb, fakeConfig({ deploymentMode: "local_trusted" }), []),
      ).not.toThrow();
    } finally {
      if (original.BETTER_AUTH_SECRET !== undefined) process.env.BETTER_AUTH_SECRET = original.BETTER_AUTH_SECRET;
      if (original.PAPERCLIP_AGENT_JWT_SECRET !== undefined) process.env.PAPERCLIP_AGENT_JWT_SECRET = original.PAPERCLIP_AGENT_JWT_SECRET;
    }
  });
});
