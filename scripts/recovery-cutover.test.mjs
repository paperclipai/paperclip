import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inventoryRecoveryFiles } from "./lib/recovery-cutover-inventory.mjs";
import { classifyRecoveryEntry, cutoverStatus } from "./lib/recovery-cutover-policy.mjs";

const cli = fileURLToPath(new URL("./recovery-cutover.mjs", import.meta.url));
const roots = [];
const company = "00000000-0000-4000-8000-000000000001";
const grant = "00000000-0000-4000-8000-000000000002";
async function fixture() {
  // Canonicalize macOS /var -> /private/var, since the check rejects links.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cutover-")));
  roots.push(root);
  return root;
}
async function write(root, relative, content = "secret-token-must-never-appear") {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}
function run(root, args = [], env = {}) {
  return spawnSync(process.execPath, [cli, "--instance-root", root, ...args], {
    encoding: "utf8", env: { ...process.env, SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR: "", ...env },
  });
}
// An unset override differs from an invalid empty override.
function cleanRun(root, args = []) {
  const env = { ...process.env };
  delete env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR;
  return spawnSync(process.execPath, [cli, "--instance-root", root, ...args], { encoding: "utf8", env });
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

test("pure policy never clears files or unknown entries", () => {
  assert.equal(classifyRecoveryEntry("accounting-receipts", 0, "file"), "unverifiedFiles");
  assert.equal(classifyRecoveryEntry("quota-credential-recovery", 0, "company-directory"), "descend");
  assert.equal(classifyRecoveryEntry("quota-credential-recovery", 1, "company-directory"), "unknownEntries");
  assert.equal(cutoverStatus({ complete: false, unknownEntries: 0, readFailures: 0, unverifiedFiles: 0 }), "unknown");
});

test("CLI: absent and empty legacy layouts clear without migration", async () => {
  const root = await fixture();
  let result = cleanRun(root, ["--check"]);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, "clear");
  for (const directory of ["accounting-receipts", `quota-credential-recovery/${company}`, "data/sandbox-orphan-cleanup"]) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  result = cleanRun(root, ["--check"]);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, "clear");
});

test("CLI: real pending legacy files block, preserve bytes and reveal no secrets or names", async () => {
  const root = await fixture();
  const receipt = JSON.stringify({ schema: "paperclip/accounting-receipt/v1", id: grant, companyId: company,
    runId: company, sourceId: company, sequence: 1, receivedAt: "2026-10-30T00:00:00.000Z", adapterType: "codex_local",
    receipt: { complete: true, usage: { inputTokens: 1, outputTokens: 1 } } });
  const files = await Promise.all([
    write(root, `accounting-receipts/${grant}.json`, receipt),
    write(root, `quota-credential-recovery/${company}/${grant}.json`, '{"ciphertext":"secret-token-must-never-appear"}'),
    write(root, "data/sandbox-orphan-cleanup/secret-filename.json", JSON.stringify({ companyId: company,
      environmentId: company, executionWorkspaceId: null, issueId: null, heartbeatRunId: null, provider: "daytona",
      providerLeaseId: "private-resource", metadata: {} })),
  ]);
  const before = await Promise.all(files.map(file => fs.readFile(file)));
  const result = cleanRun(root, ["--check"]);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.directories.map(s => s.unverifiedFiles), [1, 1, 1]);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-token|secret-filename|private-resource|ciphertext|00000000-/);
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), before);
  assert.equal(cleanRun(root).status, 0, "report-only mode does not fail on obligations");
});

test("truncated, temporary, and unreadable files are unverified, never clear", async () => {
  const root = await fixture();
  await write(root, "accounting-receipts/truncated.json", '{"schema":');
  const file = await write(root, `quota-credential-recovery/${company}/${grant}.json.probe`);
  await fs.chmod(file, 0);
  const report = await inventoryRecoveryFiles({ instanceRoot: root });
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.directories.map(s => s.unverifiedFiles), [1, 1, 0]);
});

test("unknown nesting and symlinks block without traversing outside the chosen roots", async () => {
  const root = await fixture();
  const outside = await fixture();
  await write(outside, "do-not-read.json");
  await fs.mkdir(path.join(root, "accounting-receipts"));
  await fs.symlink(outside, path.join(root, "accounting-receipts", "link"));
  await fs.mkdir(path.join(root, "quota-credential-recovery", company, "unexpected"), { recursive: true });
  const report = await inventoryRecoveryFiles({ instanceRoot: root });
  assert.equal(report.status, "unknown");
  assert.deepEqual(report.directories.map(s => s.unknownEntries), [1, 1, 0]);
  assert.deepEqual(report.directories.map(s => s.unverifiedFiles), [0, 0, 0]);
  await fs.symlink(outside, path.join(root, "data"));
  assert.equal((await inventoryRecoveryFiles({ instanceRoot: root })).directories[2].status, "unknown");
  await fs.symlink(outside, path.join(root, "instance-link"));
  assert.equal((await inventoryRecoveryFiles({ instanceRoot: path.join(root, "instance-link") })).status, "unknown");
});

test("entry budget gives incomplete lower-bound counts and never clears omitted work", async () => {
  const root = await fixture();
  for (let i = 0; i < 4; i++) await write(root, `accounting-receipts/${i}.json`);
  const report = await inventoryRecoveryFiles({ instanceRoot: root, maxEntries: 2 });
  assert.equal(report.status, "unknown");
  assert.equal(report.directories[0].observedEntries, 2);
  assert.equal(report.directories[0].complete, false);
  assert.equal(report.directories[0].unverifiedFiles, 2);
  const exact = await inventoryRecoveryFiles({ instanceRoot: root, maxEntries: 4 });
  assert.equal(exact.directories[0].complete, true);
});

test("CLI respects configured orphan override and explicit override precedence", async () => {
  const root = await fixture();
  const override = await fixture();
  await write(override, "pending.json");
  let result = run(root, ["--check"], { SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR: override });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).directories[2].unverifiedFiles, 1);
  const emptyOverride = await fixture();
  result = run(root, ["--check", "--orphan-directory", emptyOverride], { SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR: override });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, "clear");
});

test("fault boundary reports stat, directory read and close failures without error data", async () => {
  const root = await fixture();
  await fs.mkdir(path.join(root, "accounting-receipts"));
  for (const operation of ["lstat", "opendir", "read", "close"]) {
    const sensitiveError = Object.assign(new Error("secret-token-must-never-appear"), { code: "EACCES" });
    const io = { ...fs };
    if (operation === "lstat" || operation === "opendir") io[operation] = async () => { throw sensitiveError; };
    else io.opendir = async () => ({
      read: async () => { if (operation === "read") throw sensitiveError; return null; },
      close: async () => { if (operation === "close") throw sensitiveError; },
    });
    const report = await inventoryRecoveryFiles({ instanceRoot: root }, io);
    assert.equal(report.status, "unknown");
    if (operation === "lstat") assert.equal(report.instanceStatus, "unreadable");
    else assert.ok(report.directories[0].readFailures > 0);
    assert.doesNotMatch(JSON.stringify(report), /secret-token|EACCES/);
  }
});

test("CLI fails closed for missing instance, unsafe roots and bad arguments", async () => {
  const root = await fixture();
  assert.equal(cleanRun(path.join(root, "absent"), ["--check"]).status, 1);
  for (const args of [["--max-entries", "0"], ["--max-entries", "100001"], ["--max-entries", "NaN"],
    ["--orphan-directory", "relative-secret"], ["--bad-secret"], ["--check", "--check"]]) {
    const result = cleanRun(root, args);
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout + result.stderr, /relative-secret|bad-secret/);
  }
});
