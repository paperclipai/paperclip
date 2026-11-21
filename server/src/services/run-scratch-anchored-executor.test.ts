import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// The executor tests intercept the spawned anchor executor (or its timers)
// so the exact failure ordering of VPS-789 findings 2 and 4 can be driven
// deterministically. Everything else in the module under test is real.
const spawnHooks = vi.hoisted(() => ({
  spawn: null as ((...args: unknown[]) => unknown) | null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) =>
      spawnHooks.spawn
        ? (spawnHooks.spawn(...args) as ReturnType<typeof actual.spawn>)
        : actual.spawn(...args)) as typeof actual.spawn,
  };
});

import { createDefaultRunScratchWalkerOps } from "./run-scratch.js";

const cleanupDirs = new Set<string>();

afterEach(async () => {
  spawnHooks.spawn = null;
  await Promise.all(
    Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
  cleanupDirs.clear();
});

const runId = (seed: string) => `${seed.padEnd(8, "0").slice(0, 8)}-1111-2222-3333-444444444444`;

// VPS-789 finding 2: an async error on the executor child's stdin stream
// (a cleanup pipe breaking mid-write) must never surface as an unhandled
// `error` event that kills the shared server process. The owning
// generation's requests settle as failed, the tree is kept, and the next
// operation runs on a fresh executor.
describe("VPS-789 anchored executor stream failure", () => {
  it("settles the owning request as failed on an async stdin error and recovers on the next operation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pipe-g2-"));
    cleanupDirs.add(root);
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let errorListenersAtBreak = -1;
    let broke = false;
    const spawned: import("node:child_process").ChildProcess[] = [];
    spawnHooks.spawn = (...args: unknown[]) => {
      const child = actual.spawn(...(args as Parameters<typeof actual.spawn>));
      const argv = args[1] as string[] | undefined;
      if (argv?.[0] === "-e" && String(argv[1]).includes("run scratch walker anchor")) {
        spawned.push(child);
        const stdin = child.stdin!;
        const originalWrite = stdin.write.bind(stdin) as (...writeArgs: unknown[]) => boolean;
        (stdin as unknown as { write: typeof stdin.write }).write = ((...writeArgs: unknown[]) => {
          if (!broke) {
            broke = true;
            errorListenersAtBreak = stdin.listenerCount("error");
            // Deliver the stream error Node emits when a cleanup pipe
            // breaks: asynchronous, after the synchronous write returned.
            process.nextTick(() =>
              stdin.destroy(Object.assign(new Error("fixture broken pipe"), { code: "EPIPE" })),
            );
          }
          return originalWrite(...(writeArgs as Parameters<typeof originalWrite>));
        }) as typeof stdin.write;
      }
      return child;
    };

    const ops = createDefaultRunScratchWalkerOps("paths");
    const fd = await ops.openDir(root);
    try {
      let code: string | undefined;
      try {
        await ops.listDir(fd);
        expect.unreachable("the broken pipe must fail the operation");
      } catch (error) {
        code = (error as NodeJS.ErrnoException).code;
      }
      expect(code).toBe("ECHILD");
      // The stdin stream carries an error handler from the moment the
      // executor is spawned; without it this process would have died on
      // the unhandled `error` event before the assertions.
      expect(errorListenersAtBreak).toBeGreaterThan(0);

      // The replacement executor serves the follow-up operation: the tree
      // was kept, never declared removed, and the retry works.
      await expect(ops.listDir(fd)).resolves.toEqual([]);
    } finally {
      // Retire the executor this test spawned so later tests in this file
      // deterministically start from their own generation.
      for (const child of spawned) child.kill("SIGKILL");
      await ops.closeDir(fd).catch(() => undefined);
    }
  });
});

// VPS-789 finding 4: pending requests, buffers and events belong to the
// executor generation that runs them. When a timed-out child is replaced
// and the stale child's exit arrives afterwards, only the stale
// generation's (already settled) requests may be cancelled — the
// replacement's in-flight request must complete normally.
interface FakeChild extends EventEmitter {
  stdin: PassThrough & { unref: () => void };
  stdout: PassThrough & { unref: () => void };
  killed: boolean;
  kill: () => boolean;
  unref: () => void;
}

describe("VPS-789 anchored executor generation isolation", () => {
  it("does not cancel the replacement's pending request when the stale child exits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-stale-g4-"));
    cleanupDirs.add(root);
    const children: FakeChild[] = [];
    const executorTimeouts: Array<() => void> = [];
    const parkedHandles: NodeJS.Timeout[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as { setTimeout: typeof globalThis.setTimeout }).setTimeout = ((
      callback: (...callbackArgs: unknown[]) => void,
      ms?: unknown,
      ...callbackArgs: unknown[]
    ) => {
      if (ms === 20_000) {
        executorTimeouts.push(() => callback(...callbackArgs));
        const handle = originalSetTimeout(() => {}, 60_000);
        parkedHandles.push(handle);
        return handle;
      }
      return originalSetTimeout(
        callback as never,
        ms as never,
        ...(callbackArgs as never[]),
      );
    }) as typeof globalThis.setTimeout;
    spawnHooks.spawn = (() => {
      const child = new EventEmitter() as FakeChild;
      child.stdin = Object.assign(new PassThrough(), { unref: () => {} });
      child.stdout = Object.assign(new PassThrough(), { unref: () => {} });
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        return true;
      };
      child.unref = () => {};
      // The fake executors never answer on their own: the replacement's
      // response is released by the test after the stale exit arrives, so
      // the request is provably in flight when the old child's events land.
      children.push(child);
      return child;
    }) as unknown as () => FakeChild;

    const ops = createDefaultRunScratchWalkerOps("paths");
    const fd = await ops.openDir(root);
    const requestIds = (child: FakeChild) =>
      new Promise<number>((resolve) => {
        child.stdin.on("data", function track(chunk: string | Buffer) {
          for (const line of chunk.toString().split("\n")) {
            if (!line.trim()) continue;
            child.stdin.off("data", track);
            resolve((JSON.parse(line) as { id: number }).id);
            return;
          }
        });
      });
    try {
      const first = ops
        .listDir(fd)
        .then(() => ({ ok: true as const }))
        .catch((error: NodeJS.ErrnoException) => ({ error: error.code as string }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(executorTimeouts.length).toBe(1);
      // Child A times out: its own request fails, the child is killed and
      // the reference dropped so the next request spawns a replacement.
      executorTimeouts[0]!();
      expect(await first).toEqual({ error: "ECHILD" });

      const second = ops
        .listDir(fd)
        .then(() => ({ ok: true as const }))
        .catch((error: NodeJS.ErrnoException) => ({ error: error.code as string }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(children.length).toBe(2);
      expect(children[1]!.killed).toBe(false);
      // The replacement's request is in flight (its line is buffered in
      // the fake stdin) when the stale child's exit arrives.
      const secondId = await requestIds(children[1]!);
      children[0]!.emit("exit", null, "SIGKILL");
      // The replacement answers normally: its pending request survives the
      // stale exit untouched.
      children[1]!.stdout.write(`${JSON.stringify({ id: secondId, result: [] })}\n`);
      expect(await second).toEqual({ ok: true });
      expect(children[1]!.killed).toBe(false);
    } finally {
      (globalThis as { setTimeout: typeof globalThis.setTimeout }).setTimeout = originalSetTimeout;
      for (const handle of parkedHandles) clearTimeout(handle);
      await ops.closeDir(fd).catch(() => undefined);
    }
  });
});
