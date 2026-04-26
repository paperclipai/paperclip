import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { logCheck } from "./log-check.js";

function makeConfig(logDir: string): PaperclipConfig {
  return { logging: { logDir } } as unknown as PaperclipConfig;
}

// Track temp dirs to clean up after tests
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-check-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});

// ============================================================================
// logCheck — directory already exists and is writable
// ============================================================================

describe("logCheck — writable directory", () => {
  it("returns pass status when log directory exists and is writable", () => {
    const logDir = makeTempDir();
    const result = logCheck(makeConfig(logDir));
    expect(result.status).toBe("pass");
  });

  it("sets name to 'Log directory'", () => {
    const logDir = makeTempDir();
    const result = logCheck(makeConfig(logDir));
    expect(result.name).toBe("Log directory");
  });

  it("includes the log directory path in the message", () => {
    const logDir = makeTempDir();
    const result = logCheck(makeConfig(logDir));
    expect(result.message).toContain(logDir);
  });
});

// ============================================================================
// logCheck — directory does not exist (created by check)
// ============================================================================

describe("logCheck — non-existent directory", () => {
  it("creates the directory and returns pass when parent is writable", () => {
    const parentDir = makeTempDir();
    const logDir = path.join(parentDir, "new-log-dir");
    const result = logCheck(makeConfig(logDir));
    expect(result.status).toBe("pass");
    expect(fs.existsSync(logDir)).toBe(true);
  });

  it("creates nested directories recursively", () => {
    const parentDir = makeTempDir();
    const logDir = path.join(parentDir, "a", "b", "c");
    const result = logCheck(makeConfig(logDir));
    expect(result.status).toBe("pass");
    expect(fs.existsSync(logDir)).toBe(true);
  });
});

// ============================================================================
// logCheck — directory not writable (simulated via chmod)
// ============================================================================

describe("logCheck — non-writable directory", () => {
  it("returns fail status when directory is not writable", () => {
    const parentDir = makeTempDir();
    const logDir = path.join(parentDir, "readonly-logs");
    fs.mkdirSync(logDir);
    // Remove write permission
    fs.chmodSync(logDir, 0o555);

    let result;
    try {
      result = logCheck(makeConfig(logDir));
    } finally {
      // Restore permissions so cleanup can proceed
      fs.chmodSync(logDir, 0o755);
    }

    expect(result.status).toBe("fail");
  });

  it("returns fail message mentioning the directory", () => {
    const parentDir = makeTempDir();
    const logDir = path.join(parentDir, "readonly-logs2");
    fs.mkdirSync(logDir);
    fs.chmodSync(logDir, 0o555);

    let result;
    try {
      result = logCheck(makeConfig(logDir));
    } finally {
      fs.chmodSync(logDir, 0o755);
    }

    expect(result.message).toContain(logDir);
  });

  it("sets canRepair to false on fail", () => {
    const parentDir = makeTempDir();
    const logDir = path.join(parentDir, "readonly-logs3");
    fs.mkdirSync(logDir);
    fs.chmodSync(logDir, 0o555);

    let result;
    try {
      result = logCheck(makeConfig(logDir));
    } finally {
      fs.chmodSync(logDir, 0o755);
    }

    expect(result.canRepair).toBe(false);
  });
});
