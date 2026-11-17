/** Shared UI asset publication at startup, against storage with a fixed
 * round-trip latency. Local and synthetic; never targets real storage.
 * Run with pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-retained-ui-assets.ts
 * Options (env): RETAINED_UI_BENCH_ASSETS (default 400), RETAINED_UI_BENCH_RTT_MS (default 25),
 * RETAINED_UI_BENCH_MAX_MS: fail when the default re-publication exceeds this budget. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { RETAINED_UI_ASSET_PUBLISH_CONCURRENCY, retainedUiAssets } from "../server/src/retained-ui-assets.js";
import type { StorageProvider } from "../server/src/storage/types.js";

const assets = Number(process.env.RETAINED_UI_BENCH_ASSETS ?? 400);
const rttMs = Number(process.env.RETAINED_UI_BENCH_RTT_MS ?? 25);
const budgetMs = process.env.RETAINED_UI_BENCH_MAX_MS ? Number(process.env.RETAINED_UI_BENCH_MAX_MS) : null;

function latencyStorage() {
  const objects = new Map<string, Buffer>();
  let requests = 0, streamBodies = 0;
  const roundTrip = () => { requests++; return new Promise(resolve => setTimeout(resolve, rttMs)); };
  const provider: StorageProvider = {
    id: "s3",
    putObject: async () => { throw new Error("Expected conditional publication"); },
    async putObjectConditional(input) {
      await roundTrip();
      if (!Buffer.isBuffer(input.body)) streamBodies++;
      if (objects.has(input.objectKey)) throw Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
      const chunks: Buffer[] = [];
      if (Buffer.isBuffer(input.body)) chunks.push(input.body);
      else for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      objects.set(input.objectKey, Buffer.concat(chunks));
      return { etag: '"bench"' };
    },
    async getObject(input) {
      await roundTrip();
      const bytes = objects.get(input.objectKey);
      if (!bytes) throw Object.assign(new Error("Object missing"), { status: 404 });
      return { stream: Readable.from([bytes]), contentLength: bytes.length, etag: '"bench"' };
    },
    async headObject(input) { await roundTrip(); return { exists: objects.has(input.objectKey) }; },
    async deleteObject(input) { objects.delete(input.objectKey); },
  };
  return { provider, stats: () => ({ requests, streamBodies }), reset: () => { requests = 0; streamBodies = 0; } };
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "retained-ui-bench-"));
try {
  for (let index = 0; index < assets; index++) {
    await fs.writeFile(path.join(directory, `chunk-${index}.${index.toString(16)}.js`), `export const chunk${index} = ${JSON.stringify("x".repeat(2_000 + (index % 50) * 400))};\n`);
  }
  const results: Record<string, unknown>[] = [];
  for (const concurrency of [1, RETAINED_UI_ASSET_PUBLISH_CONCURRENCY]) {
    const storage = latencyStorage();
    const retained = retainedUiAssets(storage.provider, { concurrency });
    for (const scenario of ["first_publish", "restart_republish"] as const) {
      storage.reset();
      const started = performance.now();
      await retained.publish(directory);
      results.push({ concurrency, scenario, ms: Math.round(performance.now() - started), ...storage.stats() });
    }
  }
  console.table(results);
  const restart = results.find(row => row.concurrency === RETAINED_UI_ASSET_PUBLISH_CONCURRENCY && row.scenario === "restart_republish")!;
  assert.equal(restart.streamBodies, 0, "publication must send replayable Buffer bodies");
  if (budgetMs !== null) assert.ok((restart.ms as number) <= budgetMs, `restart re-publication took ${restart.ms} ms, over the ${budgetMs} ms budget`);
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
