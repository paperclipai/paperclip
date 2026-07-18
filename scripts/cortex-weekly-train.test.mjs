import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "cortex-weekly-train.sh");

// Source the train as a library (no train run) and evaluate a snippet against its functions.
// Returns { code, stdout, stderr }. Guardrails call die()/exit, so we capture the exit code.
function evalInScript(snippet, env = {}) {
  const prog = `set -euo pipefail
export CORTEX_TRAIN_SOURCE_ONLY=1
source '${SCRIPT}'
${snippet}`;
  try {
    const stdout = execFileSync("bash", ["-c", prog], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

// A minimal real git tree, so assert_live_target's ".git present" check passes for the
// happy-path cases and we isolate the specific guardrail under test.
function makeGitTree() {
  const dir = mkdtempSync(join(tmpdir(), "train-live-"));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

test("script passes bash -n syntax check", () => {
  execFileSync("bash", ["-n", SCRIPT]);
});

test("approval_token_sha reads the first non-comment token; approval_valid_for is exact-match", () => {
  const dir = mkdtempSync(join(tmpdir(), "train-appr-"));
  const tok = join(dir, "approval.token");
  writeFileSync(tok, "# CTO approval for the weekly train\nabc123def456  granted-by-werner\n");
  const env = { CORTEX_RELEASE_APPROVAL_FILE: tok };

  assert.equal(evalInScript(`approval_token_sha`, env).stdout.trim(), "abc123def456");
  // exact match → valid
  assert.equal(evalInScript(`approval_valid_for abc123def456 && echo YES`, env).stdout.trim(), "YES");
  // different sha → NOT valid (snapshot-scoped: last week's token can't promote a new snapshot)
  assert.equal(evalInScript(`approval_valid_for zzz999 || echo NO`, env).stdout.trim(), "NO");
  rmSync(dir, { recursive: true, force: true });
});

test("approval_valid_for is false when no token file exists", () => {
  const env = { CORTEX_RELEASE_APPROVAL_FILE: "/nonexistent/approval.token" };
  assert.equal(evalInScript(`approval_valid_for anything || echo NO`, env).stdout.trim(), "NO");
});

test("assert_live_target REFUSES a non-loopback live health URL", () => {
  const tree = makeGitTree();
  const r = evalInScript(`assert_live_target`, {
    CORTEX_LIVE_TREE: tree,
    CORTEX_BETA_TREE: "/home/ubuntu/projects/cortex-beta",
    CORTEX_LIVE_SERVICE: "paperclip.service",
    CORTEX_LIVE_HEALTH_URL: "https://cortex.neoreef.com/api/health",
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not loopback/);
  rmSync(tree, { recursive: true, force: true });
});

test("assert_live_target REFUSES a beta service unit (that path is 522a's, never the train's)", () => {
  const tree = makeGitTree();
  const r = evalInScript(`assert_live_target`, {
    CORTEX_LIVE_TREE: tree,
    CORTEX_BETA_TREE: "/home/ubuntu/projects/cortex-beta",
    CORTEX_LIVE_SERVICE: "paperclip-beta.service",
    CORTEX_LIVE_HEALTH_URL: "http://127.0.0.1:3100/api/health",
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /beta unit/);
  rmSync(tree, { recursive: true, force: true });
});

test("assert_live_target REFUSES when the live tree equals the beta tree (must promote across instances)", () => {
  const tree = makeGitTree();
  const r = evalInScript(`assert_live_target`, {
    CORTEX_LIVE_TREE: tree,
    CORTEX_BETA_TREE: tree,
    CORTEX_LIVE_SERVICE: "paperclip.service",
    CORTEX_LIVE_HEALTH_URL: "http://127.0.0.1:3100/api/health",
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /equals beta tree/);
  rmSync(tree, { recursive: true, force: true });
});

test("assert_live_target ACCEPTS a loopback live orchestrator target", () => {
  const tree = makeGitTree();
  const r = evalInScript(`assert_live_target && echo OK`, {
    CORTEX_LIVE_TREE: tree,
    CORTEX_BETA_TREE: "/home/ubuntu/projects/cortex-beta",
    CORTEX_LIVE_SERVICE: "paperclip.service",
    CORTEX_LIVE_HEALTH_URL: "http://127.0.0.1:3100/api/health",
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /OK/);
  rmSync(tree, { recursive: true, force: true });
});

test("canary_promote in DRY mode runs the safety assert but makes NO live change", () => {
  const tree = makeGitTree();
  // Give the tree a commit so `git rev-parse HEAD` (the LKG capture) succeeds.
  execFileSync("git", ["-C", tree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const r = evalInScript(`canary_promote deadbeefcafe 1`, {
    CORTEX_LIVE_TREE: tree,
    CORTEX_BETA_TREE: "/home/ubuntu/projects/cortex-beta",
    CORTEX_LIVE_SERVICE: "paperclip.service",
    CORTEX_LIVE_HEALTH_URL: "http://127.0.0.1:3100/api/health",
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /DRY-RUN canary: would/);
  assert.match(r.stdout, /db:backup live/);
  rmSync(tree, { recursive: true, force: true });
});

test("materialize_handoff (522f) writes the pre-primed recovery artifact before any live change", () => {
  // A tiny git tree stands in for both the beta snapshot source and the live tree.
  const tree = makeGitTree();
  execFileSync("git", ["-C", tree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "cut"]);
  const sha = execFileSync("git", ["-C", tree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const root = mkdtempSync(join(tmpdir(), "train-release-"));
  const r = evalInScript(`materialize_handoff ${sha} ${sha}`, {
    CORTEX_RELEASE_ROOT: root,
    CORTEX_BETA_TREE: tree,
    CORTEX_LIVE_TREE: tree,
    CORTEX_RELEASE_HANDOFF_SCRIPT: join(dirname(fileURLToPath(import.meta.url)), "cortex-release-handoff.sh"),
  });
  assert.equal(r.code, 0);
  const dir = r.stdout.trim();
  assert.equal(dir, join(root, sha.slice(0, 12)));
  assert.ok(existsSync(join(dir, "HANDOFF.md")), "HANDOFF.md should be materialized");
  assert.ok(existsSync(join(dir, "context.env")), "context.env sidecar should be materialized");
  rmSync(tree, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("escalate_oob (522f) fires the OOB recovery entrypoint with the handoff dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "train-esc-"));
  const recorder = join(dir, "recorder.sh");
  const out = join(dir, "invoked.txt");
  writeFileSync(recorder, `#!/usr/bin/env bash\necho "$@" > '${out}'\n`);
  chmodSync(recorder, 0o755);
  const r = evalInScript(`escalate_oob /var/lib/cortex-release/mycut`, {
    CORTEX_OOB_RECOVER_CMD: recorder,
  });
  assert.equal(r.code, 0);
  assert.match(readFileSync(out, "utf8"), /--handoff \/var\/lib\/cortex-release\/mycut/);
  rmSync(dir, { recursive: true, force: true });
});

test("resolve_candidate prefers the deploy state file over beta HEAD", () => {
  const dir = mkdtempSync(join(tmpdir(), "train-cand-"));
  const state = join(dir, "last-good.ref");
  writeFileSync(state, "  feedface1234  \n");
  const r = evalInScript(`resolve_candidate`, {
    CORTEX_DEPLOY_STATE_FILE: state,
    CORTEX_BETA_TREE: "/home/ubuntu/projects/cortex-beta",
  });
  assert.equal(r.stdout.trim(), "feedface1234");
  rmSync(dir, { recursive: true, force: true });
});
