#!/usr/bin/env node
/**
 * check-live-tree.mjs
 *
 * The tree the server runs from is production.
 *
 * The server runs under `tsx watch`, so that tree's files are the deployed
 * bytes: every save is a deploy, and a half-written file is a half-deployed
 * server. On 2026-07-14 an in-progress feature sitting uncommitted in it
 * hot-reloaded into the running process and 500'd every issues route
 * company-wide (LOOA-371).
 *
 * The invariant, therefore:
 *
 *   The live tree is only ever on `master`, and only ever clean.
 *
 * *Which* tree that is comes from `scripts/live-service.mjs`, which asks the
 * serving process rather than assuming a layout. Until LOOA-382 the answer was
 * the main worktree; after it, the server runs from a dedicated checkout that
 * no agent enters. Deriving it from the running process means this check stays
 * correct across that move instead of confidently guarding the wrong directory.
 *
 * This script is the *detector*; `scripts/git-hooks/pre-commit` is the
 * *preventer* (it refuses commits that author new work in the main worktree).
 * Install the hooks with `pnpm hooks:install`. Note that neither can see a
 * *save* or a *checkout* -- only a dedicated serving tree removes those, which
 * is what LOOA-382 does.
 *
 * A merge/revert/cherry-pick/rebase in progress is the sanctioned way `master`
 * advances, so it is reported as a transient state rather than a violation --
 * a checker that cries wolf gets switched off.
 *
 * Usage:
 *   node scripts/check-live-tree.mjs          # exit 1 on violation
 *   node scripts/check-live-tree.mjs --json
 *
 * Runnable from any worktree: it always inspects the live one.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { resolveLiveTree } from "./live-service.mjs";

/** Branch the main worktree must be parked on. */
export const LIVE_BRANCH = "master";

/**
 * Git state files that mean "an integration is mid-flight". These are the
 * sanctioned ways master advances, and they legitimately leave the tree dirty
 * and/or on a detached HEAD, so they are not violations.
 */
const INTEGRATION_MARKERS = [
  "MERGE_HEAD",
  "REVERT_HEAD",
  "CHERRY_PICK_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
];

/**
 * Pure predicate: given the observed state of the main worktree, is the
 * invariant intact?
 *
 * @param {{ branch: string, dirtyPaths: string[], integrationInProgress: boolean }} state
 * @returns {{ ok: boolean, transient: boolean, violations: Array<{code: string, detail: string}> }}
 */
export function evaluateLiveTree(state) {
  const { branch, dirtyPaths = [], integrationInProgress = false } = state;

  // A merge in flight is how master is *supposed* to move. Don't alarm on it.
  if (integrationInProgress) {
    return { ok: true, transient: true, violations: [] };
  }

  const violations = [];

  if (branch !== LIVE_BRANCH) {
    violations.push({
      code: "off-master",
      detail:
        `the live tree is on '${branch}', not '${LIVE_BRANCH}' -- the server is ` +
        `serving that branch's code`,
    });
  }

  if (dirtyPaths.length > 0) {
    violations.push({
      code: "dirty",
      detail:
        `${dirtyPaths.length} uncommitted path(s) in the live tree -- ` +
        `every save is hot-reloaded into the running server: ${dirtyPaths
          .slice(0, 10)
          .join(", ")}${dirtyPaths.length > 10 ? ", ..." : ""}`,
    });
  }

  return { ok: violations.length === 0, transient: false, violations };
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function inspectLiveTree(cwd = process.cwd()) {
  const { tree: liveTree, source, service } = resolveLiveTree(cwd);
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"], liveTree);

  const integrationInProgress = INTEGRATION_MARKERS.some((marker) =>
    existsSync(path.join(gitDir, marker)),
  );

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], liveTree);
  const dirtyPaths = git(["status", "--porcelain"], liveTree)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));

  return {
    liveTree,
    source,
    service,
    state: { branch, dirtyPaths, integrationInProgress },
    result: evaluateLiveTree({ branch, dirtyPaths, integrationInProgress }),
  };
}

function main() {
  const asJson = process.argv.includes("--json");
  const { liveTree, source, service, state, result } = inspectLiveTree();

  const provenance =
    source === "service-registry"
      ? `served by pid ${service.pid} on ${service.url ?? "?"}`
      : `no server registered -- assuming the main worktree`;

  if (asJson) {
    console.log(JSON.stringify({ liveTree, source, service, ...state, ...result }, null, 2));
  } else if (result.transient) {
    console.log(`live tree (${liveTree}): integration in progress -- skipping check`);
  } else if (result.ok) {
    console.log(`live tree (${liveTree}): clean, on ${LIVE_BRANCH}  [${provenance}]`);
  } else {
    console.error(`LIVE TREE VIOLATION -- ${liveTree} is production (${provenance}).\n`);
    for (const violation of result.violations) {
      console.error(`  [${violation.code}] ${violation.detail}`);
    }
    console.error(
      `\nThe server runs from this tree under \`tsx watch\`, so its working files are\n` +
        `the deployed bytes. Move the work into a linked worktree:\n\n` +
        `  git -C ${liveTree} stash                          # or: git switch -c <branch> && git commit\n` +
        `  git worktree add ../paperclip-<ticket> -b <branch>\n\n` +
        `Never discard the work to clear this -- preserve it first, then restore master.`,
    );
  }

  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
