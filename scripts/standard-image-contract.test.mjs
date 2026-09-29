import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { standardImageDigest, resolveStandardImageDigest } from "./standard-image-contract.mjs";
const descriptor = architecture => ({ platform: { os: "linux", architecture }, digest: `sha256:${"a".repeat(64)}`, size: 100 });
const index = manifests => Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests }));
test("signs the exact registry bytes, including both supported platforms", () => {
  const bytes = index([descriptor("amd64"), descriptor("arm64")]);
  assert.equal(standardImageDigest(bytes), `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
});
test("rejects incomplete, ambiguous, or malformed platform manifests", () => {
  for (const manifests of [[descriptor("amd64")], [descriptor("amd64"), descriptor("amd64"), descriptor("arm64")],
    [{ ...descriptor("amd64"), digest: "mutable-tag" }, descriptor("arm64")],
    [{ ...descriptor("amd64"), size: -1 }, descriptor("arm64")]]) assert.throws(() => standardImageDigest(index(manifests)));
});


test("lookup hashes registry bytes and rejects formatting or header mismatches", async () => {
  const raw = index([descriptor("amd64"), descriptor("arm64")]);
  const expected = standardImageDigest(raw);
  let appendNewline = false;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, "error");
    if (url.includes("/token?")) return Response.json({ token: "public-fixture" });
    assert.ok(url.endsWith(`sha-${"a".repeat(40)}`));
    assert.equal(options.headers.authorization, "Bearer public-fixture");
    return new Response(appendNewline ? Buffer.concat([raw, Buffer.from("\n")]) : raw, { headers: { "docker-content-digest": expected } });
  };
  assert.equal(await resolveStandardImageDigest("a".repeat(40), fetchImpl), expected);
  appendNewline = true;
  await assert.rejects(resolveStandardImageDigest("a".repeat(40), fetchImpl), /Registry digest/);
});


test("bounded retries cover token failures, propagation lag and rate limits", async () => {
  const raw = index([descriptor("amd64"), descriptor("arm64")]);
  const expected = standardImageDigest(raw);
  const waits = [];
  let tokens = 0, manifests = 0;
  const fetchImpl = async url => {
    if (url.includes("/token?")) {
      if (++tokens === 1) throw new Error("transient connection reset");
      if (tokens === 2) return new Response(null, { status: 503 });
      return Response.json({ token: "public-fixture" });
    }
    if (++manifests === 1) return new Response(null, { status: 404 });
    if (manifests === 2) return new Response(null, { status: 429, headers: { "retry-after": "120" } });
    return new Response(raw, { headers: { "docker-content-digest": expected } });
  };
  assert.equal(await resolveStandardImageDigest("a".repeat(40), fetchImpl, { sleep: async ms => { waits.push(ms); } }), expected);
  assert.deepEqual(waits, [1000, 2000, 1000, 30000]);
  assert.equal(tokens, 3); assert.equal(manifests, 3);
});

test("permanent registry errors fail immediately and transient errors exhaust a finite budget", async () => {
  for (const [status, expectedCalls] of [[401, 1], [403, 1], [503, 5]]) {
    let calls = 0;
    await assert.rejects(resolveStandardImageDigest("a".repeat(40), async () => { calls++; return new Response(null, { status }); }, { sleep: async () => {} }), /Registry lookup failed/);
    assert.equal(calls, expectedCalls);
  }
});
