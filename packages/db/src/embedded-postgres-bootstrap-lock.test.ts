import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireEmbeddedPostgresBootstrapLock,
  readEmbeddedPostmasterInfo,
} from "./embedded-postgres-bootstrap-lock.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-bootstrap-lock-"));
  tempDirs.push(dir);
  return dir;
}

function lockPathForDataDir(dataDir: string) {
  return path.resolve(path.dirname(dataDir), `${path.basename(dataDir)}.paperclip-embedded-postgres-bootstrap.lock`);
}

describe("acquireEmbeddedPostgresBootstrapLock", () => {
  it("serializes concurrent bootstrap attempts for the same data dir", async () => {
    const dataDir = makeTempDir();
    const events: string[] = [];
    const releaseFirst = await acquireEmbeddedPostgresBootstrapLock({ dataDir });

    events.push("first-enter");

    const second = (async () => {
      const releaseSecond = await acquireEmbeddedPostgresBootstrapLock({ dataDir, timeoutMs: 5_000 });
      events.push("second-enter");
      await releaseSecond();
    })();

    await new Promise((resolve) => setTimeout(resolve, 200));
    events.push("first-exit");
    await releaseFirst();
    await second;

    expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("removes a stale bootstrap lock left by a dead process", async () => {
    const dataDir = makeTempDir();
    const lockPath = lockPathForDataDir(dataDir);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999_999,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );

    const release = await acquireEmbeddedPostgresBootstrapLock({ dataDir, timeoutMs: 1_000, staleMs: 100 });
    expect(fs.existsSync(lockPath)).toBe(true);
    await release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not evict a fresh lock file that is still being written", async () => {
    const dataDir = makeTempDir();
    const lockPath = lockPathForDataDir(dataDir);
    fs.writeFileSync(lockPath, "", "utf8");

    await expect(
      acquireEmbeddedPostgresBootstrapLock({
        dataDir,
        timeoutMs: 100,
        pollIntervalMs: 20,
        staleMs: 5_000,
      }),
    ).rejects.toThrow(/Timed out waiting/);

    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("reads pid and port from postmaster.pid", () => {
    const dataDir = makeTempDir();
    const pidFile = path.join(dataDir, "postmaster.pid");
    fs.writeFileSync(pidFile, `${process.pid}\n/tmp\n17100\n54377\n`, "utf8");

    expect(readEmbeddedPostmasterInfo(pidFile)).toEqual({
      pid: process.pid,
      port: 54377,
    });
  });
});
