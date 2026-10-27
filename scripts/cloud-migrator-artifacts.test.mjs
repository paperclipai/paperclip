import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { artifactBase, assertManifest, assertLockfile, buildBundle, descriptor, validateBundle, verifyPublished, publishBundle } from "./cloud-migrator-artifacts.mjs";
import { previewManifest, versionFor } from "./preview-artifacts.mjs";

const sha = "a".repeat(40);
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "migrator-artifact-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["db", "shared"]) {
    const bytes = Buffer.from(JSON.stringify(previewManifest({ name: `@paperclipai/${name}`, dependencies: {} }, sha)));
    const header = Buffer.alloc(512);
    header.write("package/package.json"); header.write(bytes.length.toString(8).padStart(11, "0"), 124, 11); header[156] = 48;
    // A real tar header, so npm can install this fixture as well as inspect it.
    header.fill(32, 148, 156);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    const padded = Buffer.alloc(Math.ceil(bytes.length / 512) * 512); bytes.copy(padded);
    writeFileSync(path.join(dir, `${name}.tgz`), gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)])));
  }
  const manifest = buildBundle(dir, sha, { exec: (cmd, args, options) => {
    assert.equal(cmd, "npm"); assert.ok(args.includes("--ignore-scripts"));
    const localRoot = JSON.parse(readFileSync(path.join(options.cwd, "package.json")));
    assert.deepEqual(localRoot.dependencies, { "@paperclipai/db": "file:db.tgz", "@paperclipai/shared": "file:shared.tgz" });
    const packages = { "": localRoot };
    for (const name of ["db", "shared"]) packages[`node_modules/@paperclipai/${name}`] = {
      version: versionFor(sha), integrity: descriptor(readFileSync(path.join(dir, `${name}.tgz`)), "tgz").integrity,
      resolved: `file:${name}.tgz`, ...(name === "db" ? { dependencies: { "@paperclipai/shared": versionFor(sha) } } : {}),
    };
    writeFileSync(path.join(options.cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
  } });
  const files = new Map([[`${artifactBase}/${sha}/manifest.json`, readFileSync(path.join(dir, "manifest.json"))]]);
  for (const name of ["db", "shared"]) files.set(manifest.packages[name].url, readFileSync(path.join(dir, `${name}.tgz`)));
  files.set(manifest.lockfile.url, readFileSync(path.join(dir, "package-lock.json")));
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, "error"); assert.ok(options.signal);
    assert.ok(files.has(url), `unexpected download: ${url}`);
    return new Response(files.get(url));
  };
  return { dir, manifest, files, fetchImpl };
}

test("bundle pins the exact source pair and complete lockfile without new npm lookups", async (t) => {
  const { dir, manifest, fetchImpl } = fixture(t);
  assert.deepEqual(validateBundle(dir, sha), manifest);
  assert.deepEqual(await verifyPublished(sha, fetchImpl), manifest);
});

test("source identity, content hashes, size, and origin fail closed", async (t) => {
  const { dir, manifest, files, fetchImpl } = fixture(t);
  for (const mutate of [
    (m) => { m.sourceSha = "b".repeat(40); },
    (m) => { m.packages.db.url = "https://evil.invalid/db.tgz"; },
    (m) => { m.packages.shared.size = 0; },
    (m) => { m.lockfile.integrity = "sha1-weak"; },
  ]) {
    const bad = structuredClone(manifest); mutate(bad); assert.throws(() => assertManifest(bad, sha));
  }
  files.set(manifest.packages.db.url, Buffer.from("corrupt"));
  await assert.rejects(verifyPublished(sha, fetchImpl), /immutable pin/);
  writeFileSync(path.join(dir, "db.tgz"), "corrupt");
  await assert.rejects(publishBundle(dir, sha, { exec: () => assert.fail("no upload before pair validation") }));
});

test("lockfile rejects mutable, foreign, linked, and mismatched dependencies", (t) => {
  const { dir, manifest } = fixture(t);
  const lock = JSON.parse(readFileSync(path.join(dir, "package-lock.json")));
  for (const mutate of [
    (l) => { l.packages[""].dependencies["@paperclipai/db"] = "latest"; },
    (l) => { l.packages["node_modules/@paperclipai/shared"].version = "0.0.0"; },
    (l) => { l.packages["node_modules/@paperclipai/db"].link = true; },
    (l) => { l.packages["node_modules/evil"] = { inBundle: true }; },
    (l) => { l.packages["node_modules/evil"] = { integrity: manifest.packages.db.integrity, resolved: "https://evil.invalid/pkg.tgz" }; },
    (l) => { l.packages["node_modules/evil"] = { integrity: "sha1-weak", resolved: "https://registry.npmjs.org/pkg.tgz" }; },
    (l) => { l.packages["node_modules/a/node_modules/@paperclipai/shared"] = l.packages["node_modules/@paperclipai/shared"]; },
  ]) {
    const bad = structuredClone(lock); mutate(bad); assert.throws(() => assertLockfile(bad, manifest));
  }
});

test("publisher writes blobs first, marker last, and never overwrites existing objects", async (t) => {
  const { dir, fetchImpl } = fixture(t);
  const objects = new Set(); const uploads = [];
  const exec = (cmd, args) => {
    assert.equal(cmd, "aws");
    const arg = (key) => args[args.indexOf(key) + 1];
    if (args[1] === "list-objects-v2") return JSON.stringify({ Contents: objects.has(arg("--prefix")) ? [{ Key: arg("--prefix") }] : [] });
    assert.equal(args[1], "put-object"); assert.equal(arg("--if-none-match"), "*");
    objects.add(arg("--key")); uploads.push(arg("--key")); return "{}";
  };
  await publishBundle(dir, sha, { exec, fetchImpl });
  assert.equal(uploads.length, 4); assert.equal(uploads.at(-1), `cloud-migrators/v1/${sha}/manifest.json`);
  await publishBundle(dir, sha, { exec, fetchImpl }); assert.equal(uploads.length, 4);
});

test("download failures and oversized objects never count as available", async (t) => {
  fixture(t);
  for (const status of [403, 404, 500]) await assert.rejects(verifyPublished(sha, async () => new Response(null, { status })), /download failed/);
  await assert.rejects(verifyPublished(sha, async () => new Response(Buffer.alloc(32 * 1024 * 1024 + 1))), /size limit/);
});

test("real npm ci installs the new pair from pinned archives with an empty cache", async (t) => {
  const { dir } = fixture(t);
  // Real npm resolution uses local archives; neither package version exists on npm.
  const manifest = buildBundle(dir, sha);
  const lock = JSON.parse(readFileSync(path.join(dir, "package-lock.json")));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (!["/db.tgz", "/shared.tgz"].includes(req.url)) { res.writeHead(500); res.end(); return; }
    res.end(readFileSync(path.join(dir, req.url.slice(1))));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ["db", "shared"]) lock.packages[`node_modules/@paperclipai/${name}`].resolved = `${base}/${name}.tgz`;
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "paperclip-migrator-install-root", version: "0.0.0", private: true, dependencies: { "@paperclipai/db": versionFor(sha) } }));
  writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(lock));
  await promisify(execFile)("npm", ["ci", "--update-notifier=false", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", base, "--cache", path.join(dir, "empty-cache")], { cwd: dir, timeout: 60_000 });
  assert.deepEqual(requests.sort(), ["/db.tgz", "/shared.tgz"]);
  for (const name of ["db", "shared"]) assert.equal(JSON.parse(readFileSync(path.join(dir, `node_modules/@paperclipai/${name}/package.json`))).version, manifest.packageVersion);
});

test("AWS trust is master-only and publication policy cannot overwrite objects", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../.github/cloud-migrator-deploy/${name}.json`, import.meta.url)));
  assert.equal(read("trust-policy").Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"], "repo:paperclipai/paperclip:ref:refs/heads/master");
  const policy = read("upload-policy").Statement;
  assert.deepEqual(policy.map((s) => s.Action), ["s3:PutObject", "s3:ListBucket"]);
  assert.equal(policy[0].Condition.StringEquals["s3:if-none-match"], "*");
  const workflow = readFileSync(new URL("../.github/workflows/cloud-migrator-artifacts.yml", import.meta.url), "utf8");
  assert.ok(!workflow.includes("pull_request") && !workflow.includes("self-hosted") && !workflow.includes("runs-on/fleet="));
  assert.equal((workflow.match(/id-token: write/g) ?? []).length, 1);
  assert.equal((workflow.match(/attestations: write/g) ?? []).length, 1);
  assert.ok(workflow.indexOf(" validate migrator-artifacts") < workflow.indexOf("uses: actions/attest@"));
  assert.ok(workflow.indexOf("uses: actions/attest@") < workflow.indexOf(" publish migrator-artifacts"));
  assert.ok(workflow.indexOf(" verify-install migrator-artifacts") < workflow.indexOf("actions/upload-artifact@"), "the real dependency smoke must pass before artifact upload");
});
