import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeConfig } from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";

function buildValidConfig(runtimeRoot: string): PaperclipConfig {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-06-20T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(runtimeRoot, "db"),
      embeddedPostgresPort: 55432,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(runtimeRoot, "backups"),
      },
    },
    logging: { mode: "file", logDir: path.join(runtimeRoot, "logs") },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3199,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    telemetry: { enabled: true },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: path.join(runtimeRoot, "storage") },
      s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: path.join(runtimeRoot, "secrets", "master.key") },
    },
  };
}

describe("writeConfig", () => {
  it("refuses to persist a config whose $meta.source is outside the enum (BASA-29492)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-store-"));
    const configPath = path.join(root, ".paperclip", "config.json");
    const valid = buildValidConfig(path.join(root, "runtime"));

    const tampered = {
      ...valid,
      $meta: { ...valid.$meta, source: "basa29364-r3-config-drift-fix" },
    } as unknown as PaperclipConfig;

    expect(() => writeConfig(tampered, configPath)).toThrow(/Refusing to write invalid config/);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("writes successfully when $meta.source is a valid enum value", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-store-"));
    const configPath = path.join(root, ".paperclip", "config.json");
    const valid = buildValidConfig(path.join(root, "runtime"));

    expect(() => writeConfig(valid, configPath)).not.toThrow();
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(onDisk.$meta.source).toBe("configure");
  });
});
