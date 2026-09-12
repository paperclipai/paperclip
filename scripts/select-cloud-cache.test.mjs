import assert from "node:assert/strict";
import test from "node:test";
import { cloudCacheCandidates, selectCloudCache } from "./select-cloud-cache.mjs";

const image = "ghcr.io/paperclipai/paperclip";
const commits = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
const candidates = cloudCacheCandidates(image, commits);

test("a same-SHA rerun imports only its existing cache", async () => {
  const inspected = [];
  const source = await selectCloudCache(image, commits, {
    exists: async (ref) => { inspected.push(ref); return true; }, log() {},
  });
  assert.equal(source, `type=registry,ref=${candidates[0]}`);
  assert.deepEqual(inspected, candidates.slice(0, 1));
});

test("a new merge imports only its nearest available ancestor", async () => {
  const inspected = [];
  const source = await selectCloudCache(image, commits, {
    exists: async (ref) => { inspected.push(ref); return ref === candidates[1]; }, log() {},
  });
  assert.equal(source, `type=registry,ref=${candidates[1]}`);
  assert.deepEqual(inspected, candidates.slice(0, 2));
  assert.equal(source.includes("\n"), false);
});

test("a still-building parent falls back to an older completed cache", async () => {
  assert.equal(await selectCloudCache(image, commits, {
    exists: async (ref) => ref === candidates[2], log() {},
  }), `type=registry,ref=${candidates[2]}`);
});

test("the legacy cache is used only if no SHA cache exists", async () => {
  const inspected = [];
  assert.equal(await selectCloudCache(image, commits, {
    exists: async (ref) => { inspected.push(ref); return ref === candidates.at(-1); }, log() {},
  }), `type=registry,ref=${candidates.at(-1)}`);
  assert.deepEqual(inspected, candidates);
});

test("missing caches permit a cold build", async () => {
  assert.equal(await selectCloudCache(image, commits, { exists: async () => false, log() {} }), "");
});

test("a failed lookup can fall back without failing image publication", async () => {
  const messages = [];
  assert.equal(await selectCloudCache(image, commits, {
    exists: async (ref) => {
      if (ref === candidates[0]) throw new Error("registry temporarily unavailable");
      return true;
    },
    log: (message) => messages.push(message),
  }), `type=registry,ref=${candidates[1]}`);
  assert.match(messages[0], /Could not inspect cloud cache/);
});

test("ancestry is bounded, deduplicated, and rejects output injection", () => {
  const many = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(40, "0"));
  assert.equal(cloudCacheCandidates(image, many).length, 11);
  assert.deepEqual(cloudCacheCandidates(image, [commits[0], commits[0]]), [candidates[0], candidates.at(-1)]);
  assert.throws(() => cloudCacheCandidates(`${image}\nsource=untrusted`, commits));
  assert.throws(() => cloudCacheCandidates(image, ["master"]));
  assert.throws(() => cloudCacheCandidates(image, []));
});
