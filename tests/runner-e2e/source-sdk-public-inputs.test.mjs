import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { synchronizeSdkPublicInputs } from "./source-sdk-public-inputs.mjs";

const registry = "tests/runner-e2e/source-sdk-public-inputs.json";
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
