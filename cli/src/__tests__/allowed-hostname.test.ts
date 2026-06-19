import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { addAllowedHostname } from "../commands/allowed-hostname.js";

function createTempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-allowed-hostname-"));
  return path.join(dir, "config.json");
}

function writeBaseConfig(configPath: string) {
  const base: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/paperclip-db",
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: "/tmp/paperclip-backups",
      },
    },
    logging: {
      mode: "file",
      logDir: "/tmp/paperclip-logs",
    },
    server: {
      deploymentMode: "authenticated",
      exposure: "private",
      host: "0.0.0.0",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    telemetry: {
      enabled: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "/tmp/paperclip-storage" },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: "/tmp/paperclip-secrets/master.key" },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(base, null, 2));
}

describe("allowed-hostname command", () => {
  it("adds and normalizes hostnames", async () => {
    const configPath = createTempConfigPath();
    writeBaseConfig(configPath);

    await addAllowedHostname("https://Dotta-MacBook-Pro:3100", { config: configPath });
    await addAllowedHostname("dotta-macbook-pro", { config: configPath });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as PaperclipConfig;
    expect(raw.server.allowedHostnames).toEqual(["dotta-macbook-pro"]);
  });

  it("writes directly to config without requiring a running server", async () => {
    // Regression: GH#6420 — the command used to make an HTTP call to the
    // server, failing when the server was offline. It now writes directly to
    // config.json so it works regardless of server state.
    const configPath = createTempConfigPath();
    writeBaseConfig(configPath);

    // No HTTP mocking needed — if the command made an HTTP call it would throw.
    await addAllowedHostname("my.domain.com", { config: configPath });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as PaperclipConfig;
    expect(raw.server.allowedHostnames).toContain("my.domain.com");
  });

  it("shows error without crashing when config is missing", async () => {
    const configPath = createTempConfigPath(); // file does not exist yet

    // Should return cleanly (no throw) and not create the file
    await expect(addAllowedHostname("my.domain.com", { config: configPath })).resolves.toBeUndefined();
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
