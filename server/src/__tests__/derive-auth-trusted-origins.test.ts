import { describe, expect, it } from "vitest";
import { deriveAuthTrustedOrigins } from "../auth/better-auth.js";
import type { Config } from "../config.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bind: "all",
    customBindHost: undefined,
    host: "0.0.0.0",
    port: 3100,
    allowedHostnames: ["localhost"],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    databaseMode: "embedded-postgres",
    databaseUrl: undefined,
    embeddedPostgresDataDir: "/tmp/db",
    embeddedPostgresPort: 5432,
    databaseBackupEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 7,
    databaseBackupDir: "/tmp/backups",
    loggingMode: "pretty",
    logDir: "/tmp/logs",
    serveUi: true,
    telemetryEnabled: false,
    storageProvider: "local_disk",
    localDiskBaseDir: "/tmp/storage",
    s3Bucket: "",
    s3Region: "",
    s3Prefix: "",
    s3ForcePathStyle: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    localEncryptedKeyFilePath: "/tmp/key",
    ...overrides,
  } as Config;
}

describe("deriveAuthTrustedOrigins", () => {
  it("includes port for non-standard ports", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({ port: 3100, allowedHostnames: ["localhost", "10.0.0.1"] }),
    );
    expect(origins).toContain("http://localhost:3100");
    expect(origins).toContain("https://localhost:3100");
    expect(origins).toContain("http://10.0.0.1:3100");
    expect(origins).toContain("https://10.0.0.1:3100");
  });

  it("omits port suffix for HTTP on port 80", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({ port: 80, allowedHostnames: ["example.com"] }),
    );
    expect(origins).toContain("http://example.com");
    expect(origins).toContain("https://example.com:80");
  });

  it("omits port suffix for HTTPS on port 443", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({ port: 443, allowedHostnames: ["example.com"] }),
    );
    expect(origins).toContain("https://example.com");
    expect(origins).toContain("http://example.com:443");
  });

  it("respects explicit port in hostname", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({ port: 3100, allowedHostnames: ["myhost:8080"] }),
    );
    expect(origins).toContain("http://myhost:8080");
    expect(origins).toContain("https://myhost:8080");
    // Should NOT double-append the config port
    expect(origins).not.toContain("http://myhost:8080:3100");
  });

  it("handles IPv6 literals without false port detection", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({ port: 3100, allowedHostnames: ["[::1]"] }),
    );
    expect(origins).toContain("http://[::1]:3100");
    expect(origins).toContain("https://[::1]:3100");
  });

  it("handles IPv6 literal with explicit port", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({ port: 3100, allowedHostnames: ["[::1]:8080"] }),
    );
    expect(origins).toContain("http://[::1]:8080");
    expect(origins).toContain("https://[::1]:8080");
    expect(origins).not.toContain("http://[::1]:8080:3100");
  });

  it("handles bare IPv6 address (without brackets)", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({ port: 3100, allowedHostnames: ["::1"] }),
    );
    // Bare IPv6 should get the port appended, not be mistaken for host:port
    expect(origins).toContain("http://::1:3100");
    expect(origins).toContain("https://::1:3100");
  });

  it("includes explicit baseUrl origin", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({
        authBaseUrlMode: "explicit",
        authPublicBaseUrl: "https://paperclip.example.com:443",
        allowedHostnames: ["localhost"],
        port: 3100,
      }),
    );
    expect(origins).toContain("https://paperclip.example.com");
    expect(origins).toContain("http://localhost:3100");
  });

  it("returns empty for local_trusted mode", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({ deploymentMode: "local_trusted", allowedHostnames: ["localhost"] }),
    );
    expect(origins).toEqual([]);
  });

  it("skips empty hostnames", () => {
    const origins = deriveAuthTrustedOrigins(
      makeConfig({ port: 3100, allowedHostnames: ["localhost", "", "  "] }),
    );
    expect(origins).toHaveLength(2); // http + https for localhost only
  });
});
