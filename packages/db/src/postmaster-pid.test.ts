import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePostmasterPidText, readRunningPostmasterPid, reapStoppingPostmaster } from "./postmaster-pid.js";

const ORIGINAL_KILL = process.kill;

afterEach(() => {
  process.kill = ORIGINAL_KILL;
  vi.restoreAllMocks();
});

function makePidFile(body: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-postmaster-pid-"));
  const file = path.join(dir, "postmaster.pid");
  writeFileSync(file, body, "utf8");
  return { dir, file };
}

describe("postmaster pid helpers", () => {
  it("parses status and stopping state from postmaster.pid text", () => {
    const info = parsePostmasterPidText([
      "30029",
      "/tmp/db",
      "1776932567",
      "54329",
      "/tmp",
      "localhost",
      " 32167972    983041",
      "stopping",
      "",
    ].join("\n"));

    expect(info).toEqual({
      pid: 30029,
      port: 54329,
      status: "stopping",
      isStopping: true,
    });
  });

  it("does not treat a stopping postmaster as reusable even if the pid is still alive", () => {
    const { dir, file } = makePidFile([
      "30029",
      "/tmp/db",
      "1776932567",
      "54329",
      "/tmp",
      "localhost",
      " 32167972    983041",
      "stopping",
      "",
    ].join("\n"));
    process.kill = vi.fn((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid !== 30029 || signal !== 0) {
        throw new Error(`unexpected signal ${String(signal)} for pid ${pid}`);
      }
      return true;
    }) as typeof process.kill;

    expect(readRunningPostmasterPid(file)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("force-kills and removes a stuck stopping postmaster pid file", async () => {
    const { dir, file } = makePidFile([
      "30029",
      "/tmp/db",
      "1776932567",
      "54329",
      "/tmp",
      "localhost",
      " 32167972    983041",
      "stopping",
      "",
    ].join("\n"));
    let alive = true;
    const signals: Array<number | NodeJS.Signals | undefined> = [];
    process.kill = vi.fn((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid !== 30029) {
        throw new Error(`unexpected pid ${pid}`);
      }
      signals.push(signal);
      if (signal === 0) {
        if (!alive) {
          const err = new Error("not running") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      }
      if (signal === "SIGKILL") {
        alive = false;
        return true;
      }
      throw new Error(`unexpected signal ${String(signal)}`);
    }) as typeof process.kill;

    const result = await reapStoppingPostmaster(file, { gracePeriodMs: 1, pollMs: 1 });

    expect(result).toMatchObject({ reaped: true, forceKilled: true, pid: 30029, status: "stopping" });
    expect(existsSync(file)).toBe(false);
    expect(signals).toContain("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });
});
