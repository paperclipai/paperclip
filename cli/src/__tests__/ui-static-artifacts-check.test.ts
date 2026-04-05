import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uiStaticArtifactsCheckForRepoRoot } from "../checks/ui-static-artifacts-check.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_ENV = { ...process.env };

function minimalConfig(overrides: Partial<PaperclipConfig["server"]> = {}): PaperclipConfig {
  return {
    $meta: { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", source: "configure" },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/x",
      embeddedPostgresPort: 54329,
      backup: { enabled: false, intervalMinutes: 60, retentionDays: 7, dir: "/tmp/b" },
    },
    logging: { mode: "file", logDir: "/tmp/l" },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
      ...overrides,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "/tmp/s" },
      s3: { bucket: "x", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: "/tmp/k" },
    },
  };
}

describe("uiStaticArtifactsCheckForRepoRoot", () => {
  let tmp: string;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ui-artifacts-"));
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("passes when dev middleware is not explicitly false", () => {
    delete process.env.PAPERCLIP_UI_DEV_MIDDLEWARE;
    const r = uiStaticArtifactsCheckForRepoRoot(minimalConfig(), tmp);
    expect(r.status).toBe("pass");
  });

  it("fails in monorepo layout without ui dist when static middleware forced", () => {
    process.env.PAPERCLIP_UI_DEV_MIDDLEWARE = "false";
    fs.mkdirSync(path.join(tmp, "server", "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "server", "src", "index.ts"), "//x\n");

    const r = uiStaticArtifactsCheckForRepoRoot(minimalConfig(), tmp);
    expect(r.status).toBe("fail");
  });

  it("passes when ui/dist exists", () => {
    process.env.PAPERCLIP_UI_DEV_MIDDLEWARE = "false";
    fs.mkdirSync(path.join(tmp, "server", "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "server", "src", "index.ts"), "//x\n");
    fs.mkdirSync(path.join(tmp, "ui", "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "ui", "dist", "index.html"), "<!doctype html>");

    const r = uiStaticArtifactsCheckForRepoRoot(minimalConfig(), tmp);
    expect(r.status).toBe("pass");
  });
});
