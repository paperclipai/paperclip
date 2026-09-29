import { Worker } from "node:worker_threads";
import type { LegacyJsonCursor, LegacyJsonPage } from "./legacy-json-scanner.js";
export type { LegacyJsonCursor, LegacyJsonPage, LegacyJsonEntry } from "./legacy-json-scanner.js";

/** One bounded page at a time. Import has no whole-job deadline; an interrupted
 * caller resumes at its last transactionally committed source cursor. */
export class LegacyJsonReader {
  private readonly worker: Worker;
  private pending: { resolve(page: LegacyJsonPage): void; reject(error: Error): void } | null = null;
  private failure: Error | null = null;
  constructor(private readonly path: string) {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    this.worker = new Worker(new URL(`./legacy-json-worker.${extension}`, import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
    this.worker.on("message", (result: { page?: LegacyJsonPage; error?: string }) => {
      const pending = this.pending; this.pending = null;
      if (!pending) return;
      if (result.error || !result.page) pending.reject(new Error(result.error ?? "missing legacy import page"));
      else pending.resolve(result.page);
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", () => this.fail(new Error("legacy import reader exited")));
  }
  private fail(error: Error): void { this.failure ??= error; this.pending?.reject(this.failure); this.pending = null; }
  page(source: string | null, cursor: LegacyJsonCursor | null): Promise<LegacyJsonPage> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error("legacy import already has a pending page"));
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; this.worker.postMessage({ path: this.path, source, cursor }); });
  }
  async close(): Promise<void> { await this.worker.terminate(); }
}
