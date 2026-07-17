import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "cortex-release-handoff.sh");

// Build a throwaway git tree that plays the role of BOTH the beta snapshot source and the live
// tree: an LKG commit, then a candidate commit that adds a migration + a release probe. The
// changelog range (LKG..candidate) then has real content to summarize.
function makeCut() {
  const tree = mkdtempSync(join(tmpdir(), "handoff-tree-"));
  const g = (...a) => execFileSync("git", ["-C", tree, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", tree]);
  mkdirSync(join(tree, "packages/db/src/migrations"), { recursive: true });
  writeFileSync(join(tree, "packages/db/src/migrations/0100_base.sql"), "-- base\n");
  g("add", "-A"); g("commit", "-q", "-m", "base (lkg)");
  const lkg = g("rev-parse", "HEAD").trim();
  // Candidate cut: a new migration + a per-issue probe.
  writeFileSync(join(tree, "packages/db/src/migrations/10007_neo999_widget.sql"), "-- neo999\n");
  mkdirSync(join(tree, "release-probes"), { recursive: true });
  writeFileSync(join(tree, "release-probes/NEO-999.yaml"), "probes:\n  - type: route\n");
  g("add", "-A"); g("commit", "-q", "-m", "feat(NEO-999): widget");
  const candidate = g("rev-parse", "HEAD").trim();
  return { tree, lkg, candidate };
}

function run(args, env = {}) {
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

test("script passes bash -n syntax check", () => {
  execFileSync("bash", ["-n", SCRIPT]);
});

test("changelog reports issues + added migrations + per-issue probes of the cut", () => {
  const { tree, lkg, candidate } = makeCut();
  const r = run(["changelog", candidate, lkg], { CORTEX_BETA_TREE: tree, CORTEX_LIVE_TREE: tree });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Version change log/);
  assert.match(r.stdout, /feat\(NEO-999\): widget/);          // commit in the cut
  assert.match(r.stdout, /10007_neo999_widget\.sql/);         // added migration flagged
  assert.match(r.stdout, /NEO-999/);                          // per-issue probe traced
  assert.match(r.stdout, new RegExp(candidate.slice(0, 12))); // candidate ref
  assert.match(r.stdout, new RegExp(lkg.slice(0, 12)));       // lkg ref
  rmSync(tree, { recursive: true, force: true });
});

test("materialize writes HANDOFF.md + context.env + latest symlink to the stable host path", () => {
  const { tree, lkg, candidate } = makeCut();
  const root = mkdtempSync(join(tmpdir(), "release-root-"));
  const r = run(["materialize", candidate, lkg], {
    CORTEX_RELEASE_ROOT: root, CORTEX_BETA_TREE: tree, CORTEX_LIVE_TREE: tree,
    CORTEX_LIVE_SERVICE: "paperclip.service", CORTEX_LIVE_HEALTH_URL: "http://127.0.0.1:3100/api/health",
  });
  assert.equal(r.code, 0);
  const dir = r.stdout.trim();
  assert.equal(dir, join(root, candidate.slice(0, 12)));      // cut id defaults to short sha

  const md = readFileSync(join(dir, "HANDOFF.md"), "utf8");
  // All five required sections of the artifact (NEO-532 acceptance).
  assert.match(md, /Version change log/);
  assert.match(md, /Restore to last-known-good/);
  assert.match(md, /Database restore/);
  assert.match(md, /Confirm recovery is green/);
  assert.match(md, /Per-change tracing/);
  assert.match(md, /Escalation path/);
  assert.match(md, new RegExp(lkg));                           // exact LKG ref + restore command
  assert.match(md, /cortex-oob-recover\.sh --restore/);       // points at the recovery entrypoint
  assert.match(md, /db:backup/);                              // §5 restore primitive named

  const ctx = readFileSync(join(dir, "context.env"), "utf8");
  assert.match(ctx, new RegExp(`CORTEX_HANDOFF_LKG='${lkg}'`));
  assert.match(ctx, new RegExp(`CORTEX_HANDOFF_CANDIDATE='${candidate}'`));
  assert.match(ctx, new RegExp(`CORTEX_HANDOFF_LIVE_TREE='${tree}'`));
  assert.match(ctx, /CORTEX_HANDOFF_BACKUP=''/);              // empty until record-backup

  // latest symlink resolves to this cut dir.
  assert.ok(lstatSync(join(root, "latest")).isSymbolicLink());
  assert.equal(realpathSync(join(root, "latest")), realpathSync(dir));
  rmSync(tree, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("record-backup fills the concrete pre-promotion backup path into an existing handoff", () => {
  const { tree, lkg, candidate } = makeCut();
  const root = mkdtempSync(join(tmpdir(), "release-root-"));
  run(["materialize", candidate, lkg], { CORTEX_RELEASE_ROOT: root, CORTEX_BETA_TREE: tree, CORTEX_LIVE_TREE: tree });
  const cut = candidate.slice(0, 12);
  const backup = "/home/ubuntu/.paperclip/instances/live/backups/pre-promo-123.sql";
  const r = run(["record-backup", cut, backup], { CORTEX_RELEASE_ROOT: root });
  assert.equal(r.code, 0);
  const ctx = readFileSync(join(root, cut, "context.env"), "utf8");
  assert.match(ctx, new RegExp(`CORTEX_HANDOFF_BACKUP='${backup.replace(/[/.]/g, "\\$&")}'`));
  const md = readFileSync(join(root, cut, "HANDOFF.md"), "utf8");
  assert.match(md, /Pre-promotion DB backup/);
  assert.match(md, /pre-promo-123\.sql/);
  rmSync(tree, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("materialize honors an explicit cut id", () => {
  const { tree, lkg, candidate } = makeCut();
  const root = mkdtempSync(join(tmpdir(), "release-root-"));
  const r = run(["materialize", candidate, lkg, "2026-w29"], { CORTEX_RELEASE_ROOT: root, CORTEX_BETA_TREE: tree, CORTEX_LIVE_TREE: tree });
  assert.equal(r.stdout.trim(), join(root, "2026-w29"));
  rmSync(tree, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});
