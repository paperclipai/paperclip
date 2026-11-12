import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { isTransientStorageError, retainedUiAssets } from "../retained-ui-assets.js";
import type { StorageProvider } from "../storage/types.js";
import { staticUiFiles } from "../middleware/static-ui.js";
import { idleAdmissionMiddleware, trackIdleRequestHandlers } from "../middleware/idle-admission.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "retained-ui-")); roots.push(root); return root; }
function storage() {
  const objects = new Map<string, Buffer>();
  const provider: StorageProvider = {
    id: "s3", putObject: async () => { throw new Error("Expected conditional publication"); },
    async putObjectConditional(input) {
      if (objects.has(input.objectKey)) throw new Error("Precondition failed");
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      objects.set(input.objectKey, Buffer.concat(chunks)); return { etag: '"fixture-etag"' };
    },
    async getObject(input) {
      const bytes = objects.get(input.objectKey);
      if (!bytes) throw Object.assign(new Error("Object missing"), { status: 404 });
      return { stream: Readable.from([bytes]), contentLength: bytes.length, etag: '"fixture-etag"' };
    },
    async headObject(input) { return { exists: objects.has(input.objectKey) }; },
    async deleteObject(input) { objects.delete(input.objectKey); },
  };
  return { provider, objects };
}

it("serves an old tab's lazy chunk from shared storage after removing its entire old build", async () => {
  const a = await directory(), b = await directory(), { provider } = storage();
  await fs.writeFile(path.join(a, "lazy-oldhash.js"), "export const revision = 'A';");
  const retained = retainedUiAssets(provider);
  await retained.publish(a);
  await retained.publish(a); // Concurrent/new same-image boots do not rewrite bytes.
  await fs.rm(a, { recursive: true });
  await fs.writeFile(path.join(b, "lazy-newhash.js"), "export const revision = 'B';");
  await retained.publish(b);
  const app = express(), before = idleWorkSnapshot().active;
  app.use(idleAdmissionMiddleware);
  app.use("/assets", staticUiFiles(b), retained.serve);
  trackIdleRequestHandlers(app);
  await request(app).get("/assets/lazy-oldhash.js").expect(200).expect("Content-Type", /javascript/)
    .expect("Cache-Control", /immutable/).expect("export const revision = 'A';");
  await request(app).get("/assets/lazy-newhash.js").expect(200).expect("export const revision = 'B';");
  await request(app).head("/assets/lazy-oldhash.js").expect(200);
  await request(app).get("/assets/missing.js").expect(404);
  await request(app).get("/assets/%2e%2e%2fsecrets").expect(404);
  expect(idleWorkSnapshot().active).toBe(before);
});

it("refuses a build which reuses a published name for different bytes", async () => {
  const root = await directory(), { provider, objects } = storage();
  const retained = retainedUiAssets(provider);
  await fs.writeFile(path.join(root, "chunk-hash.js"), "original");
  await retained.publish(root);
  await fs.writeFile(path.join(root, "chunk-hash.js"), "collision");
  await expect(retained.publish(root)).rejects.toThrow("collides");
  expect(objects.get("ui-assets/v1/chunk-hash.js")?.toString()).toBe("original");
});

// Staging, 2026-11-11: the bucket answered "SlowDown" (HTTP 503) while a new
// release published its assets. The stream body could not be replayed, the
// error escaped, and every start of the server exited within a minute.
it("retries an asset the storage throttled instead of failing the publication", async () => {
  const root = await directory(), { provider, objects } = storage();
  await fs.writeFile(path.join(root, "chunk-a.js"), "alpha");
  await fs.writeFile(path.join(root, "chunk-b.js"), "beta");
  const slowDown = () => Object.assign(new Error("Please reduce your request rate."), { name: "SlowDown", Code: "SlowDown", $metadata: { httpStatusCode: 503 } });
  const put = provider.putObjectConditional!.bind(provider);
  let refusals = 3;
  provider.putObjectConditional = async input => {
    if (refusals > 0) { refusals--; for await (const _chunk of input.body) { /* drain as a real client would */ } throw slowDown(); }
    return put(input);
  };
  const waits: number[] = [];
  await retainedUiAssets(provider, { sleep: async ms => { waits.push(ms); } }).publish(root);
  expect(waits).toEqual([500, 1_000, 2_000]);
  expect(objects.get("ui-assets/v1/chunk-a.js")?.toString()).toBe("alpha");
  expect(objects.get("ui-assets/v1/chunk-b.js")?.toString()).toBe("beta");
});

it("gives up on storage that stays throttled, and reports it as a storage outage rather than a bad build", async () => {
  const root = await directory(), { provider } = storage();
  await fs.writeFile(path.join(root, "chunk-a.js"), "alpha");
  provider.putObjectConditional = async () => { throw Object.assign(new Error("Please reduce your request rate."), { name: "SlowDown", $metadata: { httpStatusCode: 503 } }); };
  const waits: number[] = [];
  const failure = await retainedUiAssets(provider, { sleep: async ms => { waits.push(ms); } }).publish(root).catch(error => error);
  expect(waits).toHaveLength(7);
  expect(isTransientStorageError(failure)).toBe(true);
  expect(isTransientStorageError(new Error("Static build asset name collides with different published bytes"))).toBe(false);
});
