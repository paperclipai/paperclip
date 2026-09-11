import test from "node:test";
import assert from "node:assert/strict";
import { planArtifacts } from "./preview-artifacts.mjs";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { execFileSync, spawnSync } from "node:child_process";
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

test("merge dispatch uses the existing publisher outside full-release concurrency without claiming image readiness", () => {
  const dispatcher = readFileSync(new URL("../.github/workflows/cloud-artifacts.yml", import.meta.url), "utf8");
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(dispatcher, /branches: \[master\]/);
  assert.match(dispatcher, /github.ref == 'refs\/heads\/master'/);
  assert.match(dispatcher, /SOURCE_SHA: \$\{\{ github.sha \}\}/);
  assert.match(dispatcher, /gh workflow run release.yml .*--ref master/);
  assert.match(dispatcher, /--field channel=cloud-migrator/);
  assert.doesNotMatch(dispatcher, /actions\/checkout|id-token: write|packages: write|secrets\./);
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

test("cloud builds start per commit and preserve tag promotion dependencies", () => {
  const docker = readFileSync(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8");
  const cloud = readFileSync(new URL("../.github/workflows/docker-cloud.yml", import.meta.url), "utf8");
  const readiness = readFileSync(new URL("../.github/workflows/cloud-readiness.yml", import.meta.url), "utf8");
  assert.match(readiness, /branches: \[master\]/);
  assert.match(readiness, /uses: \.\/\.github\/workflows\/docker-cloud.yml/);
  assert.doesNotMatch(cloud, /^  push:/m);
  assert.match(cloud, /workflow_call:/);
  assert.match(cloud, /group: docker-cloud-\$\{\{ github.sha \}\}/);
  assert.match(cloud, /cancel-in-progress: false/);
  assert.doesNotMatch(cloud, /uses: .*@v\d\b/);
  assert.match(cloud, /cache-to: type=registry,ref=ghcr.io\/\$\{\{ github.repository \}\}:buildcache-cloud-\$\{\{ github.sha \}\},mode=max/);
  const caller = docker.split("  build-and-push-cloud:")[1].split("  promote_canary_channel:")[0];
  assert.match(caller, /if: github.event_name != 'push' \|\| github.ref != 'refs\/heads\/master'/);
  assert.match(caller, /uses: .\/.github\/workflows\/docker-cloud.yml/);
  assert.match(docker.split("  promote_canary_channel:")[1], /needs: \[merge-and-push, build-and-push-cloud\]/);
  const reaping = cloud.indexOf("      - name: Verify cloud PID 1 reaps orphaned processes");
  assert.ok(reaping > cloud.indexOf("      - name: Verify the pushed image resolves the declared Sentry version"));
  assert.ok(reaping < cloud.indexOf("      - name: Publish verified full-SHA cloud tag"));
});

test("cloud builds bake the managed runtime identity and verify it before publication", () => {
  const workflow = readFileSync(new URL("../.github/workflows/docker-cloud.yml", import.meta.url), "utf8");
  const build = workflow.split("      - name: Build and push (cloud)")[1].split("      - name:")[0];
  assert.match(build, /build-args: \|\n\s+USER_UID=1001\n\s+USER_GID=1001\n/);
  const verify = workflow.indexOf("      - name: Verify cloud runtime user");
  assert.ok(verify > workflow.indexOf("      - name: Verify the pushed image resolves the declared Sentry version"));
  assert.ok(verify < workflow.indexOf("      - name: Publish verified full-SHA cloud tag"));
  const step = workflow.slice(verify).split("\n      - name:")[0];
  assert.match(step, /IMAGE: ghcr.io\/\$\{\{ github.repository \}\}@\$\{\{ steps.build-cloud.outputs.digest \}\}/);
  assert.doesNotMatch(step, /continue-on-error:|if:/);
  assert.ok(step.indexOf('--entrypoint sh "$IMAGE"') < step.indexOf('-e USER_UID=1001 -e USER_GID=1001'));
  for (const flag of ["u", "g"]) {
    assert.ok(step.includes(`test "$(id -${flag} node)" = 1001`));
    assert.ok(step.includes(`test "$(id -${flag})" = 1001`));
  }
  assert.ok(step.includes('test -w "$PAPERCLIP_HOME"'));
});

test("cloud cache imports are bounded, follow master ancestry, and retain the legacy fallback", () => {
  const workflow = readFileSync(new URL("../.github/workflows/docker-cloud.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Select cloud cache ancestry")[1].split("      - name: Setup pnpm")[0];
  const script = step.split("        run: |\n")[1].split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
  const dir = mkdtempSync(path.join(tmpdir(), "cloud-cache-test-"));
  const output = path.join(dir, "output");
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" };
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "--initial-branch=master");
    const commits = [];
    for (let i = 0; i < 12; i++) {
      git("commit", "--allow-empty", "-m", `main ${i}`);
      commits.unshift(git("rev-parse", "HEAD"));
    }
    git("checkout", "-b", "topic", "HEAD~1");
    git("commit", "--allow-empty", "-m", "topic");
    git("checkout", "master");
    git("merge", "--no-ff", "topic", "-m", "merge topic");
    commits.unshift(git("rev-parse", "HEAD"));
    const result = spawnSync("bash", ["-c", script], { cwd: dir, encoding: "utf8", env: { ...env, CACHE_IMAGE: "ghcr.io/paperclipai/paperclip", GITHUB_OUTPUT: output } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(output, "utf8").trim().split("\n"), [
      "sources<<CACHE_SOURCES",
      ...commits.slice(0, 10).map((commit) => `type=registry,ref=ghcr.io/paperclipai/paperclip:buildcache-cloud-${commit}`),
      "type=registry,ref=ghcr.io/paperclipai/paperclip:buildcache-cloud",
      "CACHE_SOURCES",
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normal cloud builds publish the checked digest only when source and platform match", () => {
  const workflow = readFileSync(new URL("../.github/workflows/docker-cloud.yml", import.meta.url), "utf8");
  const cloud = workflow.split("  build-and-push-cloud:")[1];
  const verify = cloud.indexOf("      - name: Verify the pushed image resolves the declared Sentry version");
  const publish = cloud.indexOf("      - name: Publish verified full-SHA cloud tag");
  assert.ok(verify >= 0 && publish > verify);
  const verification = cloud.slice(verify, publish);
  assert.match(verification, /IMAGE: ghcr.io\/\$\{\{ github.repository \}\}@\$\{\{ steps.build-cloud.outputs.digest \}\}/);
  assert.doesNotMatch(verification, /continue-on-error:|if: always\(/);
  const step = cloud.slice(publish).split(/\n(?:  #|      - name:)/)[0];
  assert.doesNotMatch(step, /continue-on-error:|if:/);
  assert.match(step, /FULL_SHA_TAG: ghcr.io\/\$\{\{ github.repository \}\}:sha-\$\{\{ github.sha \}\}-cloud/);
  const script = step.split("        run: |\n")[1].split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
  const dir = mkdtempSync(path.join(tmpdir(), "cloud-tag-test-"));
  const image = `ghcr.io/paperclipai/paperclip@sha256:${"b".repeat(64)}`;
  const tag = `ghcr.io/paperclipai/paperclip:sha-${sha}-cloud`;
  try {
    writeFileSync(path.join(dir, "docker"), `#!/bin/sh
case "$1 $2" in
  'image inspect')
    case "$5" in
      *revision*) printf '%s\\n' "$TEST_REVISION" ;;
      *) printf '%s\\n' "$TEST_PLATFORM" ;;
    esac ;;
  'buildx imagetools') printf '%s\\n' "$@" > "$TEST_CALLS" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    for (const [revision, platform, succeeds] of [[sha, "linux/amd64", true], ["c".repeat(40), "linux/amd64", false], [sha, "linux/arm64", false]]) {
      const calls = path.join(dir, "calls");
      rmSync(calls, { force: true });
      const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: {
        ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, GITHUB_SHA: sha,
        IMAGE: image, FULL_SHA_TAG: tag, TEST_REVISION: revision, TEST_PLATFORM: platform, TEST_CALLS: calls,
      } });
      if (succeeds) {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["buildx", "imagetools", "create", "--prefer-index=false", "--tag", tag, image]);
      } else {
        assert.notEqual(result.status, 0);
        assert.throws(() => readFileSync(calls), { code: "ENOENT" });
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
