import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return {
    ...cp,
    spawn: (...args: Parameters<typeof cp.spawn>) => mockSpawn(...args) as ReturnType<typeof cp.spawn>,
  };
});

import type { AdapterQuotaContext } from "@paperclipai/adapter-utils";
import { getQuotaWindows } from "./quota.js";

function createChildThatErrorsOnMicrotask(err: Error): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stream = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  Object.assign(child, {
    stdout: stream,
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
    stdin: { write: vi.fn(), end: vi.fn() },
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    child.emit("error", err);
  });
  return child;
}

describe("getQuotaWindows execution-target context", () => {
  let previousCodexHome: string | undefined;
  let isolatedCodexHome: string | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    // Force a deterministic host probe with no network. The app-server spawn
    // errors and CODEX_HOME points at an empty directory, so there is no auth
    // token. Both call shapes must return this same host result.
    mockSpawn.mockImplementation(() =>
      createChildThatErrorsOnMicrotask(new Error("spawn codex ENOENT")),
    );
    previousCodexHome = process.env.CODEX_HOME;
    isolatedCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-codex-quota-target-test-"));
    process.env.CODEX_HOME = isolatedCodexHome;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (isolatedCodexHome) {
      try {
        fs.rmSync(isolatedCodexHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      isolatedCodexHome = undefined;
    }
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("accepts an optional context and keeps the host result for a null target", async () => {
    const hostResult = await getQuotaWindows();
    const nullTargetResult = await getQuotaWindows({ executionTarget: null });

    expect(nullTargetResult).toEqual(hostResult);
    expect(hostResult.ok).toBe(false);
    expect(hostResult.provider).toBe("openai");
  });

  it("accepts both the absent and the null-target call shapes", async () => {
    // The type must accept a call with no argument and a call with an explicit
    // context object.
    const ctx: AdapterQuotaContext = { executionTarget: null };
    await expect(getQuotaWindows()).resolves.toBeDefined();
    await expect(getQuotaWindows(ctx)).resolves.toBeDefined();
  });
});
