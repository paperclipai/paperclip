#!/usr/bin/env node
/**
 * preflight-server-update.mjs
 *
 * Pre-flight gate for a self-hosted deploy workflow that keeps a live
 * control-plane serving tree in sync by resetting it to `origin/master` via
 * `git reset --hard` (the primary checkout, `~/Paperclip` by default).
 *
 * Why this exists:
 *   A `git reset --hard origin/master` is a DESTRUCTIVE rebuild of the serving
 *   tree. Anything present only as local state that is NOT on `origin/master`
 *   is silently wiped. In practice this bites when a runtime fix is applied as
 *   a live hotpatch, or marked "done" on the basis of uncommitted local edits,
 *   but never merged upstream — the next reset reverts it with no warning.
 *   Root pattern: "done on the live tree" != durable.
 *
 * What it does:
 *   Inspects the target tree for local divergence the reset would destroy or
 *   abandon relative to `origin/master`, and REFUSES (non-zero exit) when it
 *   finds blocking divergence that has not been explicitly acknowledged.
 *
 *   Reset semantics this check is built on:
 *     - `git reset --hard` DESTROYS tracked uncommitted changes (staged +
 *       unstaged edits/deletes to tracked files)               -> BLOCK
 *     - it ABANDONS commits ahead of origin/master from the branch ref
 *       (recoverable via reflog / a backup branch, but not on master) -> BLOCK
 *     - it does NOT touch stashes                               -> WARN
 *     - it does NOT touch untracked files                       -> INFO
 *
 * Exit codes:
 *   0  safe to reset (clean, or blocking divergence explicitly acked)
 *   2  blocked: local divergence not on origin/master and not acknowledged
 *   1  usage / git error
 *
 * Target tree resolution: --tree <path>, else $PAPERCLIP_LIVE_TREE, else
 * ~/Paperclip (the primary checkout on this instance).
 *
 * Usage:
 *   node scripts/preflight-server-update.mjs                 # target = live tree, fetch first
 *   node scripts/preflight-server-update.mjs --tree /path    # inspect another tree
 *   node scripts/preflight-server-update.mjs --no-fetch      # skip `git fetch origin master`
 *   node scripts/preflight-server-update.mjs --json          # machine-readable verdict
 *   node scripts/preflight-server-update.mjs --ack "live-hotpatch, durable deploy tracked in #1234"
 *
 * The `--ack "<reason>"` escape hatch is the explicit, audited exception path
 * for a legitimate live hotpatch whose durable deploy is tracked elsewhere.
 * The reason string is echoed to stdout so it lands in the run log. Use a real
 * ticket id; a reset that regresses an un-ticketed fix is the exact failure
 * this gate exists to prevent.
 */

import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// The live serving tree is the primary checkout. Resolved at runtime so no
// operator-specific absolute path is baked into the repo.
const DEFAULT_TREE =
  process.env.PAPERCLIP_LIVE_TREE || path.join(os.homedir(), "Paperclip");
const UPSTREAM = "origin/master";

export const SEVERITY = { BLOCK: "block", WARN: "warn", INFO: "info" };

/**
 * Pure verdict function. Takes an already-gathered git state snapshot and
 * returns { verdict, findings, blocking } with no I/O — this is the part unit
 * tests exercise.
 *
 * @param {object} state
 * @param {string[]} state.aheadCommits  one-line summaries of origin/master..HEAD
 * @param {string[]} state.trackedUncommitted  porcelain lines for tracked changes (no `??`)
 * @param {string[]} state.untracked  porcelain paths for untracked files (`??`)
 * @param {string[]} state.stashes  `git stash list` lines
 * @param {string|null} state.ack  acknowledgement reason, or null
 */
export function evaluatePreflight(state) {
  const {
    aheadCommits = [],
    trackedUncommitted = [],
    untracked = [],
    stashes = [],
    ack = null,
  } = state;

  const findings = [];

  if (trackedUncommitted.length > 0) {
    findings.push({
      kind: "tracked_uncommitted",
      severity: SEVERITY.BLOCK,
      count: trackedUncommitted.length,
      detail: trackedUncommitted,
      message:
        "Tracked uncommitted changes will be DESTROYED by `reset --hard`. " +
        "Commit them to a backup branch (and land via PR) before resetting.",
    });
  }

  if (aheadCommits.length > 0) {
    findings.push({
      kind: "ahead_commits",
      severity: SEVERITY.BLOCK,
      count: aheadCommits.length,
      detail: aheadCommits,
      message:
        `Local commits are ahead of ${UPSTREAM} and will be abandoned from the ` +
        "branch. Each must already be on origin/master (landed via PR) or " +
        "captured on a backup branch AND tracked by an open PR/issue.",
    });
  }

  if (stashes.length > 0) {
    findings.push({
      kind: "stashes",
      severity: SEVERITY.WARN,
      count: stashes.length,
      detail: stashes,
      message:
        "Stashes survive `reset --hard` but are easily orphaned. Confirm none " +
        "carries an un-landed runtime fix — a fix preserved only as a stash " +
        "still regresses on the live tree once the reset lands.",
    });
  }

  if (untracked.length > 0) {
    findings.push({
      kind: "untracked",
      severity: SEVERITY.INFO,
      count: untracked.length,
      detail: untracked,
      message:
        "Untracked files survive `reset --hard`. Usually runtime noise; scan " +
        "for any stray source file that should be captured.",
    });
  }

  const blocking = findings.filter((f) => f.severity === SEVERITY.BLOCK);
  const acked = Boolean(ack && ack.trim());
  const verdict =
    blocking.length === 0 ? "clean" : acked ? "acked" : "blocked";

  return { verdict, findings, blocking, ack: acked ? ack.trim() : null };
}

function git(tree, args) {
  return execFileSync("git", ["-C", tree, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseArgs(argv) {
  const opts = { tree: DEFAULT_TREE, fetch: true, json: false, ack: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tree") opts.tree = argv[++i];
    else if (a === "--no-fetch") opts.fetch = false;
    else if (a === "--json") opts.json = true;
    else if (a === "--ack") opts.ack = argv[++i] ?? "";
    else if (a === "-h" || a === "--help") opts.help = true;
    else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function gatherState(tree, { fetch }) {
  // Confirm this is a git tree up front for a clean error.
  git(tree, ["rev-parse", "--git-dir"]);

  if (fetch) {
    git(tree, ["fetch", "origin", "master", "--quiet"]);
  }

  const head = git(tree, ["rev-parse", "--short", "HEAD"]).trim();
  const upstream = git(tree, ["rev-parse", "--short", UPSTREAM]).trim();

  const aheadCommits = git(tree, ["log", "--oneline", `${UPSTREAM}..HEAD`])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const porcelain = git(tree, ["status", "--porcelain"])
    .split("\n")
    .filter((l) => l.length > 0);
  const trackedUncommitted = porcelain.filter((l) => !l.startsWith("??"));
  const untracked = porcelain.filter((l) => l.startsWith("??"));

  const stashes = git(tree, ["stash", "list"])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return { head, upstream, aheadCommits, trackedUncommitted, untracked, stashes };
}

function render(state, result, opts) {
  const lines = [];
  lines.push("Server-update pre-flight");
  lines.push(`  tree:     ${opts.tree}`);
  lines.push(`  HEAD:     ${state.head}`);
  lines.push(`  ${UPSTREAM}: ${state.upstream}`);
  lines.push("");

  if (result.findings.length === 0) {
    lines.push("  ✓ clean — no local divergence. Safe to reset to origin/master.");
  } else {
    for (const f of result.findings) {
      const icon =
        f.severity === SEVERITY.BLOCK
          ? "✗"
          : f.severity === SEVERITY.WARN
            ? "!"
            : "·";
      lines.push(`  ${icon} [${f.severity}] ${f.kind} (${f.count})`);
      lines.push(`      ${f.message}`);
      for (const d of f.detail.slice(0, 12)) lines.push(`        ${d}`);
      if (f.detail.length > 12)
        lines.push(`        … and ${f.detail.length - 12} more`);
    }
  }

  lines.push("");
  if (result.verdict === "clean") {
    lines.push("VERDICT: SAFE TO RESET.");
  } else if (result.verdict === "acked") {
    lines.push(`VERDICT: ACKNOWLEDGED — proceeding despite blocking divergence.`);
    lines.push(`  ack: ${result.ack}`);
  } else {
    lines.push("VERDICT: BLOCKED — do not reset.");
    lines.push(
      "  Capture the blocking items on a backup branch and land them on " +
        "origin/master (or track the durable deploy in a ticket), then re-run.",
    );
    lines.push(
      '  To override with an explicit audited exception: --ack "reason + ticket".',
    );
  }
  return lines.join("\n");
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
  }

  if (opts.help) {
    console.log(
      "Usage: node scripts/preflight-server-update.mjs " +
        "[--tree <path>] [--no-fetch] [--json] [--ack <reason>]",
    );
    process.exit(0);
  }

  let state;
  try {
    state = gatherState(opts.tree, opts);
  } catch (err) {
    console.error(`git error while inspecting ${opts.tree}:`);
    console.error(String(err.stderr || err.message || err).trim());
    process.exit(1);
  }

  const result = evaluatePreflight({ ...state, ack: opts.ack });

  if (opts.json) {
    console.log(JSON.stringify({ ...state, ...result }, null, 2));
  } else {
    console.log(render(state, result, opts));
  }

  process.exit(result.verdict === "blocked" ? 2 : 0);
}

// Only run when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
