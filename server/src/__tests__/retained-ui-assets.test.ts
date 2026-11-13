import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { isTransientStorageError, publishRetainedUiAssetsAtStartup, retainedUiAssets } from "../retained-ui-assets.js";
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
      if (!Buffer.isBuffer(input.body)) throw new Error("Expected a replayable Buffer body");
      objects.set(input.objectKey, Buffer.from(input.body)); return { etag: '"fixture-etag"' };
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
    if (refusals > 0) { refusals--; throw slowDown(); }
    return put(input);
  };
  const waits: number[] = [];
  await retainedUiAssets(provider, { sleep: async ms => { waits.push(ms); }, concurrency: 1 }).publish(root);
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

it("starts on local files when storage stays unavailable, and still refuses a build that collides", async () => {
  const root = await directory(), { provider } = storage();
  await fs.writeFile(path.join(root, "chunk-a.js"), "alpha");
  const put = provider.putObjectConditional!.bind(provider);
  provider.putObjectConditional = async () => { throw Object.assign(new Error("socket hang up"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); };
  const retained = retainedUiAssets(provider, { sleep: async () => {} });
  const reported: unknown[] = [];
  await expect(publishRetainedUiAssetsAtStartup(retained, root, error => { reported.push(error); })).resolves.toBe(false);
  expect(reported).toHaveLength(1);
  // The server that started anyway serves the build from its own disk, and asks storage for nothing it lacks.
  const app = express();
  app.use("/assets", staticUiFiles(root), retained.serve);
  await request(app).get("/assets/chunk-a.js").expect(200).expect("alpha");
  await request(app).get("/assets/never-built.js").expect(404);
  // Once storage answers, a published name with different bytes is a bad build, not an outage.
  provider.putObjectConditional = put;
  await expect(publishRetainedUiAssetsAtStartup(retained, root, () => {})).resolves.toBe(true);
  await fs.writeFile(path.join(root, "chunk-a.js"), "collision");
  await expect(publishRetainedUiAssetsAtStartup(retained, root, error => { reported.push(error); })).rejects.toThrow("collides");
  expect(reported).toHaveLength(1);
});

it("retries an existing asset whose saved bytes storage could not serve, without accepting it unverified", async () => {
  const root = await directory(), { provider } = storage();
  await fs.writeFile(path.join(root, "chunk-a.js"), "alpha");
  const waits: number[] = [];
  const retained = retainedUiAssets(provider, { sleep: async ms => { waits.push(ms); } });
  await retained.publish(root);
  // A restart: the conditional write answers 412 and the verifying read is throttled twice.
  const get = provider.getObject.bind(provider);
  let refusals = 2, reads = 0;
  provider.getObject = async input => {
    reads++;
    if (refusals > 0) { refusals--; throw Object.assign(new Error("Please reduce your request rate."), { name: "SlowDown", $metadata: { httpStatusCode: 503 } }); }
    return get(input);
  };
  await retained.publish(root);
  expect(waits).toEqual([500, 1_000]);
  expect(reads).toBe(3);
  // A deadline on the asset is an outage too; a read that says the object is gone is not.
  expect(isTransientStorageError(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))).toBe(true);
  expect(isTransientStorageError(Object.assign(new Error("Object missing"), { status: 404 }))).toBe(false);
});

// Staging, 2026-11-11: a busy workspace took 85 s to bind its listener. Its
// restart re-published several hundred already-published assets one at a time
// (a refused conditional write, then a verifying read, per asset), and each
// refused stream upload logged "An error was encountered in a non-retryable
// streaming request." Publication now sends replayable Buffer bodies and keeps
// a bounded number of assets in flight.
it("re-publishes an already-published build with bounded parallel, replayable writes", async () => {
  const root = await directory(), { provider } = storage();
  for (let index = 0; index < 40; index++) await fs.writeFile(path.join(root, `chunk-${index}.js`), `export const n = ${index};`);
  await retainedUiAssets(provider).publish(root);
  const put = provider.putObjectConditional!.bind(provider), get = provider.getObject.bind(provider);
  let inFlight = 0, peak = 0, streamBodies = 0;
  const latency = async <T,>(work: () => Promise<T>) => {
    inFlight++; peak = Math.max(peak, inFlight);
    try { await new Promise(resolve => setTimeout(resolve, 5)); return await work(); } finally { inFlight--; }
  };
  provider.putObjectConditional = input => { if (!Buffer.isBuffer(input.body)) streamBodies++; return latency(() => put(input)); };
  provider.getObject = input => latency(() => get(input));
  await retainedUiAssets(provider).publish(root);
  expect(streamBodies).toBe(0);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
});

it("refuses a colliding build even when another asset's storage outage fails first", async () => {
  const root = await directory(), { provider, objects } = storage();
  await fs.writeFile(path.join(root, "chunk-a.js"), "alpha");
  await fs.writeFile(path.join(root, "chunk-b.js"), "beta");
  objects.set("ui-assets/v1/chunk-b.js", Buffer.from("different bytes"));
  const put = provider.putObjectConditional!.bind(provider), get = provider.getObject.bind(provider);
  provider.putObjectConditional = async input => {
    if (input.objectKey.endsWith("chunk-a.js")) throw Object.assign(new Error("Please reduce your request rate."), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
    return put(input);
  };
  // The collision is found only after the outage on chunk-a has exhausted its retries.
  provider.getObject = async input => {
    if (input.objectKey.endsWith("chunk-b.js")) await new Promise(resolve => setTimeout(resolve, 100));
    return get(input);
  };
  const retained = retainedUiAssets(provider, { sleep: async () => {}, concurrency: 2 });
  await expect(publishRetainedUiAssetsAtStartup(retained, root, () => {})).rejects.toThrow("collides");
});

it("stops starting new assets after one collides, and still refuses the build", async () => {
  const root = await directory(), { provider, objects } = storage();
  for (let index = 0; index < 30; index++) await fs.writeFile(path.join(root, `chunk-${String(index).padStart(2, "0")}.js`), `v${index}`);
  objects.set("ui-assets/v1/chunk-00.js", Buffer.from("different bytes"));
  let writes = 0;
  const put = provider.putObjectConditional!.bind(provider);
  provider.putObjectConditional = input => { writes++; return put(input); };
  await expect(retainedUiAssets(provider, { concurrency: 2 }).publish(root)).rejects.toThrow("collides");
  expect(writes).toBeLessThan(30);
});
