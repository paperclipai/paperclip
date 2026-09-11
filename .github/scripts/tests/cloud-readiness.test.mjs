import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { waitForCloudArtifacts } from "../../../scripts/cloud-readiness.mjs";
import { previewManifest } from "../../../scripts/preview-artifacts.mjs";

const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
function registry({ missing = new Set(), failure, wrongImage = false, wrongPackage = false } = {}) {
  return async (url) => {
    if (failure) return json({}, failure);
    if (url.startsWith("https://registry.npmjs.org/")) {
      const name = decodeURIComponent(new URL(url).pathname.split("/")[1]);
      if (missing.has(name.split("/")[1])) return json({}, 404);
      const pkg = previewManifest({ name, version: "0.0.0" }, sha);
      return json({ ...pkg, ...(wrongPackage ? { gitHead: "c".repeat(40) } : {}), dist: { integrity: "sha512-fixture", tarball: "https://registry.npmjs.org/fixture.tgz" } });
    }
    if (url.includes("/token?")) return json({ token: "fixture" });
    if (url.includes("/manifests/")) return missing.has("image") ? json({}, 404) : json({ config: { digest } });
    if (url.includes("/blobs/")) return json({ config: { Labels: { "org.opencontainers.image.revision": wrongImage ? "c".repeat(40) : sha } } });
    throw new Error(`Unexpected request: ${url}`);
  };
}

test("readiness requires the image and both exact-source packages on the successful poll", async () => {
  const missing = new Set(["image", "shared", "db"]);
  let clock = 0;
  const states = [];
  const result = await waitForCloudArtifacts(sha, {
    fetchImpl: registry({ missing }), now: () => clock, intervalMs: 10, timeoutMs: 100, log: (message) => states.push(message),
    sleep: async (ms) => {
      clock += ms;
      if (clock === 10) missing.delete("image");
      if (clock === 20) missing.delete("shared");
      if (clock === 30) { missing.delete("db"); missing.add("image"); }
      if (clock === 40) missing.delete("image");
    },
  });
  assert.equal(clock, 40, "an artifact disappearing before the final poll must prevent readiness");
  assert.deepEqual(result, { version: 1, sha, packageVersion: `0.0.0-preview.g${sha}` });
  assert.match(states.at(-1), /Cloud artifacts available/);
});

test("missing artifacts time out with a precise inventory and bounded sleep", async () => {
  let clock = 0;
  const sleeps = [];
  await assert.rejects(waitForCloudArtifacts(sha, {
    fetchImpl: registry({ missing: new Set(["db"]) }), now: () => clock, timeoutMs: 25, intervalMs: 20, log: () => {},
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  }), /timed out.*missing: db/);
  assert.deepEqual(sleeps, [20, 5]);
});

for (const fixture of [{ failure: 403 }, { failure: 503 }, { wrongImage: true }, { wrongPackage: true }]) {
  test(`registry errors and identity mismatches fail without waiting: ${JSON.stringify(fixture)}`, async () => {
    await assert.rejects(waitForCloudArtifacts(sha, {
      fetchImpl: registry(fixture), sleep: async () => assert.fail("must not retry an invalid artifact or upstream error"), log: () => {},
    }));
  });
}

test("invalid source and timing configuration are rejected before registry access", async () => {
  const fetchImpl = async () => assert.fail("invalid inputs must not reach a registry");
  await assert.rejects(waitForCloudArtifacts("master", { fetchImpl }), /full immutable commit SHA/);
  for (const options of [{ timeoutMs: 0 }, { intervalMs: -1 }, { timeoutMs: Infinity }]) {
    await assert.rejects(waitForCloudArtifacts(sha, { ...options, fetchImpl }), /positive finite/);
  }
});

test("the versioned readiness job requires successful source, image and artifact jobs", () => {
  const workflow = readFileSync(new URL("../../workflows/cloud-readiness.yml", import.meta.url), "utf8");
  assert.match(workflow, /push:\s*\n\s*branches: \[master\]/);
  assert.match(workflow, /group: cloud-readiness-\$\{\{ github.sha \}\}/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/release-verify.yml\s+with:\s+ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/docker-cloud.yml/);
  const ready = workflow.split("  ready:")[1];
  assert.match(ready, /name: Cloud deployable v1/);
  assert.match(ready, /needs: \[verify, image, artifacts\]/);
  assert.match(ready, /if: github.repository == 'paperclipai\/paperclip' && github.ref == 'refs\/heads\/master'/);
  assert.doesNotMatch(ready, /^\s*(?:if:.*always\(|continue-on-error:)/m);
  assert.doesNotMatch(workflow, /secrets: inherit|id-token: write|actions: write|checks: write|uses: .*@v\d\b/);
  const cloud = readFileSync(new URL("../../workflows/docker-cloud.yml", import.meta.url), "utf8");
  assert.doesNotMatch(cloud, /^  push:/m, "the master image must build only once");
  const migrator = readFileSync(new URL("../../workflows/cloud-artifacts.yml", import.meta.url), "utf8");
  assert.match(migrator, /push:\s*\n\s*branches: \[master\]/);
  assert.match(migrator, /SOURCE_SHA: \$\{\{ github.sha \}\}/);
  assert.match(migrator, /gh workflow run release.yml .*--ref master/);
  assert.match(migrator, /--field channel=cloud-migrator/);
  assert.match(migrator, /--field source_ref="\$SOURCE_SHA"/);
});
