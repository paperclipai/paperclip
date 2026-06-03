import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRepairLock,
  acquireRunLock,
  backupFile,
  checkRunLock,
} from "../utils/process-lock.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-lock-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("acquireRunLock", () => {
  it("creates a lock file containing the current PID", () => {
    const lock = acquireRunLock(tmpDir);
    const lockPath = path.join(tmpDir, "run.lock");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10)).toBe(process.pid);
    lock.release();
  });

  it("removes the lock file on release", () => {
    const lock = acquireRunLock(tmpDir);
    const lockPath = path.join(tmpDir, "run.lock");
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("throws when a live process already holds the lock", () => {
    // PID 1 (init/systemd) is always alive — simulate a live competing process.
    const lockPath = path.join(tmpDir, "run.lock");
    fs.writeFileSync(lockPath, "1", "utf8");

    expect(() => acquireRunLock(tmpDir)).toThrow(/already running/);
    // Leave cleanup to afterEach (lock file wasn't acquired, so no release needed)
  });

  it("clears a stale lock (dead PID) and acquires successfully", () => {
    // PID 1 is always alive on Linux but we can use a definitely-dead PID via a trick:
    // write an impossibly large PID that no real process has.
    const lockPath = path.join(tmpDir, "run.lock");
    fs.writeFileSync(lockPath, "9999999", "utf8"); // will not be a live process

    // Should succeed (stale lock removed) without throwing
    const lock = acquireRunLock(tmpDir);
    expect(fs.existsSync(lockPath)).toBe(true);
    lock.release();
  });

  it("can be acquired again after release", () => {
    const lock1 = acquireRunLock(tmpDir);
    lock1.release();

    // Same tmpDir, should now succeed
    const lock2 = acquireRunLock(tmpDir);
    lock2.release();
  });
});

describe("acquireRepairLock", () => {
  it("creates and removes the repair lock file", () => {
    const lock = acquireRepairLock(tmpDir);
    const lockPath = path.join(tmpDir, "repair.lock");
    expect(fs.existsSync(lockPath)).toBe(true);
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("throws when a live process already holds the repair lock", () => {
    // PID 1 is always alive — simulate a live competing process.
    const lockPath = path.join(tmpDir, "repair.lock");
    fs.writeFileSync(lockPath, "1", "utf8");

    expect(() => acquireRepairLock(tmpDir)).toThrow(/already running/);
  });
});

describe("checkRunLock", () => {
  it("returns null when no lock file exists", () => {
    expect(checkRunLock(tmpDir)).toBeNull();
  });

  it("returns null for a stale (dead) lock", () => {
    const lockPath = path.join(tmpDir, "run.lock");
    fs.writeFileSync(lockPath, "9999999", "utf8");
    expect(checkRunLock(tmpDir)).toBeNull();
  });

  it("returns null for the current process's own PID", () => {
    const lockPath = path.join(tmpDir, "run.lock");
    fs.writeFileSync(lockPath, String(process.pid), "utf8");
    expect(checkRunLock(tmpDir)).toBeNull();
  });
});

describe("backupFile", () => {
  it("returns null when the file does not exist", () => {
    const result = backupFile(path.join(tmpDir, "nonexistent.txt"));
    expect(result).toBeNull();
  });

  it("creates a timestamped backup and returns its path", () => {
    const original = path.join(tmpDir, "test.txt");
    fs.writeFileSync(original, "hotfix content");

    const backup = backupFile(original);
    expect(backup).not.toBeNull();
    expect(fs.existsSync(backup!)).toBe(true);
    expect(fs.readFileSync(backup!, "utf8")).toBe("hotfix content");
    expect(backup!).toMatch(/\.bak\.\d+$/);
  });

  it("does not modify the original file", () => {
    const original = path.join(tmpDir, "test.txt");
    fs.writeFileSync(original, "original");
    backupFile(original);
    expect(fs.readFileSync(original, "utf8")).toBe("original");
  });
});
