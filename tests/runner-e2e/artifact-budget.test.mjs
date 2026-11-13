import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ARTIFACT_BOUNDS, checkArtifactFiles, stageBoundedArtifact } from "./artifact-budget.mjs";

const bounds = { ...ARTIFACT_BOUNDS, evidence: 12_288, receipt: 8192, entries: 32 };
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-artifacts-"));
  try { const source = path.join(root, "source"); await mkdir(source); await run({ root, source, out: path.join(root, "out") }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("retains exact accounting and feedback before oversized diagnostics and keeps the source intact", async () => fixture(async ({ source, out }) => {
  await mkdir(path.join(source, "scheduled"));
  await writeFile(path.join(source, "scheduled/ledger.jsonl"), '{"reserved":"4.16"}\n');
  await writeFile(path.join(source, "feedback.json"), '{"complaint":"retained"}\n');
  await writeFile(path.join(source, "trace.zip"), Buffer.alloc(5000, 1));
  const result = await stageBoundedArtifact("evidence", source, out, bounds);
  assert.equal(result.sourceComplete, false); assert.equal(result.inventoryComplete, true);
  assert.deepEqual(result.findings, ["byte_limit"]);
  assert.equal(await readFile(path.join(out, "scheduled/ledger.jsonl"), "utf8"), '{"reserved":"4.16"}\n');
  assert.equal(await readFile(path.join(out, "feedback.json"), "utf8"), '{"complaint":"retained"}\n');
  assert.equal((await stat(path.join(source, "trace.zip"))).size, 5000);
  await assert.rejects(stat(path.join(out, "trace.zip")), { code: "ENOENT" });
  const receipt = JSON.parse(await readFile(path.join(out, "artifact-budget-receipt.json"), "utf8"));
  assert.equal(receipt.files.find(row => row.path === "trace.zip").reason, "byte_limit");
  assert.match(receipt.files.find(row => row.path === "feedback.json").sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.stagedBytes <= bounds.evidence);
}));

test("keeps complete evidence unchanged at the exact payload boundary and refuses destination reuse", async () => fixture(async ({ source, out }) => {
  const content = Buffer.alloc(bounds.evidence - bounds.receipt, 42);
  await writeFile(path.join(source, "result.json"), content);
  const result = await stageBoundedArtifact("evidence", source, out, bounds);
  assert.equal(result.sourceComplete, true); assert.equal(result.retainedBytes, content.length);
  assert.deepEqual(await readFile(path.join(out, "result.json")), content);
  await assert.rejects(stageBoundedArtifact("evidence", source, out, bounds), { code: "EEXIST" });
}));

test("refuses symlinks and records missing evidence without reading outside the source", async () => fixture(async ({ root, source, out }) => {
  await writeFile(path.join(root, "private"), "secret outside source");
  await symlink(path.join(root, "private"), path.join(source, "result.json"));
  const result = await stageBoundedArtifact("evidence", source, out, bounds);
  assert.equal(result.sourceComplete, false); assert.deepEqual(result.findings, ["non_regular_file"]);
  assert.equal(result.retainedBytes, 0);
  const missing = await stageBoundedArtifact("evidence", path.join(root, "missing"), path.join(root, "missing-out"), bounds);
  assert.equal(missing.inventoryComplete, false); assert.deepEqual(missing.findings, ["inventory_failed"]);
}));

test("bounds entry inventory and exposes partial traversal", async () => fixture(async ({ source, out }) => {
  for (let i = 0; i < 5; i++) await writeFile(path.join(source, `${i}.json`), "{}");
  const result = await stageBoundedArtifact("evidence", source, out, { ...bounds, entries: 3 });
  assert.equal(result.inventoryComplete, false); assert.equal(result.sourceComplete, false);
  assert.equal(result.files.filter(row => row.retained).length, 3); assert.deepEqual(result.findings, ["entry_limit"]);
  assert.deepEqual(result.files.find(row => row.reason === "entry_limit"), { path: ".", scope: "subtree", retained: false, reason: "entry_limit" });
}));

test("keeps hidden files excluded from upload and exposes that incomplete scope", async () => fixture(async ({ source, out }) => {
  await mkdir(path.join(source, ".private"));
  await writeFile(path.join(source, ".private/token"), "fixture");
  const result = await stageBoundedArtifact("evidence", source, out, bounds);
  assert.equal(result.inventoryComplete, false); assert.equal(result.sourceComplete, false);
  assert.deepEqual(result.findings, ["hidden_path_excluded"]);
  assert.deepEqual(result.files, [{ path: ".private", scope: "subtree", retained: false, reason: "hidden_path_excluded" }]);
  await assert.rejects(stat(path.join(out, ".private")), { code: "ENOENT" });
}));

test("excludes ordinary packaged Playwright bookkeeping without failing passing evidence", async () => fixture(async ({ source, out }) => {
  const folder = "core-compatibility/runner-codex/local/message-marker/attempt-1";
  await mkdir(path.join(source, folder, "playwright-output"), { recursive: true });
  await writeFile(path.join(source, folder, "playwright-output/.last-run.json"), '{"status":"passed","failedTests":[]}');
  await writeFile(path.join(source, folder, "result.json"), '{"status":"passed"}');
  const result = await stageBoundedArtifact("evidence", source, out, bounds);
  assert.equal(result.sourceComplete, true); assert.equal(result.inventoryComplete, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.files.find(row => row.path.endsWith(".last-run.json")).reason, "playwright_bookkeeping_excluded");
  assert.equal(await readFile(path.join(out, folder, "result.json"), "utf8"), '{"status":"passed"}');
}));

test("discovers snapshots in all attempts before archive directories can consume the entry limit", async () => fixture(async ({ source, out }) => {
  for (const attempt of ["attempt-a", "attempt-b"]) {
    await mkdir(path.join(source, attempt, "blob-report"), { recursive: true });
    await mkdir(path.join(source, attempt, "snapshots"));
    await writeFile(path.join(source, attempt, "snapshots/feedback.json"), '{"saved":true}');
    for (let i = 0; i < 20; i++) await writeFile(path.join(source, attempt, `blob-report/${i}.zip`), "archive");
  }
  const result = await stageBoundedArtifact("evidence", source, out, { ...bounds, entries: 12 });
  assert.equal(result.sourceComplete, false); assert.equal(result.inventoryComplete, false);
  for (const attempt of ["attempt-a", "attempt-b"]) {
    assert.equal(await readFile(path.join(out, attempt, "snapshots/feedback.json"), "utf8"), '{"saved":true}');
    assert.ok(result.files.some(row => row.path === `${attempt}/blob-report` && row.scope === "subtree" && row.reason === "entry_limit"));
  }
}));

test("identifies an overlong skipped subtree with a bounded preview and full path digest", async () => fixture(async ({ source, out }) => {
  const segments = Array.from({ length: 6 }, (_, index) => `${index}-${"x".repeat(90)}`);
  await mkdir(path.join(source, ...segments), { recursive: true });
  await writeFile(path.join(source, ...segments, "feedback.json"), "{}");
  const result = await stageBoundedArtifact("evidence", source, out, bounds);
  const omitted = result.files.find(row => row.reason === "path_length_limit");
  assert.equal(result.sourceComplete, false); assert.equal(result.inventoryComplete, false);
  assert.equal(omitted.scope, "subtree"); assert.equal(omitted.pathTruncated, true);
  assert.match(omitted.pathSha256, /^[a-f0-9]{64}$/); assert.ok(omitted.path.startsWith(segments[0]));
  assert.ok(omitted.path.endsWith(segments[5].slice(-80)));
  assert.equal(omitted.pathSha256, createHash("sha256").update(segments.join("/")).digest("hex"));
  assert.ok(result.stagedBytes <= bounds.evidence);
}));

test("checks immutable build and lock source totals before upload without reading their contents", async () => fixture(async ({ source }) => {
  const a = path.join(source, "a"), b = path.join(source, "b");
  await writeFile(a, "a"); await writeFile(b, "b");
  await truncate(a, ARTIFACT_BOUNDS.lock - 1);
  assert.equal((await checkArtifactFiles("lock", [a, b])).sourceBytes, ARTIFACT_BOUNDS.lock);
  await truncate(a, ARTIFACT_BOUNDS.lock);
  await assert.rejects(checkArtifactFiles("lock", [a, b]), /exceeds/);
  await assert.rejects(checkArtifactFiles("other", [a]), /Invalid/);
}));
