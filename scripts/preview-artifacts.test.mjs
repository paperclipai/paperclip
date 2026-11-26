import test from "node:test";
import assert from "node:assert/strict";
import { planArtifacts } from "./preview-artifacts.mjs";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { previewManifest, assertMetadata, validateRequest, versionFor, tarManifest, packageExists, imageExists, publishPreview, publishImage } from "./preview-artifacts.mjs";

const sha = "a".repeat(40);
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const manifest = (name) => previewManifest({ name, version: "0.0.0", dependencies: name.endsWith("/db") ? { "@paperclipai/shared": "workspace:*" } : {}, publishConfig: { exports: { ".": "./dist/index.js" } } }, sha);
function pack(pkg) {
  const b = Buffer.from(JSON.stringify(pkg)); const h = Buffer.alloc(512);
  h.write("package/package.json"); h.write(b.length.toString(8).padStart(11, "0"), 124, 11); h[156] = 48;
  const padded = Buffer.alloc(Math.ceil(b.length / 512) * 512); b.copy(padded);
  return gzipSync(Buffer.concat([h, padded, Buffer.alloc(1024)]));
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("preview request requires immutable SHA and correlation UUID", () => {
  validateRequest(sha, id);
  for (const ref of ["master", "origin/master", "a".repeat(7), "$(unsafe)", "A".repeat(40)]) assert.throws(() => versionFor(ref));
  assert.throws(() => validateRequest(sha, "not-a-request"));
});

test("migrator-only planning never waits for GHCR and reuses complete exact-source packages", async () => {
  for (const available of [[], ["@paperclipai/shared"], ["@paperclipai/shared", "@paperclipai/db"]]) {
    const calls = [];
    const result = await planArtifacts(sha, { image: false, migrator: true, fetchImpl: async (url) => {
      assert.equal(new URL(url).hostname, "registry.npmjs.org");
      const name = decodeURIComponent(new URL(url).pathname.split("/")[1]);
      calls.push(name);
      return available.includes(name) ? json({ ...manifest(name), dist: { integrity: "test-integrity", tarball: "https://registry.npmjs.org/package.tgz" } }) : json({}, 404);
    } });
    assert.deepEqual(result, { image: false, packages: available.length !== 2 });
    assert.ok(calls.includes("@paperclipai/shared"));
    if (available.length) assert.ok(calls.includes("@paperclipai/db"));
  }
});

test("migrator-only planning rejects registry outages and mismatched source identity", async () => {
  for (const response of [json({}, 403), json({}, 503), json({ ...manifest("@paperclipai/shared"), gitHead: "b".repeat(40) })]) {
    await assert.rejects(planArtifacts(sha, { image: false, migrator: true, fetchImpl: async () => response }));
  }
});

test("ordinary preview planning still requests a missing image without publishing unsolicited packages", async () => {
  const result = await planArtifacts(sha, { fetchImpl: async (url) => {
    assert.equal(new URL(url).hostname, "ghcr.io");
    return url.includes("/token?") ? json({ token: "test-pull-token" }) : json({}, 404);
  } });
  assert.deepEqual(result, { image: true, packages: false });
});

test("preview manifests carry exact source, isolated versions and shared dependency", () => {
  const pkg = manifest("@paperclipai/db");
  assert.equal(pkg.version, `0.0.0-preview.g${sha}`);
  assert.equal(pkg.dependencies["@paperclipai/shared"], pkg.version);
  assert.deepEqual(pkg.exports, { ".": "./dist/index.js" });
  assertMetadata(pkg, "@paperclipai/db", sha);
  assert.throws(() => assertMetadata({ ...pkg, gitHead: "b".repeat(40) }, pkg.name, sha));
  assert.throws(() => assertMetadata({ ...pkg, dependencies: { "@paperclipai/shared": "latest" } }, pkg.name, sha));
  assert.deepEqual(tarManifest(pack(pkg)), pkg);
});

test("only 404 means an artifact is missing; auth and outages are fatal", async () => {
  assert.equal(await packageExists("@paperclipai/db", sha, async () => json({}, 404)), false);
  await assert.rejects(packageExists("@paperclipai/db", sha, async () => json({}, 403)));
  await assert.rejects(packageExists("@paperclipai/db", sha, async () => json({}, 503)));
  await assert.rejects(imageExists(sha, async () => json({}, 503)));
  assert.equal(await imageExists(sha, async (url) => url.includes("/token?") ? json({ token: "test-pull-token" }) : json({}, 404)), false);
  await assert.rejects(packageExists("@paperclipai/db", sha, async () => json({ ...manifest("@paperclipai/db"), gitHead: "b".repeat(40) })));
});

test("publishing reuses existing previews and never executes package lifecycle hooks", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-publish-test-"));
  const published = new Set(["@paperclipai/shared"]);
  const calls = [];
  try {
    for (const short of ["shared", "db"]) writeFileSync(path.join(dir, `${short}.tgz`), pack({ ...manifest(`@paperclipai/${short}`), scripts: { prepublishOnly: "do-not-run" } }));
    await publishPreview(dir, sha, {
      fetchImpl: async (url) => {
        const name = decodeURIComponent(new URL(url).pathname.split("/")[1]);
        return published.has(name) ? json({ ...manifest(name), dist: { integrity: "test-integrity", tarball: "https://registry.npmjs.org/package.tgz" } }) : json({}, 404);
      },
      exec: (command, args) => { calls.push({ command, args }); published.add("@paperclipai/db"); },
      sleep: async () => {},
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "npm");
    assert.ok(calls[0].args.includes("--ignore-scripts"));
    assert.equal(calls[0].args[calls[0].args.indexOf("--tag") + 1], "preview");
    assert.ok(!calls[0].args.includes("canary"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("publishing submits both packages before waiting for either to propagate", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-publish-overlap-"));
  const submitted = [];
  let polls = 0;
  try {
    for (const short of ["shared", "db"]) writeFileSync(path.join(dir, `${short}.tgz`), pack(manifest(`@paperclipai/${short}`)));
    await publishPreview(dir, sha, {
      exec: (_command, args) => submitted.push(path.basename(args[1], ".tgz")),
      fetchImpl: async (url) => {
        const name = decodeURIComponent(new URL(url).pathname.split("/")[1]);
        // Both packages become visible after the first shared visibility wait.
        return submitted.length === 2 && polls > 0
          ? json({ ...manifest(name), dist: { integrity: "test-integrity", tarball: "https://registry.npmjs.org/package.tgz" } })
          : json({}, 404);
      },
      sleep: async () => { assert.deepEqual(submitted, ["shared", "db"]); polls++; },
    });
    assert.deepEqual(submitted, ["shared", "db"]);
    assert.equal(polls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a visibility timeout identifies the missing package after both were submitted", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-publish-timeout-"));
  const submitted = [];
  try {
    for (const short of ["shared", "db"]) writeFileSync(path.join(dir, `${short}.tgz`), pack(manifest(`@paperclipai/${short}`)));
    await assert.rejects(publishPreview(dir, sha, {
      exec: (_command, args) => submitted.push(path.basename(args[1], ".tgz")),
      fetchImpl: async (url) => {
        const name = decodeURIComponent(new URL(url).pathname.split("/")[1]);
        return name === "@paperclipai/db" && submitted.includes("db")
          ? json({ ...manifest(name), dist: { integrity: "test-integrity", tarball: "https://registry.npmjs.org/package.tgz" } })
          : json({}, 404);
      },
      sleep: async () => {},
    }), /not yet visible: @paperclipai\/shared\./);
    assert.deepEqual(submitted, ["shared", "db"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid DB package metadata prevents publication of either package", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-publish-invalid-"));
  try {
    writeFileSync(path.join(dir, "shared.tgz"), pack(manifest("@paperclipai/shared")));
    writeFileSync(path.join(dir, "db.tgz"), pack({ ...manifest("@paperclipai/db"), gitHead: "b".repeat(40) }));
    await assert.rejects(publishPreview(dir, sha, {
      exec: () => assert.fail("Invalid package pairs must not be published"),
      fetchImpl: async () => assert.fail("Validate the pair before registry requests"),
    }), /identity or dependency pin mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("preview workflow separates branch compilation from trusted publishing", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const builder = workflow.split("  package_preview:")[1].split("  publish_preview:")[0];
  const publisher = workflow.split("  publish_preview:")[1].split("  image_preview:")[0];
  const image = workflow.split("  image_preview:")[1].split("  publish_image_preview:")[0];
  const imagePublisher = workflow.split("  publish_image_preview:")[1].split("  result_preview:")[0];
  assert.doesNotMatch(builder, /id-token: write|packages: write|secrets\./);
  assert.doesNotMatch(publisher, /ref: \$\{\{ inputs.source_ref|working-directory: source|pnpm install/);
  assert.match(publisher, /environment: npm-canary/);
  assert.match(image, /PAPERCLIP_BUILD_COMMIT=\$\{\{ inputs.source_ref \}\}/);
  assert.doesNotMatch(image, /cache-(?:to|from):|canary-cloud|latest-cloud|packages: write|secrets\./);
  assert.doesNotMatch(imagePublisher, /ref: \$\{\{ inputs.source_ref|docker\/build-push-action|pnpm install/);
  assert.match(imagePublisher, /publish-image/);
  assert.match(imagePublisher, /environment: npm-canary/);
  assert.match(imagePublisher, /github.ref == 'refs\/heads\/master'/);
  assert.match(publisher, /github.ref == 'refs\/heads\/master'/);
  assert.doesNotMatch(workflow.split("  verify_canary:")[0], /uses: [^\n]+@v\d/);
  assert.match(workflow, /Stack deploy \{0\} build/);
});

test("manual migrator and branch preview retain their npm publisher and concurrency", () => {
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(release, /\(inputs.channel == 'preview' \|\| inputs.channel == 'cloud-migrator'\) && format\('\{0\}-\{1\}', inputs.channel, inputs.source_ref\)/);
  const publisher = release.split("  publish_preview:")[1].split("  image_preview:")[0];
  assert.match(publisher, /group: preview-package-publish-\$\{\{ inputs.source_ref \}\}/);
  assert.match(publisher, /cancel-in-progress: false/);
  assert.match(release, /PLAN_COMMAND: \$\{\{ inputs.channel == 'cloud-migrator' && 'plan-migrator' \|\| 'plan' \}\}/);
  const result = release.split("  result_preview:")[1].split("  verify_canary:")[0];
  assert.match(result, /always\(\) && inputs.channel == 'preview'/);
});


test("existing image reuse verifies the full revision behind the immutable tag", async () => {
  const digest = "sha256:" + "b".repeat(64);
  for (const revision of [sha, "c".repeat(40)]) {
    const fetchImpl = async (url) => url.includes("/token?") ? json({ token: "test-pull-token" }) :
      url.includes("/blobs/") ? json({ config: { Labels: { "org.opencontainers.image.revision": revision } } }) :
      url.endsWith(digest) ? json({ config: { digest } }) : json({ manifests: [{ digest, platform: { os: "linux", architecture: "amd64" } }] });
    if (revision === sha) assert.equal(await imageExists(sha, fetchImpl), true);
    else await assert.rejects(imageExists(sha, fetchImpl), /full commit/);
  }
});


test("image publisher verifies source and platform before pushing exactly one immutable tag", async () => {
  for (const revision of [sha, "c".repeat(40)]) {
    const calls = [];
    const operation = publishImage("preview-image.tar", sha, {
      fetchImpl: async (url) => url.includes("/token?") ? json({ token: "test-pull-token" }) : json({}, 404),
      exec: (command, args) => {
        calls.push({ command, args });
        if (args[0] === "image") return JSON.stringify([{ Id: "sha256:" + "b".repeat(64), Os: "linux", Architecture: "amd64", Config: { Labels: { "org.opencontainers.image.revision": revision } } }]);
        return "";
      },
    });
    if (revision === sha) {
      await operation;
      assert.deepEqual(calls.filter((call) => call.args[0] === "push").map((call) => call.args), [["push", `ghcr.io/paperclipai/paperclip:sha-${sha}-cloud`]]);
    } else { await assert.rejects(operation, /identity/); assert.ok(!calls.some((call) => call.args[0] === "push")); }
    assert.ok(!calls.some((call) => ["run", "build"].includes(call.args[0])));
  }
});


test("commits sharing a short prefix use separate full-SHA image addresses", async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return url.includes("/token?") ? json({ token: "test-pull-token" }) : json({}, 404); };
  const other = sha.slice(0, 7) + "b".repeat(33);
  await imageExists(sha, fetchImpl);
  await imageExists(other, fetchImpl);
  assert.deepEqual(urls.filter((url) => url.includes("/manifests/")), [sha, other].map((commit) => `https://ghcr.io/v2/paperclipai/paperclip/manifests/sha-${commit}-cloud`));
});
