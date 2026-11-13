import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { fileURLToPath } from "node:url";
import { staleSdkPublicInputs, synchronizeSdkPublicInputs } from "./source-sdk-public-inputs.mjs";

const registry = "tests/runner-e2e/source-sdk-public-inputs.json";
const reportLock = "tests/runner-e2e/report-lock.json";
const reportPolicy = (inputSha256, outputSha256) => `${JSON.stringify({ inputSha256, outputSha256, patchSha256: "0".repeat(64), basis: "synthetic" }, null, 2)}\n`;
const commit = (root, message) => { git(root, "add", "-A"); git(root, "-c", "user.name=Synthetic unit", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", message); return git(root, "rev-parse", "HEAD").trim(); };
const roots = [];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const blob = bytes => createHash("sha1").update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest("hex");
const git = (root, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
async function put(root, file, bytes) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), bytes); }
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sdk-input-sync-"))); roots.push(root);
  const files = ["package.json", "packages/plugins/sdk/package.json", "packages/plugins/sdk/tsconfig.json",
    "packages/shared/package.json", "packages/shared/tsconfig.json", "pnpm-lock.yaml", "scripts/ensure-plugin-build-deps.mjs",
    "tsconfig.base.json", "tsconfig.json", "packages/shared/src/schema.ts", "packages/plugins/sdk/src/types.ts"];
  for (const file of files) await put(root, file, `synthetic original ${file}\n`);
  const baseline = { inputs: Object.fromEntries(files.map(file => [file, blob(`synthetic stale ${file}\n`)])),
    lockSha256: digest("synthetic authenticated restored lock"), compilerPackageSha256: "a".repeat(64),
    parserPackageSha256: "b".repeat(64), parserEntrySha256: "c".repeat(64),
    zodPackageSha256: "d".repeat(64), zodEntrySha256: "e".repeat(64), zodTypeFiles: { "index.d.cts": "f".repeat(64) } };
  await put(root, registry, `${JSON.stringify(baseline, null, 2)}\n`);
  // The reviewed report-lock policy: committed lock in, authenticated restored lock out.
  await put(root, reportLock, reportPolicy(digest("synthetic original pnpm-lock.yaml\n"), baseline.lockSha256));
  git(root, "init", "-q"); git(root, "add", ".");
  git(root, "-c", "user.name=Synthetic unit", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "synthetic source");
  return { root, baseline, revision: git(root, "rev-parse", "HEAD").trim() };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("synchronizes the committed source graph, preserves every runtime pin and is idempotent", async () => {
  const { root, baseline } = await fixture();
  await put(root, "packages/shared/src/added.ts", "synthetic added source\n");
  git(root, "add", "."); git(root, "-c", "user.name=Synthetic unit", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "additional source");
  const revision = git(root, "rev-parse", "HEAD").trim();
  assert.equal((await synchronizeSdkPublicInputs(root, revision)).changed, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, registry), "utf8")), baseline, "check does not write");
  const changed = await synchronizeSdkPublicInputs(root, revision, { write: true });
  const updated = JSON.parse(await readFile(path.join(root, registry), "utf8"));
  assert.equal(updated.inputs["packages/shared/src/added.ts"], blob("synthetic added source\n"));
  for (const [file, pin] of Object.entries(updated.inputs)) assert.equal(pin, git(root, "rev-parse", `${revision}:${file}`).trim());
  const { inputs: oldInputs, ...runtime } = baseline, { inputs: newInputs, ...afterRuntime } = updated;
  assert.deepEqual(afterRuntime, runtime); assert.equal(changed.runtimePinsChanged, false);
  assert.equal(changed.registrySha256, digest(await readFile(path.join(root, registry))));
  assert.equal((await synchronizeSdkPublicInputs(root, revision)).changed, false);
});
for (const mutation of ["dirty", "missing", "extra", "symlink", "registry", "revision"]) {
  test(`refuses ${mutation} source custody without writing the registry`, async () => {
    const { root, revision } = await fixture();
    const target = path.join(root, "packages/shared/src/schema.ts");
    if (mutation === "dirty") await writeFile(target, "uncommitted synthetic source");
    if (mutation === "missing") await rm(target);
    if (mutation === "extra") await put(root, "packages/shared/src/uncommitted.ts", "uncommitted");
    if (mutation === "symlink") { await rm(target); await symlink("../package.json", target); }
    if (mutation === "registry") { const current = JSON.parse(await readFile(path.join(root, registry), "utf8")); current.parserEntrySha256 = "0".repeat(64); await writeFile(path.join(root, registry), JSON.stringify(current)); }
    const before = await readFile(path.join(root, registry));
    await assert.rejects(synchronizeSdkPublicInputs(root, mutation === "revision" ? "0".repeat(40) : revision, { write: true }));
    assert.deepEqual(await readFile(path.join(root, registry)), before);
  });
}
test("admits only the separately pinned restored lock overlay without changing its identities", async () => {
  const { root, baseline, revision } = await fixture();
  await writeFile(path.join(root, "pnpm-lock.yaml"), "synthetic authenticated restored lock");
  await synchronizeSdkPublicInputs(root, revision, { write: true });
  const updated = JSON.parse(await readFile(path.join(root, registry), "utf8"));
  assert.equal(updated.lockSha256, baseline.lockSha256);
  assert.equal(updated.inputs["pnpm-lock.yaml"], git(root, "rev-parse", `${revision}:pnpm-lock.yaml`).trim());
  await writeFile(path.join(root, "pnpm-lock.yaml"), "unknown lock overlay");
  await assert.rejects(synchronizeSdkPublicInputs(root, revision));
});

// A lockfile refresh rewrites the lock and report-lock.json together (#20615).
// The sync carries the new reviewed output hash into lockSha256; nothing else.
test("a lockfile refresh moves lockSha256 to the committed reviewed report-lock output", async () => {
  const { root, baseline, revision: first } = await fixture();
  await synchronizeSdkPublicInputs(root, first, { write: true });
  commit(root, "synced");
  const refreshed = "synthetic refreshed pnpm-lock.yaml\n";
  await put(root, "pnpm-lock.yaml", refreshed);
  await put(root, reportLock, reportPolicy(baseline.lockSha256, digest(refreshed)));
  const revision = commit(root, "lockfile refresh");
  assert.deepEqual(await staleSdkPublicInputs(root), [
    { file: "pnpm-lock.yaml", change: "changed" },
    { file: `${reportLock} outputSha256`, change: "lockSha256 changed" },
  ]);
  const result = await synchronizeSdkPublicInputs(root, revision, { write: true });
  assert.equal(result.lockPinChanged, true); assert.equal(result.runtimePinsChanged, false);
  const updated = JSON.parse(await readFile(path.join(root, registry), "utf8"));
  assert.equal(updated.lockSha256, digest(refreshed));
  assert.equal(updated.inputs["pnpm-lock.yaml"], blob(refreshed));
  const { inputs: _old, lockSha256: _oldLock, ...runtime } = baseline, { inputs: _new, lockSha256: _newLock, ...afterRuntime } = updated;
  assert.deepEqual(afterRuntime, runtime);
  assert.deepEqual(await staleSdkPublicInputs(root), []);
});
test("refuses a committed lock that the report-lock policy does not review", async () => {
  const { root } = await fixture();
  await put(root, "pnpm-lock.yaml", "synthetic unreviewed lock\n");
  const revision = commit(root, "unreviewed lock");
  const before = await readFile(path.join(root, registry));
  await assert.rejects(synchronizeSdkPublicInputs(root, revision, { write: true }), /not reviewed by tests\/runner-e2e\/report-lock\.json/);
  assert.deepEqual(await readFile(path.join(root, registry)), before);
});

// The pins only prove the SDK public types while they match the committed
// source. A PR that edits packages/shared/src (or another pinned input) without
// refreshing them breaks every SDK-dependent Runner cell before its server
// starts, so fail here, cheaply, with the inputs and the fix command.
test("the committed SDK public source pins match this checkout's committed tree", async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const stale = await staleSdkPublicInputs(root);
  assert.deepEqual(stale, [], `${registry} is stale for ${stale.length} pinned input(s): ${stale.slice(0, 10).map(row => `${row.file} (${row.change})`).join(", ")}${stale.length > 10 ? ", ..." : ""}. `
    + "Commit your change, run `node tests/runner-e2e/source-sdk-public-inputs.mjs $(git rev-parse HEAD) --write`, and commit the updated registry.");
});
test("the drift guard names changed, unpinned and removed inputs and clears after a resync", async () => {
  const { root, revision } = await fixture();
  assert.deepEqual((await staleSdkPublicInputs(root)).map(row => row.change), Array(11).fill("changed"));
  await synchronizeSdkPublicInputs(root, revision, { write: true });
  assert.deepEqual(await staleSdkPublicInputs(root), []);
  await put(root, "packages/shared/src/added.ts", "synthetic added source\n"); await rm(path.join(root, "packages/plugins/sdk/src/types.ts"));
  git(root, "add", "-A"); git(root, "-c", "user.name=Synthetic unit", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "drift");
  assert.deepEqual(await staleSdkPublicInputs(root), [{ file: "packages/plugins/sdk/src/types.ts", change: "removed" }, { file: "packages/shared/src/added.ts", change: "unpinned" }]);
});
