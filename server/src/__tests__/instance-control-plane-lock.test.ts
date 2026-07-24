import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireControlPlaneLock,
  resolveControlPlaneLockPath,
} from "../instance-control-plane-lock.ts";

describe("instance control-plane lock", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempInstanceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "paperclip-cp-lock-"));
    dirs.push(dir);
    return dir;
  }

  it("acquires and releases an exclusive lock", () => {
    const instanceRoot = tempInstanceRoot();
    const lock = acquireControlPlaneLock({ instanceRoot, env: {} });
    expect(lock).not.toBeNull();
    const lockPath = resolveControlPlaneLockPath(instanceRoot);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    lock!.release();
    expect(() => readFileSync(lockPath, "utf8")).toThrow();
  });

  it("refuses a second live holder", () => {
    const instanceRoot = tempInstanceRoot();
    const first = acquireControlPlaneLock({ instanceRoot, env: {}, pid: process.pid });
    expect(first).not.toBeNull();
    expect(() =>
      acquireControlPlaneLock({
        instanceRoot,
        env: {},
        // Use a different fake "other" pid that is still alive: parent shell is alive.
        pid: process.ppid > 1 ? process.ppid : 1,
      }),
    ).toThrow(/Another Paperclip control plane already holds this instance/);
    first!.release();
  });

  it("replaces a stale lock from a dead pid", () => {
    const instanceRoot = tempInstanceRoot();
    const lockPath = resolveControlPlaneLockPath(instanceRoot);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 99999999,
        startedAt: "2020-01-01T00:00:00.000Z",
        instanceId: "default",
        instanceRoot,
        argv0: "stale",
        allowSharedEnv: "0",
      })}\n`,
      "utf8",
    );

    const lock = acquireControlPlaneLock({ instanceRoot, env: {} });
    expect(lock).not.toBeNull();
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    lock!.release();
  });

  it("skips locking when PAPERCLIP_ALLOW_SHARED_INSTANCE is set", () => {
    const instanceRoot = tempInstanceRoot();
    const lock = acquireControlPlaneLock({
      instanceRoot,
      env: { PAPERCLIP_ALLOW_SHARED_INSTANCE: "1" },
    });
    expect(lock).toBeNull();
  });
});
