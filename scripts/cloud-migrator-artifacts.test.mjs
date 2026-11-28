import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { artifactBase, assertManifest, assertLockfile, buildBundle, descriptor, migrationCompatibility, validateBundle, verifyPublished, publishBundle } from "./cloud-migrator-artifacts.mjs";
import { previewManifest, versionFor } from "./preview-artifacts.mjs";
import { classifyMigrationSequence as classify } from "../packages/db/src/migration-compatibility.ts";

const sha = "a".repeat(40);
const migrations = {
  "0000_first": 'CREATE TABLE IF NOT EXISTS "widgets" ("id" uuid PRIMARY KEY NOT NULL);\n--> statement-breakpoint\nCREATE INDEX "widgets_idx" ON "widgets" ("id");\n',
  // IF NOT EXISTS does not make a table from an earlier migration new again.
  "0001_second": 'CREATE TABLE IF NOT EXISTS "widgets" ("id" uuid);\n--> statement-breakpoint\nCREATE INDEX "widgets_again_idx" ON "widgets" ("id");\n',
  "0002_third": '-- paperclip:migration-compat online_compatible: no release since 0.2 reads issues.legacy\nALTER TABLE "issues" DROP COLUMN "legacy";\n',
};
function tarEntry(name, content) {
  const bytes = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name); header.write(bytes.length.toString(8).padStart(11, "0"), 124, 11); header[156] = 48;
  // A real tar header, so npm can install this fixture as well as inspect it.
  header.fill(32, 148, 156);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  const padded = Buffer.alloc(Math.ceil(bytes.length / 512) * 512); bytes.copy(padded);
  return Buffer.concat([header, padded]);
}
function dbArchive(files = migrations) {
  const journal = { version: "7", dialect: "postgresql", entries: Object.keys(files).map((tag, idx) => ({ idx, version: "7", when: idx, tag, breakpoints: true })) };
  return gzipSync(Buffer.concat([
    tarEntry("package/package.json", JSON.stringify(previewManifest({ name: "@paperclipai/db", dependencies: {} }, sha))),
    tarEntry("package/dist/migrations/meta/_journal.json", JSON.stringify(journal)),
    ...Object.entries(files).map(([tag, sql]) => tarEntry(`package/dist/migrations/${tag}.sql`, sql)),
    Buffer.alloc(1024),
  ]));
}
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "migrator-artifact-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "db.tgz"), dbArchive());
  writeFileSync(path.join(dir, "shared.tgz"), gzipSync(Buffer.concat([
    tarEntry("package/package.json", JSON.stringify(previewManifest({ name: "@paperclipai/shared", dependencies: {} }, sha))), Buffer.alloc(1024)])));
  const manifest = buildBundle(dir, sha, { classify, exec: (cmd, args, options) => {
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

test("manifest publishes how each packed migration behaves under the previous release", (t) => {
  const { manifest } = fixture(t);
  const digest = (tag) => createHash("sha256").update(migrations[tag]).digest("hex");
  assert.deepEqual(manifest.migrationCompatibility.version, 1);
  assert.deepEqual(manifest.migrationCompatibility.migrations.map(({ reasons, ...entry }) => ({ ...entry, reasons: reasons.map((reason) => reason.code) })), [
    { idx: 0, tag: "0000_first", sqlSha256: digest("0000_first"), compatibility: "online_compatible", classified: "online_compatible", override: false,
      reasons: ["create_table", "create_index_new_table"] },
    { idx: 1, tag: "0001_second", sqlSha256: digest("0001_second"), compatibility: "unknown", classified: "unknown", override: false,
      reasons: ["create_table_if_not_exists", "lock_hazard_create_index"] },
    { idx: 2, tag: "0002_third", sqlSha256: digest("0002_third"), compatibility: "online_compatible", classified: "requires_staging", override: true,
      overrideJustification: "no release since 0.2 reads issues.legacy", reasons: ["drop_column"] },
  ]);
  const reason = manifest.migrationCompatibility.migrations[1].reasons[1];
  assert.deepEqual(Object.keys(reason), ["code", "compatibility", "message", "statements"]);
  assert.deepEqual([reason.compatibility, reason.statements], ["unknown", [2]]);
  // Everything a consumer pinned before this field existed is unchanged.
  assert.deepEqual(Object.keys(manifest), ["version", "sourceSha", "packageVersion", "packages", "lockfile", "migrationCompatibility"]);
  assert.equal(manifest.version, 1);
});

test("migration compatibility is optional for earlier manifests and fails closed when malformed or stale", async (t) => {
  const { dir, manifest, files, fetchImpl } = fixture(t);
  const earlier = structuredClone(manifest); delete earlier.migrationCompatibility;
  assert.doesNotThrow(() => assertManifest(earlier, sha));
  for (const mutate of [
    (c) => { c.version = 2; },
    (c) => { c.migrations = []; },
    (c) => { c.migrations[0].compatibility = "safe"; },
    (c) => { c.migrations[0].classified = undefined; },
    (c) => { c.migrations[0].sqlSha256 = "abc"; },
    (c) => { c.migrations[2].idx = 0; },
    (c) => { c.migrations[1].tag = c.migrations[0].tag; c.migrations[1].idx = 0; },
    (c) => { c.migrations[0].override = true; },
    (c) => { c.migrations[2].overrideJustification = ""; },
    (c) => { c.migrations[2].compatibility = "unknown"; },
    (c) => { c.migrations[0].overrideJustification = "without an override"; },
    (c) => { c.migrations[1].reasons[0].statements = [0]; },
    (c) => { c.migrations[1].reasons[1].compatibility = "fine"; },
    (c) => { c.migrations[1].reasons[0].code = 7; },
  ]) {
    const bad = structuredClone(manifest); mutate(bad.migrationCompatibility);
    assert.throws(() => assertManifest(bad, sha), /Invalid migration compatibility data/);
  }
  assert.throws(() => buildBundle(dir, sha), /classifier/);
  // A well-formed classification of different SQL must not be published or accepted.
  const stale = structuredClone(manifest);
  stale.migrationCompatibility = migrationCompatibility(dbArchive({ ...migrations, "0001_second": 'DROP TABLE "issues";\n' }), classify);
  assertManifest(stale, sha);
  files.set(`${artifactBase}/${sha}/manifest.json`, Buffer.from(JSON.stringify(stale)));
  await assert.rejects(verifyPublished(sha, fetchImpl), /does not match the packed migrations/);
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(stale));
  assert.throws(() => validateBundle(dir, sha), /does not match the packed migrations/);
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(earlier));
  assert.throws(() => validateBundle(dir, sha), /does not match the packed migrations/);
  assert.throws(() => migrationCompatibility(dbArchive({}), classify), /empty migration journal/);
  assert.throws(() => migrationCompatibility(dbArchive(), () => []), /one result per migration/);
  // The shipped journal repeats idx 178; order then follows the file name, as in the migrator.
  const repeated = structuredClone(manifest); repeated.migrationCompatibility.migrations[1].idx = 0;
  assert.doesNotThrow(() => assertManifest(repeated, sha));
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
  const manifest = buildBundle(dir, sha, { classify });
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
