import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildResetPasswordLogLines,
  deriveAuthTrustedOrigins,
} from "../auth/better-auth.js";
import type { Config } from "../config.js";

// Minimal config stub with only the fields deriveAuthTrustedOrigins needs.
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    allowedHostnames: [],
    host: "127.0.0.1",
    port: 3100,
    databaseMode: "embedded-postgres",
    databaseUrl: undefined,
    embeddedPostgresDataDir: "/tmp/test-pg",
    embeddedPostgresPort: 54329,
    databaseBackupEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: "/tmp/test-backups",
    serveUi: false,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: "/tmp/test-master.key",
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: "/tmp/test-storage",
    storageS3Bucket: "paperclip",
    storageS3Region: "us-east-1",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    heartbeatSchedulerEnabled: false,
    heartbeatSchedulerIntervalMs: 30000,
    companyDeletionEnabled: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildResetPasswordLogLines
// ---------------------------------------------------------------------------

describe("buildResetPasswordLogLines", () => {
  it("includes the user email", () => {
    const lines = buildResetPasswordLogLines(
      { email: "admin@example.com" },
      "http://localhost:3100/api/auth/reset-password/abc123?callbackURL=%2Freset-password",
    );
    const joined = lines.join("\n");
    expect(joined).toContain("admin@example.com");
  });

  it("includes the reset URL", () => {
    const url = "http://localhost:3100/api/auth/reset-password/abc123?callbackURL=%2Freset-password";
    const lines = buildResetPasswordLogLines({ email: "user@test.com" }, url);
    const joined = lines.join("\n");
    expect(joined).toContain(url);
  });

  it("includes the tailscale hostname hint", () => {
    const lines = buildResetPasswordLogLines(
      { email: "user@test.com" },
      "http://localhost:3100/api/auth/reset-password/tok",
    );
    const joined = lines.join("\n");
    expect(joined).toContain("Tailscale");
  });

  it("returns an array of strings", () => {
    const lines = buildResetPasswordLogLines({ email: "a@b.com" }, "http://localhost/reset");
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(typeof line).toBe("string");
    }
  });

  it("logs all lines to console when joined", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const user = { email: "console@test.com" };
    const url = "http://localhost:3100/api/auth/reset-password/xyz";

    const lines = buildResetPasswordLogLines(user, url);
    console.log(lines.join("\n"));

    expect(spy).toHaveBeenCalledOnce();
    const logged = spy.mock.calls[0]?.[0] as string;
    expect(logged).toContain(user.email);
    expect(logged).toContain(url);

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// deriveAuthTrustedOrigins
// ---------------------------------------------------------------------------

describe("deriveAuthTrustedOrigins", () => {
  it("returns empty array when no public URL and no allowed hostnames", () => {
    const origins = deriveAuthTrustedOrigins(makeConfig());
    expect(origins).toEqual([]);
  });

  it("includes the origin of an explicit authPublicBaseUrl", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({
        authBaseUrlMode: "explicit",
        authPublicBaseUrl: "https://paperclip.example.com",
      }),
    );
    expect(origins).toContain("https://paperclip.example.com");
  });

  it("does not include authPublicBaseUrl origin when mode is auto", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({
        authBaseUrlMode: "auto",
        authPublicBaseUrl: "https://paperclip.example.com",
      }),
    );
    // auto mode ignores the public URL for trusted origins
    expect(origins).not.toContain("https://paperclip.example.com");
  });

  it("adds both http and https variants for each allowed hostname in authenticated mode", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({
        deploymentMode: "authenticated",
        allowedHostnames: ["my-host.internal"],
      }),
    );
    expect(origins).toContain("https://my-host.internal");
    expect(origins).toContain("http://my-host.internal");
  });

  it("does not add hostname variants in local_trusted mode", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({
        deploymentMode: "local_trusted",
        allowedHostnames: ["my-host.internal"],
      }),
    );
    expect(origins).not.toContain("https://my-host.internal");
    expect(origins).not.toContain("http://my-host.internal");
  });

  it("deduplicates origins", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({
        deploymentMode: "authenticated",
        authBaseUrlMode: "explicit",
        authPublicBaseUrl: "https://my-host.internal",
        allowedHostnames: ["my-host.internal"],
      }),
    );
    const httpsCount = origins.filter((o) => o === "https://my-host.internal").length;
    expect(httpsCount).toBe(1);
  });

  it("handles multiple allowed hostnames", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({
        deploymentMode: "authenticated",
        allowedHostnames: ["host-a.example", "host-b.example"],
      }),
    );
    expect(origins).toContain("https://host-a.example");
    expect(origins).toContain("https://host-b.example");
  });
});
