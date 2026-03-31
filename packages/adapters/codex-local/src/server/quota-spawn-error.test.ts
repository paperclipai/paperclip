import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));
const itWindows = process.platform === "win32" ? it : it.skip;

vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return {
    ...cp,
    spawn: (...args: Parameters<typeof cp.spawn>) => mockSpawn(...args) as ReturnType<typeof cp.spawn>,
  };
});

import { getQuotaWindows } from "./quota.js";

function createChildThatErrorsOnMicrotask(err: Error): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stream = Object.assign(new EventEmitter(), {
    setEncoding: () => {},
  });
  Object.assign(child, {
    stdout: stream,
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
    stdin: { write: vi.fn(), end: vi.fn() },
    kill: vi.fn(),
  });
  setTimeout(() => {
    child.emit("error", err);
  }, 0);
  return child;
}

describe("CodexRpcClient spawn failures", () => {
  let previousCodexHome: string | undefined;
  let previousPath: string | undefined;
  let previousPathExt: string | undefined;
  let isolatedCodexHome: string | undefined;
  let fakeBinDir: string | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    // After the RPC path fails, getQuotaWindows() calls readCodexToken() which
    // reads $CODEX_HOME/auth.json (default ~/.codex). Point CODEX_HOME at an
    // empty temp directory so we never hit real host auth or the WHAM network.
    previousCodexHome = process.env.CODEX_HOME;
    previousPath = process.env.PATH;
    previousPathExt = process.env.PATHEXT;
    isolatedCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-codex-spawn-test-"));
    process.env.CODEX_HOME = isolatedCodexHome;
  });

  afterEach(() => {
    if (isolatedCodexHome) {
      try {
        fs.rmSync(isolatedCodexHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      isolatedCodexHome = undefined;
    }
    if (fakeBinDir) {
      try {
        fs.rmSync(fakeBinDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      fakeBinDir = undefined;
    }
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousPathExt === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = previousPathExt;
    }
  });

  it("does not crash the process when codex is missing; getQuotaWindows returns ok: false", async () => {
    const enoent = Object.assign(new Error("spawn codex ENOENT"), {
      code: "ENOENT",
      errno: -2,
      syscall: "spawn codex",
      path: "codex",
    });
    mockSpawn.mockImplementation(() => createChildThatErrorsOnMicrotask(enoent));

    const result = await getQuotaWindows();

    expect(result.ok).toBe(false);
    expect(result.windows).toEqual([]);
    expect(result.error).toContain("Codex app-server");
    expect(result.error).toContain("spawn codex ENOENT");
  });

  itWindows("resolves codex.cmd before bare npm shell shims on Windows", async () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-codex-bin-"));
    fakeBinDir = fakeBin;
    const bareShimPath = path.join(fakeBin, "codex");
    const cmdShimPath = path.join(fakeBin, "codex.cmd");
    fs.writeFileSync(bareShimPath, "#!/bin/sh\nexit 1\n", "utf8");
    fs.writeFileSync(cmdShimPath, "@ECHO off\r\nEXIT /b 0\r\n", "utf8");
    process.env.PATH = fakeBin;
    process.env.PATHEXT = ".EXE;.CMD;.BAT;.COM";

    const spawnError = Object.assign(new Error("spawn codex EPERM"), {
      code: "EPERM",
      errno: -4048,
      syscall: "spawn",
      path: cmdShimPath,
    });
    mockSpawn.mockImplementation(() => createChildThatErrorsOnMicrotask(spawnError));

    const result = await getQuotaWindows();

    expect(result.ok).toBe(false);
    expect(path.normalize(String(mockSpawn.mock.calls[0]?.[0])).toLowerCase()).toBe(
      path.normalize(cmdShimPath).toLowerCase(),
    );
  });
});
