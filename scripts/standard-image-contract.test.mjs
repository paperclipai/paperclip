import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { standardImageDigest, resolveStandardImageDigest, verifiedImageDigests, assertIndexUsesVerifiedImages } from "./standard-image-contract.mjs";
import { isNode24ImageTag } from "./node-image-policy.mjs";

test("Node image policy accepts Node 24 major tags and exact security pins", () => {
  for (const tag of ["24-trixie-slim", "24-bookworm-slim", "24-alpine3.23", "24.11.0-bookworm", "24.21.0-bookworm",
    `24.21.0-bookworm@sha256:${"a".repeat(64)}`, `24-bookworm@sha256:${"0".repeat(64)}`]) {
    assert.equal(isNode24ImageTag(tag), true, tag);
  }
});

test("Node image policy rejects other majors, partial versions and malformed pins", () => {
  for (const tag of ["240-bookworm", "25.21.0-bookworm", "v24.21.0-bookworm", "latest",
    "24.0.0-bookworm", "24.10.0-bookworm", "24.10.99-bookworm",
    "24.21-bookworm", "24.21.0", "24.21.0-", "24..21.0-bookworm", "24.021.0-bookworm",
    "24.21.0-bookworm@sha256:short", `24.21.0-bookworm@@sha256:${"a".repeat(64)}`,
    `24.21.0-bookworm@sha256:${"a".repeat(64)}junk`, "${NODE_VERSION}-bookworm", "24-$(whoami)"]) {
    assert.equal(isNode24ImageTag(tag), false, tag);
  }
});
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

test("optional lookup falls back only for a missing manifest", async () => {
  for (const status of [401, 403, 404, 503]) {
    let calls = 0;
    const lookup = resolveStandardImageDigest("a".repeat(40), async url => {
      if (url.includes("/token?")) return Response.json({ token: "public-fixture" });
      calls++;
      return new Response(null, { status });
    }, { missing: "return-null", sleep: async () => {} });
    if (status === 404) assert.equal(await lookup, null);
    else await assert.rejects(lookup, /Registry lookup failed/);
    assert.equal(calls, status === 503 ? 5 : 1);
  }
});

const digestOf = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const image = name => Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", name }));
// The build legs push by digest with provenance, so each leg digest is an index
// of one platform image plus its attestation manifest. The merged standard
// index names those same child digests.
function legFixture() {
  const amd64 = digestOf(image("amd64")), arm64 = digestOf(image("arm64"));
  const attestation = arch => ({ platform: { os: "unknown", architecture: "unknown" }, digest: digestOf(image(`att-${arch}`)), size: 50,
    annotations: { "vnd.docker.reference.type": "attestation-manifest" } });
  const leg = (arch, digest) => index([{ platform: { os: "linux", architecture: arch }, digest, size: 100 }, attestation(arch)]);
  const legs = new Map([[digestOf(leg("amd64", amd64)), leg("amd64", amd64)], [digestOf(leg("arm64", arm64)), leg("arm64", arm64)]]);
  const standard = index([{ platform: { os: "linux", architecture: "arm64" }, digest: arm64, size: 100 }, attestation("arm64"),
    { platform: { os: "linux", architecture: "amd64" }, digest: amd64, size: 100 }, attestation("amd64")]);
  return { amd64, legs, standard };
}

test("signing requires every Linux image in the index to have passed a build-leg probe", () => {
  const { amd64, legs, standard } = legFixture();
  assert.doesNotThrow(() => assertIndexUsesVerifiedImages(standard, verifiedImageDigests(legs)));
  const onlyArm = new Map([...legs].filter(([, bytes]) => !bytes.toString().includes(amd64)));
  assert.throws(() => assertIndexUsesVerifiedImages(standard, verifiedImageDigests(onlyArm)), /linux\/amd64 image .* orphan-reaping probe/);
  // A leg that pushed a bare image manifest verifies exactly that digest.
  const bare = image("amd64");
  assert.deepEqual([...verifiedImageDigests(new Map([[digestOf(bare), bare]]))], [digestOf(bare)]);
  // Bytes must hash to the digest the leg reported.
  assert.throws(() => verifiedImageDigests(new Map([[digestOf(bare), image("other")]])), /do not match their digest/);
});

test("lookup with verified digests reads each leg by digest and rejects an unprobed index", async () => {
  const { legs, standard } = legFixture();
  const expected = standardImageDigest(standard);
  const requested = [];
  const fetchImpl = async (url, options) => {
    if (url.includes("/token?")) return Response.json({ token: "public-fixture" });
    const reference = url.split("/manifests/")[1];
    requested.push(reference);
    if (reference.startsWith("sha-")) return new Response(standard, { headers: { "docker-content-digest": expected } });
    assert.match(options.headers.accept, /image\.manifest\.v1\+json/);
    return new Response(legs.get(reference), { headers: { "docker-content-digest": reference } });
  };
  const legDigests = [...legs.keys()];
  assert.equal(await resolveStandardImageDigest("a".repeat(40), fetchImpl, { verifiedDigests: legDigests }), expected);
  assert.deepEqual(requested, [`sha-${"a".repeat(40)}`, ...legDigests]);
  await assert.rejects(resolveStandardImageDigest("a".repeat(40), fetchImpl, { verifiedDigests: legDigests.slice(0, 1) }), /orphan-reaping probe/);
  await assert.rejects(resolveStandardImageDigest("a".repeat(40), fetchImpl, { verifiedDigests: [] }), /No build leg/);
});
