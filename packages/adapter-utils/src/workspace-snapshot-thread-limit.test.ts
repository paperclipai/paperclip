import { promises as fs } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({ closing: false, onStart: undefined as undefined | (() => void), workers: [] as Array<{
  directory: string;
  requestId: string;
  emit(event: string, value: unknown): boolean;
}> }));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    directory: string;
    requestId: string;
    constructor(_source: unknown, options: { env: { TMPDIR: string }; workerData: { rootDir: string } }) {
      super();
      this.directory = options.env.TMPDIR;
      this.requestId = options.workerData.rootDir;
      control.workers.push(this);
      control.onStart?.();
      if (control.closing) queueMicrotask(() => {
        this.emit("message", { error: { name: "Error", message: "cleanup" } });
        this.emit("exit", 0);
      });
    }
    async terminate() { return 0; }
  } };
});

import { runSnapshotThread } from "./workspace-snapshot-thread.js";

afterEach(() => { vi.restoreAllMocks(); control.workers.length = 0; control.closing = false; control.onStart = undefined; });

it.each([false, true])("holds capacity through cleanup with reversed directory completion: %s", async reverse => {
  let allowFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { allowFirst = resolve; });
  const mkdtemp = fs.mkdtemp.bind(fs);
  let directories = 0;
  vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args: Parameters<typeof fs.mkdtemp>) => {
    if (reverse && ++directories === 1) await firstGate;
    return await mkdtemp(...args);
  });
  control.onStart = allowFirst;
  const rm = fs.rm.bind(fs);
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  let cleaning = false;
  vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === control.workers[0]?.directory) {
      cleaning = true;
      await cleanupGate;
    }
    return await rm(...args);
  });
  const jobs = new Map(["first", "second", "third"].map(requestId => [requestId,
    runSnapshotThread({ rootDir: requestId }).then(() => null, error => error)]));
  const fail = (worker: typeof control.workers[number]) => {
    worker.emit("message", { error: { name: "Error", message: "failed", code: "EACCES" } });
    worker.emit("exit", 0);
  };
  try {
    await vi.waitFor(() => expect(control.workers).toHaveLength(2));
    if (reverse) expect(control.workers[0]!.requestId).toBe("second");
    const failed = control.workers[0]!;
    fail(failed);
    await vi.waitFor(() => expect(cleaning).toBe(true));
    expect(control.workers).toHaveLength(2);
    expect((await fs.stat(control.workers[0]!.directory)).isDirectory()).toBe(true);
    releaseCleanup();
    expect(await jobs.get(failed.requestId)).toMatchObject({ code: "EACCES" });
    await vi.waitFor(() => expect(control.workers).toHaveLength(3));
    await expect(fs.stat(control.workers[0]!.directory)).rejects.toMatchObject({ code: "ENOENT" });
    fail(control.workers[1]!);
    fail(control.workers[2]!);
    for (const job of jobs.values()) expect(await job).toMatchObject({ code: "EACCES" });
    for (const worker of control.workers) {
      await expect(fs.stat(worker.directory)).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    control.closing = true;
    allowFirst();
    releaseCleanup();
    for (const worker of control.workers) fail(worker);
    await Promise.all(jobs.values());
  }
});
