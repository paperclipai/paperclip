import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const indexMediaTypes = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Validate the multi-platform index before it becomes a signed build contract. */
export function standardImageDigest(bytes) {
  const index = JSON.parse(bytes.toString("utf8"));
  assert.equal(index.schemaVersion, 2);
  assert.ok(indexMediaTypes.includes(index.mediaType));
  assert.ok(Array.isArray(index.manifests));
  for (const architecture of ["amd64", "arm64"]) {
    const matches = index.manifests.filter(item => item.platform?.os === "linux" && item.platform?.architecture === architecture);
    assert.equal(matches.length, 1, `Expected exactly one linux/${architecture} image`);
    assert.match(matches[0].digest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(matches[0].size) && matches[0].size > 0);
  }
  return sha256(bytes);
}

/**
 * Platform image digests covered by the build legs' native PID 1 probe. Each
 * leg probes the digest it pushed; that is a per-leg index (image plus
 * provenance) or, without provenance, the image manifest itself. `legs` maps
 * each probed digest to its registry bytes.
 */
export function verifiedImageDigests(legs) {
  const verified = new Set();
  for (const [digest, bytes] of legs) {
    assert.match(digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(sha256(bytes), digest, "Verified image bytes do not match their digest");
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (!indexMediaTypes.includes(manifest.mediaType)) { verified.add(digest); continue; }
    for (const item of manifest.manifests ?? []) {
      if (item.platform?.os === "linux" && /^sha256:[a-f0-9]{64}$/.test(item.digest ?? "")) verified.add(item.digest);
    }
  }
  return verified;
}

/** Sign only an index whose every Linux image passed the build-leg probe. */
export function assertIndexUsesVerifiedImages(indexBytes, verified) {
  standardImageDigest(indexBytes);
  const index = JSON.parse(indexBytes.toString("utf8"));
  for (const item of index.manifests.filter(entry => entry.platform?.os === "linux")) {
    assert.ok(verified.has(item.digest),
      `linux/${item.platform.architecture} image ${item.digest} did not pass the build-leg orphan-reaping probe`);
  }
}

/** Read registry bytes directly; CLI stdout formatting is not artifact content. */
export async function resolveStandardImageDigest(sha, fetchImpl = fetch, {
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  missing = "error",
  verifiedDigests,
} = {}) {
  assert.match(sha ?? "", /^[a-f0-9]{40}$/);
  const request = async (url, headers, consume, allowNotFound = false) => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        if (attempt === 5) throw error;
        await sleep(attempt * 1000);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (allowNotFound && response.status === 404 && missing === "return-null") return null;
        const transient = [408, 425, 429].includes(response.status) || response.status >= 500 || (allowNotFound && response.status === 404);
        assert.ok(transient && attempt < 5, `Registry lookup failed: HTTP ${response.status}`);
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Math.min(30_000, Math.max(attempt * 1000, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)));
        continue;
      }
      try { return await consume(response); }
      catch (error) {
        // Interrupted response bodies are transient too. The size bound is an
        // integrity limit and fails immediately, as does validation below.
        if (error instanceof RangeError || attempt === 5) throw error;
        await sleep(attempt * 1000);
      }
    }
    throw new Error("Registry retry budget exhausted");
  };
  const { token } = await request("https://ghcr.io/token?service=ghcr.io&scope=repository:paperclipai/paperclip:pull", {}, response => response.json());
  assert.ok(typeof token === "string" && token, "Missing public pull token");
  const readManifest = (reference, accept, allowNotFound) => request(`https://ghcr.io/v2/paperclipai/paperclip/manifests/${reference}`, {
    authorization: `Bearer ${token}`, accept,
  }, async response => {
    assert.ok(response.body, "Registry manifest has no body");
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 1024 * 1024) throw new RangeError("Registry manifest exceeds its size limit");
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    return { raw: Buffer.concat(chunks), expected: response.headers.get("docker-content-digest") };
  }, allowNotFound);
  const manifest = await readManifest(`sha-${sha}`, indexMediaTypes.join(", "), true);
  if (manifest === null) return null;
  const { raw, expected } = manifest;
  const digest = standardImageDigest(raw);
  assert.equal(digest, expected, "Registry digest does not match the index bytes");
  if (verifiedDigests) {
    // The build legs ran the PID 1 probe on these digests. Registry content is
    // addressed by digest, so membership proves the signed index names exactly
    // the probed images without pulling them again here.
    assert.ok(verifiedDigests.length > 0, "No build leg reported a probed image");
    const legs = [];
    for (const legDigest of verifiedDigests) {
      assert.match(legDigest, /^sha256:[a-f0-9]{64}$/);
      const leg = await readManifest(legDigest, [...indexMediaTypes, "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json"].join(", "), false);
      legs.push([legDigest, leg.raw]);
    }
    assertIndexUsesVerifiedImages(raw, verifiedImageDigests(legs));
  }
  return digest;
}

/** Digests the build legs probed, carried as empty files named for each digest. */
async function readVerifiedDigests(directory) {
  const names = await readdir(directory);
  return names.map(name => {
    assert.match(name, /^[a-f0-9]{64}$/, `Unexpected verified digest entry: ${name}`);
    return `sha256:${name}`;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const verifiedFlag = process.argv.indexOf("--verified-digests");
  const verifiedDigests = verifiedFlag > 0 ? await readVerifiedDigests(process.argv[verifiedFlag + 1]) : undefined;
  const digest = process.argv[2] === "--resolve" ? await resolveStandardImageDigest(process.argv[3], fetch, { verifiedDigests }) : standardImageDigest(await readFile(process.argv[2]));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `digest=${digest}\n`);
  console.log(digest);
}
