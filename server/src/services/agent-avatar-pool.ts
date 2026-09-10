import { Worker } from "node:worker_threads";
import type { AgentAvatarRequest } from "./agent-avatars.js";

type Job = { request: AgentAvatarRequest; resolve: (png: Buffer) => void; reject: (error: Error) => void };
/** Lazy, bounded workers isolate geometry/rasterization from the API event loop. */
export function createAgentAvatarPool(concurrency = 2, maxQueue = 64) {
  const queue: Job[] = [];
  let active = 0;
  const idle: Worker[] = [];
  const timers = new Map<Worker, ReturnType<typeof setTimeout>>();
  const workers = new Set<Worker>();
  let closed = false;
  function spawn() {
    const source = new URL(import.meta.url).pathname.endsWith(".ts");
    const url = new URL(source ? "./agent-avatar-worker.ts" : "./agent-avatar-worker.js", import.meta.url);
    const worker = source
      ? new Worker(`import(${JSON.stringify(import.meta.resolve('tsx/esm/api'))}).then(({tsImport}) => tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)}));`, { eval: true })
      : new Worker(url);
    workers.add(worker);
    // Idle worker failures must not become uncaught events or leave dead slots.
    worker.on("error", () => {});
    worker.on("exit", () => {
      const index = idle.indexOf(worker);
      if (index >= 0) idle.splice(index, 1);
      clearTimeout(timers.get(worker)); timers.delete(worker); workers.delete(worker);
    });
    return worker;
  }
  function drain() {
    while (!closed && active < concurrency && queue.length) {
      const job = queue.shift()!;
      let worker: Worker;
      try { worker = idle.pop() ?? spawn(); }
      catch (error) { job.reject(error instanceof Error ? error : new Error(String(error))); continue; }
      clearTimeout(timers.get(worker)); timers.delete(worker);
      worker.ref(); active++;
      let finished = false;
      const timeout = setTimeout(() => finish(new Error("Avatar rendering timed out")), 15_000);
      const onError = (error: Error) => finish(error);
      const onExit = () => finish(new Error("Avatar worker exited"));
      const onMessage = (result: { png?: Uint8Array; error?: string }) => {
        finish(result.png ? undefined : new Error(result.error ?? "Avatar rendering failed"), result.png);
      };
      function finish(error?: Error, png?: Uint8Array) {
        if (finished) return;
        finished = true; clearTimeout(timeout); active--;
        worker.off("message", onMessage); worker.off("error", onError); worker.off("exit", onExit);
        if (error || closed) {
          workers.delete(worker); void worker.terminate();
          job.reject(error ?? new Error("Avatar pool closed"));
        } else {
          job.resolve(Buffer.from(png!));
          worker.unref(); idle.push(worker);
          const timer = setTimeout(() => {
            const index = idle.indexOf(worker);
            if (index >= 0) idle.splice(index, 1);
            timers.delete(worker); workers.delete(worker); void worker.terminate();
          }, 30_000);
          timer.unref(); timers.set(worker, timer);
        }
        drain();
      }
      worker.once("message", onMessage); worker.once("error", onError); worker.once("exit", onExit);
      try { worker.postMessage(job.request); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    }
  }
  return {
    render(request: AgentAvatarRequest): Promise<Buffer> {
      if (closed || queue.length >= maxQueue) return Promise.reject(new Error("Avatar renderer is busy"));
      return new Promise((resolve, reject) => { queue.push({ request, resolve, reject }); drain(); });
    },
    async close() {
      closed = true;
      for (const job of queue.splice(0)) job.reject(new Error("Avatar pool closed"));
      for (const timer of timers.values()) clearTimeout(timer);
      await Promise.all([...workers].map(worker => worker.terminate()));
    },
  };
}
