import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("file logging path resolution", () => {
  const originalEnv = { ...process.env };
  let tempRoot: string;
  let configPath: string;

  beforeEach(() => {
    vi.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-file-log-"));
    configPath = path.join(tempRoot, "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.PAPERCLIP_LOG_DIR;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes under configured logging.logDir on Windows-style absolute paths", async () => {
    const logDir = path.join(tempRoot, "instances", "default", "logs");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        $meta: { version: 1, updatedAt: "2026-09-18T00:00:00.000Z", source: "configure" },
        logging: { mode: "file", logDir },
        database: { mode: "embedded-postgres" },
        server: { deploymentMode: "local_trusted" },
        secrets: { provider: "local_encrypted" },
        storage: { provider: "local_disk" },
      }),
      "utf8",
    );

    const { resolveServerLogFilePath, isFileLoggingEnabled } = await import(
      "../middleware/logger.js"
    );

    expect(isFileLoggingEnabled()).toBe(true);
    expect(resolveServerLogFilePath()).toBe(path.join(logDir, "server.log"));
  });

  it("does not enable file logging when mode is cloud", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        $meta: { version: 1, updatedAt: "2026-09-18T00:00:00.000Z", source: "configure" },
        logging: { mode: "cloud", logDir: path.join(tempRoot, "logs") },
        database: { mode: "embedded-postgres" },
        server: { deploymentMode: "local_trusted" },
        secrets: { provider: "local_encrypted" },
        storage: { provider: "local_disk" },
      }),
      "utf8",
    );

    const { isFileLoggingEnabled } = await import("../middleware/logger.js");
    expect(isFileLoggingEnabled()).toBe(false);
  });
});
