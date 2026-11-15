import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { SHARE_ENV, Worker } from "node:worker_threads";
import type { Db } from "@paperclipai/db";
import { databaseClientOptionsFromEnv } from "@paperclipai/db/client";
import type { RoutineCheckpointSaveOwner, RoutineCheckpointSaveResult } from "../native-runtime/native-runner-checkpoint-routine-save.js";
import type { WriterThreadReply, WriterThreadRequest } from "./writer-thread.js";

export type WriterThreadSettings = { threads: number; poolMax: number; timeoutMs: number };

export const WRITER_THREADS_MAX = 8;
export const WRITER_THREAD_POOL_MAX_LIMIT = 5;
const FENCE_DEADLINE_MS = 5_000;

function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got: ${env[name]}`);
  }
  return Number(raw);
}

export function readWriterThreadSettings(env: NodeJS.ProcessEnv = process.env): WriterThreadSettings {
  return {
    threads: integerSetting(env, "PAPERCLIP_WRITER_THREADS", 0, 0, WRITER_THREADS_MAX),
    poolMax: integerSetting(env, "PAPERCLIP_WRITER_THREAD_POOL_MAX", 2, 1, WRITER_THREAD_POOL_MAX_LIMIT),
    timeoutMs: integerSetting(env, "PAPERCLIP_WRITER_THREAD_TIMEOUT_MS", 30_000, 100, 600_000),
  };
}

export class WriterThreadUnavailableError extends Error {
  readonly code = "writer_thread_unavailable" as const;
  constructor(readonly fenced: boolean, reason: string) {
    super(`writer_thread_unavailable:${reason}`);
    this.name = "WriterThreadUnavailableError";
  }
}

export class WriterThreadsClosedError extends Error {
  readonly code = "writer_threads_closed" as const;
  constructor(reason: "closed" | "revoked") {
    super(`writer_threads_${reason}`);
    this.name = "WriterThreadsClosedError";
  }
}

type Pending = { resolve: (value: RoutineCheckpointSaveResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null };
type Slot = {
  index: number; incarnation: number; worker: Worker | null; applicationName: string; ready: boolean; verified: boolean;
  bootTimer: ReturnType<typeof setTimeout> | null; pending: Map<number, Pending>; fence: Promise<void> | null;
};

function partition(key: string, size: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
  return (hash >>> 0) % size;
}

export function writerThreadEntry(moduleUrl: string = import.meta.url): { url: URL; source: boolean } {
  if (new URL(moduleUrl).pathname.endsWith(".ts")) return { url: new URL("./writer-thread.ts", moduleUrl), source: true };
  const bundled = new URL("../../../dist-runtime/writer-thread.mjs", moduleUrl);
  return { url: existsSync(bundled) ? bundled : new URL("./writer-thread.js", moduleUrl), source: false };
}

export type WriterThreadStats = { submitted: number; completed: number; failed: number; lost: number; respawned: number };

export class WriterThreads {
  readonly #db: Db;
  readonly #connectionString: string;
  readonly #settings: WriterThreadSettings;
  readonly #control = new Int32Array(new SharedArrayBuffer(8));
  readonly #tag = randomBytes(4).toString("hex");
  readonly #slots: Slot[];
  #nextId = 0;
  #closing = false;
  readonly #stats: WriterThreadStats = { submitted: 0, completed: 0, failed: 0, lost: 0, respawned: 0 };

  constructor(db: Db, connectionString: string, settings: WriterThreadSettings) {
    this.#db = db;
    this.#connectionString = connectionString;
    this.#settings = settings;
    this.#slots = Array.from({ length: settings.threads }, (_, index) => ({
      index, incarnation: 0, worker: null, applicationName: "", ready: false, verified: false, bootTimer: null, pending: new Map(), fence: null,
    }));
  }

  get threads(): number { return this.#slots.length; }
  stats(): WriterThreadStats { return { ...this.#stats }; }

  saveRoutineCheckpoint(owner: RoutineCheckpointSaveOwner, changed: ReadonlyMap<string, string>): Promise<RoutineCheckpointSaveResult> {
    return this.#submit(owner.runId, {
      kind: "checkpoint.save",
      owner: { companyId: owner.companyId, issueId: owner.issueId, runId: owner.runId, authorityRunId: owner.authorityRunId,
        bootId: owner.bootId, generation: owner.generation, leaseOwner: owner.leaseOwner },
      changed: [...changed],
    });
  }

  revoke(): void {
    Atomics.add(this.#control, 1, 1);
  }

  async #submit(run: string, body: Omit<Extract<WriterThreadRequest, { kind: "checkpoint.save" }>, "id" | "epoch" | "run">) {
    if (this.#closing) throw new WriterThreadsClosedError("closed");
    const slot = this.#slots[partition(run, this.#slots.length)]!;
    if (slot.fence) await slot.fence;
    if (this.#closing) throw new WriterThreadsClosedError("closed");
    const worker = slot.worker ?? this.#spawn(slot);
    const id = ++this.#nextId;
    this.#stats.submitted += 1;
    return new Promise<RoutineCheckpointSaveResult>((resolve, reject) => {
      const pending: Pending = { resolve, reject, timer: null };
      if (slot.ready) this.#arm(slot, worker, pending);
      slot.pending.set(id, pending);
      worker.postMessage({ ...body, id, run, epoch: Atomics.load(this.#control, 1) } satisfies WriterThreadRequest);
    });
  }

  #arm(slot: Slot, worker: Worker, pending: Pending): void {
    pending.timer = setTimeout(() => { void this.#lose(slot, worker, "timeout"); }, this.#settings.timeoutMs);
  }

  #spawn(slot: Slot): Worker {
    slot.incarnation += 1;
    if (slot.incarnation > 1) this.#stats.respawned += 1;
    slot.applicationName = `paperclip-writer-${this.#tag}-${slot.index}-${slot.incarnation}`;
    slot.ready = false;
    slot.verified = false;
    const workerData = {
      connectionString: this.#connectionString,
      clientOptions: { ...databaseClientOptionsFromEnv(), maxConnections: this.#settings.poolMax, applicationName: slot.applicationName },
      control: this.#control.buffer,
    };
    const { url, source } = writerThreadEntry();
    const worker = source
      ? new Worker(`import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}).then(({ tsImport }) => tsImport(${
        JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)}));`, { eval: true, workerData, env: SHARE_ENV })
      : new Worker(url, { workerData, env: SHARE_ENV });
    slot.worker = worker;
    slot.bootTimer = setTimeout(() => { void this.#lose(slot, worker, "timeout"); }, this.#settings.timeoutMs + 10_000);
    const applicationName = slot.applicationName;
    worker.on("message", (reply: WriterThreadReply) => {
      if (slot.worker !== worker) return;
      if (reply.kind === "ready") {
        slot.ready = true;
        if (slot.bootTimer) clearTimeout(slot.bootTimer);
        slot.bootTimer = null;
        for (const pending of slot.pending.values()) if (!pending.timer) this.#arm(slot, worker, pending);
        void this.#verifyFenceable(slot, worker, applicationName);
        return;
      }
      const pending = slot.pending.get(reply.id);
      if (!pending) return;
      slot.pending.delete(reply.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (reply.kind === "saved") {
        this.#stats.completed += 1;
        pending.resolve({ owned: reply.owned, written: reply.written });
      } else if (reply.kind === "refused") {
        this.#stats.failed += 1;
        pending.reject(new WriterThreadsClosedError(reply.reason));
      } else {
        this.#stats.failed += 1;
        pending.reject(Object.assign(new Error(reply.error.message), { name: reply.error.name, code: reply.error.code }));
      }
    });
    worker.on("error", () => {});
    worker.on("exit", () => { if (slot.worker === worker) void this.#lose(slot, worker, "exit"); });
    worker.unref();
    return worker;
  }

  async #verifyFenceable(slot: Slot, worker: Worker, applicationName: string): Promise<void> {
    try {
      const [row] = await this.#db.$client.unsafe<{ visible: number }[]>(
        "select count(*)::int as visible from pg_stat_activity where application_name = $1", [applicationName]);
      if (slot.worker === worker && (row?.visible ?? 0) > 0) slot.verified = true;
    } catch {}
  }

  async #lose(slot: Slot, worker: Worker, reason: "exit" | "timeout"): Promise<void> {
    if (slot.worker !== worker) return;
    slot.worker = null;
    this.#stats.lost += 1;
    if (slot.bootTimer) clearTimeout(slot.bootTimer);
    slot.bootTimer = null;
    const pending = [...slot.pending.values()];
    slot.pending.clear();
    for (const request of pending) if (request.timer) clearTimeout(request.timer);
    const verified = slot.verified;
    let release!: () => void;
    slot.fence = new Promise(resolve => { release = resolve; });
    let fenced = false;
    try {
      await Promise.race([worker.terminate().catch(() => undefined), new Promise(resolve => setTimeout(resolve, FENCE_DEADLINE_MS).unref())]);
      fenced = verified && await this.#fenceBackends(slot.applicationName);
    } finally {
      for (const request of pending) request.reject(new WriterThreadUnavailableError(fenced, reason));
      slot.fence = null;
      release();
    }
  }

  async #fenceBackends(applicationName: string): Promise<boolean> {
    const deadline = Date.now() + FENCE_DEADLINE_MS;
    while (Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const rows = await Promise.race([
          this.#db.$client.unsafe<{ pid: number }[]>(
            `select pid, pg_terminate_backend(pid) as terminated from pg_stat_activity
             where application_name = $1 and pid <> pg_backend_pid()`, [applicationName]),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); }),
        ]);
        if (rows === null) return false;
        if (rows.length === 0) return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
  }

  async close(budgetMs: number): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const inFlight = this.#slots.flatMap(slot => [...slot.pending.values()].map(pending => new Promise<void>(resolve => {
      const { resolve: done, reject: failed } = pending;
      pending.resolve = value => { resolve(); done(value); };
      pending.reject = error => { resolve(); failed(error); };
    })));
    const fences = this.#slots.flatMap(slot => slot.fence ? [slot.fence] : []);
    await Promise.race([Promise.all([...inFlight, ...fences]), new Promise(resolve => setTimeout(resolve, budgetMs).unref())]);
    Atomics.store(this.#control, 0, 1);
    await Promise.all(this.#slots.flatMap(slot => slot.fence ? [slot.fence] : []));
    await Promise.all(this.#slots.map(async slot => {
      const worker = slot.worker;
      if (!worker) return;
      slot.worker = null;
      if (slot.bootTimer) clearTimeout(slot.bootTimer);
      slot.bootTimer = null;
      const pending = [...slot.pending.values()];
      slot.pending.clear();
      const exited = new Promise<void>(resolve => worker.once("exit", () => resolve()));
      worker.postMessage({ kind: "close" } satisfies WriterThreadRequest);
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2_000).unref())]);
      await worker.terminate().catch(() => undefined);
      if (slot.verified) await this.#fenceBackends(slot.applicationName);
      for (const request of pending) {
        if (request.timer) clearTimeout(request.timer);
        request.reject(new WriterThreadsClosedError("closed"));
      }
    }));
  }

  workerForTests(index: number): Worker | null {
    return this.#slots[index]?.worker ?? null;
  }

  partitionForTests(run: string): number {
    return partition(run, this.#slots.length);
  }
}

const installed = new WeakMap<object, WriterThreads>();

export function writerThreadsFor(db: object): WriterThreads | undefined {
  return installed.get(db);
}

export function installWriterThreads(db: Db, connectionString: string, settings: WriterThreadSettings): WriterThreads | null {
  if (settings.threads <= 0) return null;
  if (installed.has(db)) throw new Error("writer_threads_already_installed");
  const threads = new WriterThreads(db, connectionString, settings);
  installed.set(db, threads);
  return threads;
}

export async function closeWriterThreads(db: object, budgetMs: number): Promise<void> {
  await installed.get(db)?.close(budgetMs);
}
