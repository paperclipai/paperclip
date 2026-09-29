import { readIndexedAuthorityProof } from "./native-authority-read-context.js";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import type { readNativeJournalProjection as readProjection } from "./native-journal-projection.js";

type File = { path: string; maximum: number };
export type NativeJournalProofJob =
  | { kind: "projection"; path: string; purpose: "identity" | "evidence" }
  | ({ kind: "scan" } & File)
  | ({ kind: "includes"; needles: string[] } & File)
  | { kind: "fingerprint"; files: File[] };
type Result =
  | ReturnType<typeof readProjection>
  | { sha256: string; byteSize: number }
  | { sha256: string; fileSha256: string[] }
  | boolean;
type Pending = {
  job: NativeJournalProofJob;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  deadline: number;
};

/** One worker and a bounded queue cap CPU and memory independently of callers.
 * Queue admission and execution have separate budgets. Termination completes
 * before another job starts. */
export function createNativeJournalProofReader(
  options: { timeoutMs?: number; queueTimeoutMs?: number; maxQueue?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const queueTimeoutMs = options.queueTimeoutMs ?? 30_000;
  const maxQueue = options.maxQueue ?? 32;
  const queue: Pending[] = [];
  let active: Pending | undefined;
  let worker: Worker | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<unknown> | undefined;
  function spawn() {
    const source = new URL(import.meta.url).pathname.endsWith(".ts");
    const url = new URL(
      source
        ? "./native-journal-projection-worker.ts"
        : "./native-journal-projection-worker.js",
      import.meta.url,
    );
    const resourceLimits = {
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    };
    const next = source
      ? new Worker(
          `import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}).then(({tsImport}) => tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)}));`,
          { eval: true, resourceLimits },
        )
      : new Worker(url, { resourceLimits });
    next.on("message", (message: { result?: Result; error?: string }) => {
      if (worker !== next || !active) return;
      if (message.error) void finish(new Error(message.error));
      else void finish(undefined, message.result);
    });
    next.on("error", () => {
      if (worker === next)
        void finish(new Error("native_journal_worker_failed"));
    });
    next.on("exit", () => {
      if (worker === next)
        void finish(new Error("native_journal_worker_exited"));
    });
    return next;
  }
  async function stop() {
    clearTimeout(idleTimer);
    const previous = worker;
    worker = undefined;
    if (previous) {
      stopping = previous.terminate();
      await stopping;
      stopping = undefined;
    }
  }
  async function finish(error?: Error, result?: Result) {
    const pending = active;
    if (!pending) {
      if (error) {
        await stop();
        drain();
      }
      return;
    }
    active = undefined;
    clearTimeout(timer);
    if (error) {
      // Keep the slot occupied until the old thread has actually exited.
      await stop();
      pending.reject(error);
    } else {
      pending.resolve(result!);
      worker?.unref();
      idleTimer = setTimeout(() => {
        if (!active) void stop().then(drain);
      }, 15_000);
      idleTimer.unref();
    }
    drain();
  }
  function drain() {
    if (closed || active || stopping) return;
    while (queue.length) {
      const pending = queue.shift()!;
      if (pending.deadline <= performance.now()) {
        pending.reject(new Error("native_journal_worker_busy"));
        continue;
      }
      clearTimeout(idleTimer);
      active = pending;
      try {
        worker ??= spawn();
        worker.ref();
        timer = setTimeout(() => {
          void finish(new Error("native_journal_worker_timeout"));
        }, timeoutMs);
        worker.postMessage(pending.job);
      } catch {
        void finish(new Error("native_journal_worker_failed"));
      }
      return;
    }
  }
  return {
    read(job: NativeJournalProofJob): Promise<Result> {
      if (closed || queue.length >= maxQueue)
        return Promise.reject(new Error("native_journal_worker_busy"));
      return new Promise((resolve, reject) => {
        queue.push({ job, resolve, reject, deadline: performance.now() + queueTimeoutMs });
        drain();
      });
    },
    async close() {
      closed = true;
      for (const pending of queue.splice(0))
        pending.reject(new Error("native_journal_worker_closed"));
      if (active) await finish(new Error("native_journal_worker_closed"));
      await stop();
      await stopping;
    },
  };
}

const reader = createNativeJournalProofReader();
export async function readNativeJournalProjection(
  path: string,
  purpose: "identity" | "evidence" = "evidence",
) {
  const indexed = await readIndexedAuthorityProof(path);
  if (indexed) return indexed;
  return (await reader.read({
    kind: "projection",
    path,
    purpose,
  })) as ReturnType<typeof readProjection>;
}
export async function scanNativeStateFile(path: string, maximum: number) {
  const indexed = await readIndexedAuthorityProof(path);
  if (indexed) return { sha256: indexed.sha256, byteSize: indexed.byteSize };
  return (await reader.read({ kind: "scan", path, maximum })) as {
    sha256: string;
    byteSize: number;
  };
}
export async function nativeStateFileIncludes(
  path: string,
  maximum: number,
  needles: string[],
) {
  const indexed = await readIndexedAuthorityProof(path);
  if (indexed) return needles.some((needle) => indexed.bytes.includes(needle));
  return (await reader.read({
    kind: "includes",
    path,
    maximum,
    needles,
  })) as boolean;
}
export async function nativeStateBase64Fingerprint(files: File[]) {
  const indexed = await Promise.all(files.map((file) => readIndexedAuthorityProof(file.path)));
  if (indexed.some(Boolean)) {
    const bytes = await Promise.all(files.map(async (file, index) => {
      if (indexed[index]) return indexed[index]!.bytes;
      const proof = await scanNativeStateFile(file.path, file.maximum);
      const fd = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let value: Buffer;
      try {
        const stat = await fd.stat();
        if (!stat.isFile() || stat.size > file.maximum) throw new Error("native_state_file_changed");
        value = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < value.length) { const { bytesRead } = await fd.read(value, offset, value.length - offset, offset); if (!bytesRead) throw new Error("native_state_file_changed"); offset += bytesRead; }
      } finally { await fd.close(); }
      if (value.length > file.maximum || createHash("sha256").update(value).digest("hex") !== proof.sha256) throw new Error("native_state_file_changed");
      return value;
    }));
    return { sha256: createHash("sha256").update(JSON.stringify(bytes.map((value) => value.toString("base64")))).digest("hex"), fileSha256: bytes.map((value) => createHash("sha256").update(value).digest("hex")) };
  }
  return (await reader.read({ kind: "fingerprint", files })) as {
    sha256: string;
    fileSha256: string[];
  };
}
