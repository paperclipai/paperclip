import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OOB = join(HERE, "cortex-oob-recover.sh");
const HANDOFF = join(HERE, "cortex-release-handoff.sh");

function git(tree, ...a) {
  return execFileSync("git", ["-C", tree, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
}

// A live tree with a green LKG commit and a "broken" candidate commit. Returns the two shas.
function makeLiveTree() {
  const tree = mkdtempSync(join(tmpdir(), "oob-live-"));
  execFileSync("git", ["init", "-q", tree]);
  writeFileSync(join(tree, "app.txt"), "good\n");
  git(tree, "add", "-A"); git(tree, "commit", "-q", "-m", "lkg (green)");
  const lkg = git(tree, "rev-parse", "HEAD").trim();
  writeFileSync(join(tree, "app.txt"), "broken\n");
  git(tree, "add", "-A"); git(tree, "commit", "-q", "-m", "candidate (broken)");
  const candidate = git(tree, "rev-parse", "HEAD").trim();
  return { tree, lkg, candidate };
}

function materialize(root, tree, candidate, lkg, extraEnv = {}) {
  const dir = execFileSync("bash", [HANDOFF, "materialize", candidate, lkg], {
    env: { ...process.env, CORTEX_RELEASE_ROOT: root, CORTEX_BETA_TREE: tree, CORTEX_LIVE_TREE: tree,
           CORTEX_LIVE_SERVICE: "paperclip.service", CORTEX_LIVE_HEALTH_URL: "http://127.0.0.1:3100/api/health",
           ...extraEnv },
    encoding: "utf8",
  }).trim();
  return dir;
}

function runOOB(args, env = {}) {
  // spawnSync captures stdout AND stderr regardless of exit code (the OOB script logs to stderr).
  // These tests themselves run inside a Paperclip heartbeat, so opt out of the heartbeat guard
  // (its own dedicated test above proves the guard fires). Callers may still override.
  const r = spawnSync("bash", [OOB, ...args], { env: { ...process.env, CORTEX_OOB_ALLOW_HEARTBEAT: "1", ...env }, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("script passes bash -n syntax check", () => {
  execFileSync("bash", ["-n", OOB]);
});

test("assert_independent REFUSES a handoff that lives inside the live tree (not out-of-band)", () => {
  const prog = `set -euo pipefail
export CORTEX_OOB_SOURCE_ONLY=1
source '${OOB}'
CORTEX_HANDOFF_LIVE_TREE=/home/ubuntu/projects/paperclip
assert_independent /home/ubuntu/projects/paperclip/var/handoff/cut`;
  const res = (() => { try { execFileSync("bash", ["-c", prog], { encoding: "utf8" }); return 0; } catch (e) { return e.status ?? 1; } })();
  assert.equal(res, 1);
});

test("assert_independent REFUSES running inside a Paperclip heartbeat (PAPERCLIP_RUN_ID set)", () => {
  const prog = `set -euo pipefail
export CORTEX_OOB_SOURCE_ONLY=1
source '${OOB}'
CORTEX_HANDOFF_LIVE_TREE=/home/ubuntu/projects/paperclip
assert_independent /var/lib/cortex-release/abc`;
  const res = (() => { try { execFileSync("bash", ["-c", prog], { env: { ...process.env, PAPERCLIP_RUN_ID: "run_123" }, encoding: "utf8" }); return 0; } catch (e) { return e.status ?? 1; } })();
  assert.equal(res, 1);
});

test("--agent with no CORTEX_OOB_AGENT_CMD wired exits non-zero with launch guidance", () => {
  const { tree, lkg, candidate } = makeLiveTree();
  const root = mkdtempSync(join(tmpdir(), "oob-root-"));
  const dir = materialize(root, tree, candidate, lkg);
  const r = runOOB(["--agent", "--handoff", dir], { CORTEX_RELEASE_ROOT: root, CORTEX_OOB_LOG: join(root, "oob.log") });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no CORTEX_OOB_AGENT_CMD wired/);
  assert.match(r.stderr, /cortex-oob-recover\.sh --restore/); // tells you the deterministic fallback
  rmSync(tree, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("--dry-run --restore prints the LKG restore plan and changes nothing", () => {
  const { tree, lkg, candidate } = makeLiveTree();
  const root = mkdtempSync(join(tmpdir(), "oob-root-"));
  const dir = materialize(root, tree, candidate, lkg);
  const headBefore = git(tree, "rev-parse", "HEAD").trim();
  const r = runOOB(["--dry-run", "--restore", "--handoff", dir], { CORTEX_RELEASE_ROOT: root, CORTEX_OOB_LOG: join(root, "oob.log") });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /DRY-RUN restore plan/);
  assert.match(r.stderr, new RegExp(`checkout --force ${lkg}`));
  assert.equal(git(tree, "rev-parse", "HEAD").trim(), headBefore); // untouched
  rmSync(tree, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// The acceptance-criteria end-to-end: a canary update failed (tree is on the broken candidate) and
// the deterministic auto-rollback did NOT restore green, so the OOB entrypoint is invoked. Using
// ONLY the handoff artifact + host tools, it must restore the live orchestrator to green. We model
// the "service" with injectable primitives: restart records the tree's checked-out HEAD as the
// "served" ref; health/verify are green only when the served ref == the last-known-good.
test("simulated failed canary update: --restore brings live back to green using only the handoff + host tools", () => {
  const { tree, lkg, candidate } = makeLiveTree();
  // Simulate the failed promotion / failed auto-rollback: the live tree is stuck on the broken candidate.
  git(tree, "checkout", "--force", "--quiet", candidate);
  assert.equal(git(tree, "rev-parse", "HEAD").trim(), candidate);

  const root = mkdtempSync(join(tmpdir(), "oob-root-")); // release root is OUTSIDE the live tree
  const dir = materialize(root, tree, candidate, lkg);

  // Injectable host-tool primitives that model a real service without systemd/curl/a live server.
  const hooks = mkdtempSync(join(tmpdir(), "oob-hooks-"));
  const served = join(hooks, "served.ref");
  const mk = (name, body) => { const p = join(hooks, name); writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`); chmodSync(p, 0o755); return p; };
  const build = mk("build.sh", `exit 0`);                                                  // build is a no-op
  const restart = mk("restart.sh", `git -C "$SIM_TREE" rev-parse HEAD > "$SIM_SERVED"`);   // "boot" serves the checked-out ref
  const health = mk("health.sh", `test "$(cat "$SIM_SERVED" 2>/dev/null)" = "$SIM_LKG"`);  // green iff serving LKG
  const verify = mk("verify.sh", `test "$(cat "$SIM_SERVED" 2>/dev/null)" = "$SIM_LKG"`);  // probes green iff serving LKG

  const env = {
    CORTEX_RELEASE_ROOT: root,
    CORTEX_OOB_LOG: join(root, "oob.log"),
    CORTEX_OOB_BUILD_CMD: build,
    CORTEX_OOB_RESTART_CMD: restart,
    CORTEX_OOB_HEALTH_CMD: health,
    CORTEX_OOB_VERIFY_CMD: verify,
    SIM_TREE: tree,
    SIM_SERVED: served,
    SIM_LKG: lkg,
  };

  const r = runOOB(["--restore", "--handoff", dir], env);
  assert.equal(r.code, 0, `restore should succeed:\n${r.stderr}`);
  assert.match(r.stderr, /restore COMPLETE/);
  // The recovery moved the live tree back to the last-known-good ref — proven by real git state.
  assert.equal(git(tree, "rev-parse", "HEAD").trim(), lkg);
  // And it surfaced the DB-restore caveat (code rollback can't undo an applied migration).
  assert.match(r.stderr, /DB RESTORE MAY BE REQUIRED/);

  rmSync(tree, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(hooks, { recursive: true, force: true });
});

// --auto with no agent wired falls back to the deterministic restore (same green outcome).
test("--auto with no agent wired falls back to deterministic restore", () => {
  const { tree, lkg, candidate } = makeLiveTree();
  git(tree, "checkout", "--force", "--quiet", candidate);
  const root = mkdtempSync(join(tmpdir(), "oob-root-"));
  const dir = materialize(root, tree, candidate, lkg);
  const hooks = mkdtempSync(join(tmpdir(), "oob-hooks-"));
  const served = join(hooks, "served.ref");
  const mk = (name, body) => { const p = join(hooks, name); writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`); chmodSync(p, 0o755); return p; };
  const env = {
    CORTEX_RELEASE_ROOT: root, CORTEX_OOB_LOG: join(root, "oob.log"),
    CORTEX_OOB_BUILD_CMD: mk("b.sh", "exit 0"),
    CORTEX_OOB_RESTART_CMD: mk("r.sh", `git -C "$SIM_TREE" rev-parse HEAD > "$SIM_SERVED"`),
    CORTEX_OOB_HEALTH_CMD: mk("h.sh", `test "$(cat "$SIM_SERVED" 2>/dev/null)" = "$SIM_LKG"`),
    CORTEX_OOB_VERIFY_CMD: mk("v.sh", `exit 0`),
    SIM_TREE: tree, SIM_SERVED: served, SIM_LKG: lkg,
  };
  const r = runOOB(["--auto", "--handoff", dir], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /falling back to deterministic LKG restore/);
  assert.equal(git(tree, "rev-parse", "HEAD").trim(), lkg);
  rmSync(tree, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(hooks, { recursive: true, force: true });
});
