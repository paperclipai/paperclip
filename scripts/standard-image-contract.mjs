import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Validate the multi-platform index before it becomes a signed build contract. */
export function standardImageDigest(bytes) {
  const index = JSON.parse(bytes.toString("utf8"));
  assert.equal(index.schemaVersion, 2);
  assert.ok(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"].includes(index.mediaType));
  assert.ok(Array.isArray(index.manifests));
  for (const architecture of ["amd64", "arm64"]) {
    const matches = index.manifests.filter(item => item.platform?.os === "linux" && item.platform?.architecture === architecture);
    assert.equal(matches.length, 1, `Expected exactly one linux/${architecture} image`);
    assert.match(matches[0].digest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(matches[0].size) && matches[0].size > 0);
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Read registry bytes directly; CLI stdout formatting is not artifact content. */
export async function resolveStandardImageDigest(sha, fetchImpl = fetch, {
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
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
  const { raw, expected } = await request(`https://ghcr.io/v2/paperclipai/paperclip/manifests/sha-${sha}`, {
    authorization: `Bearer ${token}`, accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
  }, async response => {
    assert.ok(response.body, "Standard image index has no body");
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 1024 * 1024) throw new RangeError("Standard index exceeds its size limit");
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    return { raw: Buffer.concat(chunks), expected: response.headers.get("docker-content-digest") };
  }, true);
  const digest = standardImageDigest(raw);
  assert.equal(digest, expected, "Registry digest does not match the index bytes");
  return digest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const digest = process.argv[2] === "--resolve" ? await resolveStandardImageDigest(process.argv[3]) : standardImageDigest(await readFile(process.argv[2]));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `digest=${digest}\n`);
  console.log(digest);
}
