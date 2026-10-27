import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cursorDistribution, cursorDistributionClosure, materializePinnedCursorDistribution, verifyCursorDistribution } from "./materialize-cursor-distribution.mjs";

import { CURSOR_RUNTIME_PATCH_VERSION, CURSOR_RUNTIME_PATCH_PINS, patchCursorRuntimeSource, replaceCursorPatchAnchor } from "./cursor-runtime-patch.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() { const path = await mkdtemp(join(tmpdir(), "cursor-distribution-test-")); roots.push(path); return path; }

test("pins complete archives and closures for every supported platform", async () => {
  for (const [platform, architecture] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"]]) {
    const distribution = await cursorDistribution(platform, architecture);
    assert.equal(distribution.version, "2026.09.26-dd393fe");
    assert.match(distribution.archiveSha256, /^[a-f0-9]{64}$/);
    assert.match(distribution.closureSha256, /^[a-f0-9]{64}$/);
    assert.match(distribution.vendorClosureSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(distribution.closureSha256, distribution.vendorClosureSha256);
    assert.equal(distribution.patchVersion, CURSOR_RUNTIME_PATCH_VERSION);
    assert.equal(distribution.url, `https://downloads.cursor.com/lab/${distribution.version}/${platform}/${architecture}/agent-cli-package.tar.gz`);
  }
  await assert.rejects(cursorDistribution("linux", "arm64"), /no pinned distribution/);
});

test("full closure verification catches changes outside the main entrypoint", async () => {
  const root = await fixture();
  await writeFile(join(root, "node"), "node", { mode: 0o700 });
  await writeFile(join(root, "index.js"), "entry");
  await mkdir(join(root, "chunks")); await writeFile(join(root, "chunks", "worker.js"), "worker");
  const closure = await cursorDistributionClosure(root);
  assert.deepEqual(closure.entries.map(entry => entry.path), ["chunks/worker.js", "index.js", "node"]);
  const expected = { executable: "node", entrypoint: "index.js", closureSha256: closure.sha256 };
  await verifyCursorDistribution(root, expected);
  await writeFile(join(root, "chunks", "worker.js"), "tampered");
  await assert.rejects(verifyCursorDistribution(root, expected), /closure digest mismatch/);
});

test("closure never accepts linked files or linked directories", async () => {
  const root = await fixture(); const outside = await fixture();
  await writeFile(join(outside, "secret"), "secret");
  await symlink(join(outside, "secret"), join(root, "link"));
  await assert.rejects(cursorDistributionClosure(root), /links or special files/);
  await rm(join(root, "link")); await symlink(outside, join(root, "directory"));
  await assert.rejects(cursorDistributionClosure(root), /links or special files/);
});

test("rejects altered archives before invoking tar and leaves no destination", async () => {
  const root = await fixture(); const archivePath = join(root, "bad.tar.gz");
  await writeFile(archivePath, "not a pinned archive");
  await assert.rejects(materializePinnedCursorDistribution({ archivePath, destination: join(root, "out"), platform: "darwin", architecture: "arm64" }), /archive digest mismatch/);
});

test("refuses to overwrite any existing destination", async () => {
  const root = await fixture(); await writeFile(join(root, "existing"), "keep");
  await assert.rejects(materializePinnedCursorDistribution({ destination: join(root, "existing") }), /already exists/);
});


test("the isolation patch refuses unsupported, drifted, missing or repeated vendor bytes", () => {
  assert.throws(() => patchCursorRuntimeSource("not vendor bytes", "darwin-arm64"), /input digest mismatch/);
  assert.throws(() => patchCursorRuntimeSource("not vendor bytes", "linux-arm64"), /input digest mismatch/);
  assert.throws(() => replaceCursorPatchAnchor("absent", "anchor", "replacement"), /exactly one/);
  assert.throws(() => replaceCursorPatchAnchor("anchor anchor", "anchor", "replacement"), /exactly one/);
  assert.equal(replaceCursorPatchAnchor("before anchor after", "anchor", "$&"), "before $& after");
});

test("retained executable vendor proof matches every checked-in patch identity", async () => {
  const proof = JSON.parse(await readFile(new URL("../test/fixtures/cursor-acp/usage-v4-runtime-patch-offline-proof.json", import.meta.url), "utf8"));
  assert.equal(proof.patchVersion, CURSOR_RUNTIME_PATCH_VERSION);
  assert.equal(proof.providerCalls, 0);
  assert.equal(proof.qualification, "offline-only");
  assert.deepEqual(proof.platforms.map(row => row.platform).sort(), Object.keys(CURSOR_RUNTIME_PATCH_PINS).sort());
  for (const row of proof.platforms) {
    const pin = CURSOR_RUNTIME_PATCH_PINS[row.platform];
    assert.equal(row.sourceSha256, pin.before);
    assert.equal(row.patchedSha256, pin.after);
    for (const field of ["driftRejected", "fullChunkCompiles", "ownedMcpPreserved", "typedActionErrors", "assistantProseIgnored"]) assert.equal(row[field], true);
    for (const field of ["boundedPayloadRejected", "explicitEmptyInstructions", "nativeGlobalRule", "nativeResourceAdditionalRules"]) assert.equal(row.instructions[field], true);
    for (const field of ["ambientMcpAccesses", "hookConfigReads", "remoteTeamHookFetches"]) assert.equal(row[field], 0);
  }
});
