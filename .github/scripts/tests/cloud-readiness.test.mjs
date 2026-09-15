import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { waitForCloudArtifacts, verifyManifestProvenance, migratorPublished } from "../../../scripts/cloud-readiness.mjs";
import { artifactBase, descriptor } from "../../../scripts/cloud-migrator-artifacts.mjs";
import { previewManifest } from "../../../scripts/preview-artifacts.mjs";

const sha = "a".repeat(40);
const version = `0.0.0-preview.g${sha}`;
const digest = `sha256:${"b".repeat(64)}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const producer = { id: 123, head_sha: sha, head_branch: "master", path: ".github/workflows/cloud-migrator-artifacts.yml",
  head_repository: { id: 1170821064, full_name: "paperclipai/paperclip" }, event: "push", status: "completed", conclusion: "success" };
function bundle() {
  const packages = {}; const files = new Map();
  const entries = { "": { dependencies: { "@paperclipai/db": version } } };
  for (const name of ["db", "shared"]) {
    const metadata = previewManifest({ name: `@paperclipai/${name}`, dependencies: {} }, sha);
    const bytes = Buffer.from(JSON.stringify(metadata));
    const header = Buffer.alloc(512); header.write("package/package.json"); header.write(bytes.length.toString(8).padStart(11, "0"), 124, 11); header[156] = 48;
    const padded = Buffer.alloc(Math.ceil(bytes.length / 512) * 512); bytes.copy(padded);
    const archive = gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
    const pin = descriptor(archive, "tgz"); packages[name] = pin; files.set(pin.url, archive);
    entries[`node_modules/@paperclipai/${name}`] = { version, resolved: pin.url, integrity: pin.integrity, dependencies: metadata.dependencies };
  }
  const lock = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: entries }));
  const manifest = { version: 1, sourceSha: sha, packageVersion: version, packages, lockfile: descriptor(lock, "json") };
  files.set(manifest.lockfile.url, lock);
  const bytes = Buffer.from(JSON.stringify(manifest) + "\n");
  files.set(`${artifactBase}/${sha}/manifest.json`, bytes);
  return { manifest, bytes, files };
}
function registry({ missing = new Set(), failure, wrongImage = false, run = producer, objects = bundle() } = {}) {
  return async (url, options) => {
    assert.ok(!url.startsWith("https://registry.npmjs.org/"), "readiness must never wait for npm");
    if (failure) return json({}, failure);
    if (url.startsWith("https://api.github.com/")) {
      assert.match(url, new RegExp(`head_sha=${sha}&per_page=100&page=1$`));
      return json({ total_count: missing.has("migrator") ? 0 : 1, workflow_runs: missing.has("migrator") ? [] : [run] });
    }
    if (url.startsWith(artifactBase)) {
      assert.equal(options.headers?.Authorization, undefined, "GitHub credentials stay off the artifact origin");
      return objects.files.has(url) ? new Response(objects.files.get(url)) : json({}, 403);
    }
    if (url.includes("/token?")) return json({ token: "fixture" });
    if (url.includes("/manifests/")) return missing.has("image") ? json({}, 404) : json({ config: { digest } });
    if (url.includes("/blobs/")) return json({ config: { Labels: { "org.opencontainers.image.revision": wrongImage ? "c".repeat(40) : sha } } });
    throw new Error(`Unexpected request: ${url}`);
  };
}
const noSignature = async () => {}; // Signature enforcement is exercised separately below.

test("readiness rechecks image and publisher, then verifies the exact signed bundle with no npm requests", async () => {
  const missing = new Set(["image", "migrator"]); const objects = bundle(); let clock = 0; let signatures = 0;
  const result = await waitForCloudArtifacts(sha, {
    fetchImpl: registry({ missing, objects }), token: "fixture", now: () => clock, intervalMs: 10, timeoutMs: 100, log: () => {},
    verifyProvenance: async (bytes, source) => { assert.deepEqual(bytes, objects.bytes); assert.equal(source, sha); signatures++; },
    sleep: async (ms) => {
      clock += ms;
      if (clock === 10) missing.delete("image");
      if (clock === 20) { missing.delete("migrator"); missing.add("image"); }
      if (clock === 30) missing.delete("image");
    },
  });
  assert.equal(clock, 30); assert.equal(signatures, 1);
  assert.deepEqual(result, { version: 1, sha, packageVersion: version });
});

test("missing or in-progress publishers time out with a precise inventory and bounded sleep", async () => {
  for (const fixture of [{ missing: new Set(["migrator"]) }, { run: { ...producer, status: "in_progress", conclusion: null } }]) {
    let clock = 0; const sleeps = [];
    await assert.rejects(waitForCloudArtifacts(sha, {
      fetchImpl: registry(fixture), now: () => clock, timeoutMs: 25, intervalMs: 20, log: () => {}, verifyProvenance: noSignature,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    }), /timed out.*missing: migrator/);
    assert.deepEqual(sleeps, [20, 5]);
  }
});

for (const fixture of [{ failure: 403 }, { failure: 503 }, { wrongImage: true },
  ...["failure", "cancelled", "skipped"].map((conclusion) => ({ run: { ...producer, conclusion } })),
  ...[{ head_sha: "b".repeat(40) }, { head_branch: "feature" }, { path: ".github/workflows/evil.yml" },
    { head_repository: { id: 123, full_name: "someone/paperclip" } }, { event: "pull_request" }].map((wrong) => ({ run: { ...producer, ...wrong } }))]) {
  test(`upstream errors, failed publication and identity mismatches fail immediately: ${JSON.stringify(fixture)}`, async () => {
    await assert.rejects(waitForCloudArtifacts(sha, { fetchImpl: registry(fixture), verifyProvenance: noSignature,
      sleep: async () => assert.fail("must not retry an invalid artifact or upstream error"), log: () => {} }));
  });
}

test("successful publication cannot hide inaccessible or corrupt archives or an invalid signature", async () => {
  for (const corrupt of [false, true]) {
    const objects = bundle();
    if (corrupt) objects.files.set(objects.manifest.packages.db.url, Buffer.from("corrupt"));
    else objects.files.delete(objects.manifest.packages.db.url);
    await assert.rejects(waitForCloudArtifacts(sha, { fetchImpl: registry({ objects }), verifyProvenance: noSignature, log: () => {} }), /download failed|immutable pin/);
  }
  await assert.rejects(waitForCloudArtifacts(sha, { fetchImpl: registry(), verifyProvenance: async () => { throw new Error("invalid signature"); }, log: () => {} }), /invalid signature/);
});

test("CLI verifies the exact bytes, source, master workflow and hosted runner and cleans up on failure", () => {
  let temporary;
  assert.throws(() => verifyManifestProvenance(Buffer.from("exact manifest\n"), sha, { exec: (cmd, args) => {
    assert.equal(cmd, "gh"); assert.deepEqual(args.slice(0, 2), ["attestation", "verify"]); temporary = args[2];
    assert.equal(readFileSync(temporary, "utf8"), "exact manifest\n");
    for (const [flag, value] of [["--repo", "paperclipai/paperclip"], ["--source-digest", sha], ["--source-ref", "refs/heads/master"],
      ["--cert-identity", "https://github.com/paperclipai/paperclip/.github/workflows/cloud-migrator-artifacts.yml@refs/heads/master"]]) assert.equal(args[args.indexOf(flag) + 1], value);
    assert.ok(args.includes("--deny-self-hosted-runners")); throw new Error("verification rejected");
  } }), /verification rejected/);
  assert.equal(existsSync(temporary), false);
});

test("invalid source and timing configuration are rejected before registry access", async () => {
  const fetchImpl = async () => assert.fail("invalid inputs must not reach a registry");
  await assert.rejects(waitForCloudArtifacts("master", { fetchImpl }), /full immutable commit SHA/);
  for (const options of [{ timeoutMs: 0 }, { intervalMs: -1 }, { timeoutMs: Infinity }]) await assert.rejects(waitForCloudArtifacts(sha, { ...options, fetchImpl }), /positive finite/);
});

test("versioned readiness retains every source gate and removes duplicate automatic npm publication", () => {
  const workflow = readFileSync(new URL("../../workflows/cloud-readiness.yml", import.meta.url), "utf8");
  assert.match(workflow, /push:\s*\n\s*branches: \[master\]/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/release-verify.yml\s+with:\s+ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/docker-cloud.yml/);
  assert.match(workflow, /attestations: read/); assert.match(workflow, /GH_TOKEN: \$\{\{ github.token \}\}/);
  const ready = workflow.split("  ready:")[1];
  assert.match(ready, /name: Cloud deployable v1/); assert.match(ready, /needs: \[verify, image, artifacts\]/);
  assert.match(ready, /if: github.repository == 'paperclipai\/paperclip' && github.ref == 'refs\/heads\/master'/);
  assert.doesNotMatch(ready, /^\s*(?:if:.*always\(|continue-on-error:)/m);
  assert.doesNotMatch(workflow, /secrets: inherit|id-token: write|actions: write|checks: write|uses: .*@v\d\b/);
  assert.equal(existsSync(new URL("../../workflows/cloud-artifacts.yml", import.meta.url)), false);
});


test("later manual failures or pending retries cannot hide an earlier successful immutable publication", async () => {
  for (const latest of [{ status: "completed", conclusion: "failure" }, { status: "in_progress", conclusion: null }]) {
    let calls = 0;
    assert.equal(await migratorPublished(sha, async (url) => {
      calls++;
      if (url.endsWith("page=1")) return json({ total_count: 101, workflow_runs: Array.from({ length: 100 }, (_, i) => ({ ...producer, ...latest, id: 200 + i, event: "workflow_dispatch" })) });
      assert.ok(url.endsWith("page=2")); return json({ total_count: 101, workflow_runs: [producer] });
    }), true);
    assert.equal(calls, 2);
  }
});
