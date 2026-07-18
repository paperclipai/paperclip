import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SH = join(HERE, "request-release-approval.sh");
const MJS = join(HERE, "request-release-approval.mjs");

const CANDIDATE = "abc123def456abc123def456abc123def456abcd";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "rra-"));
  return {
    dir,
    pending: join(dir, "pending.ref"),
    approval: join(dir, "approval.token"),
    summary: join(dir, "summary.txt"),
  };
}

// Run the script with a HERMETIC env: no inherited Paperclip API creds (so routine mode can't
// accidentally reach a live control plane), a non-existent train (so candidate resolution relies
// only on our spool files), and our temp file paths.
function run(args, t, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CORTEX_RELEASE_PENDING_FILE: t.pending,
    CORTEX_RELEASE_APPROVAL_FILE: t.approval,
    CORTEX_RELEASE_SUMMARY_FILE: t.summary,
    CORTEX_WEEKLY_TRAIN: "/nonexistent/cortex-weekly-train.sh",
    // deliberately NO PAPERCLIP_API_* and NO CORTEX_RELEASE_APPROVAL_ISSUE unless a test sets them
    ...extraEnv,
  };
  const r = spawnSync("bash", [SH, ...args], { env, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("scripts pass syntax checks", () => {
  spawnSync("bash", ["-n", SH], { encoding: "utf8" });
  const shChk = spawnSync("bash", ["-n", SH]);
  assert.equal(shChk.status, 0, "request-release-approval.sh must pass bash -n");
  const mjsChk = spawnSync("node", ["--check", MJS]);
  assert.equal(mjsChk.status, 0, "request-release-approval.mjs must pass node --check");
});

test("hook mode spools the candidate + summary and journald-ALERTs; exit 0", () => {
  const t = tmp();
  try {
    const r = run([CANDIDATE, "changelog: NEO-1, NEO-2"], t);
    assert.equal(r.code, 0, "a notify step must never fail the train");
    assert.equal(readFileSync(t.pending, "utf8").trim(), CANDIDATE);
    assert.equal(readFileSync(t.summary, "utf8").trim(), "changelog: NEO-1, NEO-2");
    // the guaranteed-visible fallback: an ALERT naming the candidate + how to approve
    assert.match(r.stderr, /ALERT:/);
    assert.match(r.stderr, /abc123def456/);
    assert.match(r.stderr, /systemctl start cortex-weekly-train\.service/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("no pending candidate is a clean no-op (exit 0, no ALERT)", () => {
  const t = tmp();
  try {
    const r = run([], t);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no pending release candidate/);
    assert.doesNotMatch(r.stderr, /ALERT:/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("a candidate already carrying a matching approval token is not re-raised", () => {
  const t = tmp();
  try {
    writeFileSync(t.pending, `${CANDIDATE}\n`);
    writeFileSync(t.approval, `${CANDIDATE}\n`);
    const r = run([], t, { CORTEX_RELEASE_APPROVAL_ISSUE: "NEO-999" });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /already has a matching CTO approval token/);
    assert.doesNotMatch(r.stderr, /ALERT:/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("dry-run builds the request payload with the snapshot-scoped idempotencyKey; POSTs nothing", () => {
  const t = tmp();
  try {
    writeFileSync(t.pending, `${CANDIDATE}\n`);
    writeFileSync(t.summary, "the change log\n");
    const r = run(["--dry-run"], t, { CORTEX_RELEASE_APPROVAL_ISSUE: "NEO-777" });
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.idempotencyKey, `confirmation:NEO-777:release:${CANDIDATE}`);
    assert.equal(payload.body.kind, "request_confirmation");
    assert.equal(payload.body.continuationPolicy, "wake_assignee_on_accept");
    assert.equal(payload.body.payload.version, 1);
    // snapshot-scoped: the target revision IS the candidate SHA
    assert.equal(payload.body.payload.target.revisionId, CANDIDATE);
    assert.match(payload.body.payload.detailsMarkdown, /the change log/);
    assert.match(payload.body.payload.detailsMarkdown, /systemctl start cortex-weekly-train/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("routine mode with a pending candidate but no target issue → config error (exit 2) after emitting the ALERT fallback", () => {
  const t = tmp();
  try {
    writeFileSync(t.pending, `${CANDIDATE}\n`);
    const r = run([], t); // no CORTEX_RELEASE_APPROVAL_ISSUE
    assert.equal(r.code, 2);
    // fallback must still fire even though the POST cannot proceed
    assert.match(r.stderr, /ALERT:/);
    assert.match(r.stderr, /CORTEX_RELEASE_APPROVAL_ISSUE is unset/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("routine mode with a target issue but no API creds → config error (exit 2) with ALERT fallback", () => {
  const t = tmp();
  try {
    writeFileSync(t.pending, `${CANDIDATE}\n`);
    const r = run([], t, { CORTEX_RELEASE_APPROVAL_ISSUE: "NEO-777" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ALERT:/);
    assert.match(r.stderr, /no Paperclip API creds/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("status mode reports candidate/token/target and never has a side effect", () => {
  const t = tmp();
  try {
    writeFileSync(t.pending, `${CANDIDATE}\n`);
    const r = run(["--status"], t, { CORTEX_RELEASE_APPROVAL_ISSUE: "NEO-777" });
    assert.equal(r.code, 0);
    assert.match(r.stdout, new RegExp(CANDIDATE));
    assert.match(r.stdout, /target issue: NEO-777/);
    assert.match(r.stdout, /api: <absent/); // hermetic env has no creds
    assert.equal(existsSync(t.approval), false, "status must not write the token file");
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});
