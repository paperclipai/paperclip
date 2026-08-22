#!/usr/bin/env node
/**
 * reap-stale-workspaces.mjs
 *
 * Host-side disk retention for Paperclip agent execution workspaces
 * (`~/.paperclip*\/instances/*\/workspaces\/**`). Busy fleets create one git
 * checkout per assigned issue and never remove it, so `node_modules` from
 * finished-but-still-open-PR work accumulates until the host runs out of
 * disk (see the "workspace cleanup" incidents below).
 *
 * SAFETY MODEL — read before changing the defaults
 * --------------------------------------------------
 * Two prior incidents (#3207, #10555) show that "clean up the workspace"
 * destroyed real work: unpushed commits and 2309 uncommitted files were
 * permanently deleted with no recovery path, because the code treated a
 * dirty/ahead-of-remote tree as a *warning* instead of a hard block. This
 * script is deliberately more conservative than that:
 *
 *   1. Default action is `node_modules`-only removal. `node_modules` is
 *      never git-tracked, so removing it can never lose a commit, an
 *      uncommitted edit, or a branch — it is fully reproduced by the
 *      project's own package manager from a lockfile that IS committed.
 *      This action does not require the branch to be merged or the PR to
 *      be closed, because it does not touch anything PR/branch related.
 *
 *   2. Removing the *entire* worktree (git checkout, branch, uncommitted
 *      scratch files) is opt-in (`--remove-merged-worktrees`) and is only
 *      taken when ALL of the following hold:
 *        - no active agent/session is using the directory right now
 *          (verified with `lsof`, not assumed from issue/run status),
 *        - `git status --porcelain` is empty (nothing uncommitted),
 *        - HEAD matches the remote tracking branch (nothing unpushed),
 *        - the branch's PR (if any) is MERGED or CLOSED — never OPEN,
 *        - the directory is not a shared `git worktree` parent/child of
 *          another still-in-use checkout.
 *      Any failure to positively confirm one of these (network error,
 *      `gh` unavailable, ambiguous git state) fails CLOSED: the worktree
 *      is preserved, never removed.
 *
 *   3. Every path this script ever touches is realpath-resolved and must
 *      be strictly contained in an allow-listed Paperclip-managed root
 *      (`~/.paperclip*\/instances/*\/workspaces`). Anything outside that,
 *      or any symlink escaping it, is refused — never deleted, never
 *      even statted destructively.
 *
 *   4. Dry-run is the default for both tiers. Nothing is deleted unless
 *      `--apply` is passed.
 *
 * Usage:
 *   node scripts/reap-stale-workspaces.mjs [--apply] [--remove-merged-worktrees]
 *     [--root <dir>]... [--json] [--max-depth <n>]
 *
 * Env overrides (used by tests to avoid touching real git remotes/lsof):
 *   REAP_HOME                    override $HOME for root discovery
 *   REAP_PR_LOOKUP_CMD            "<cmd> <owner> <repo> <branch>" -> stdout
 *                                 one of: merged | closed | open | none | unknown
 *   REAP_ACTIVE_SESSION_CMD       "<cmd> <dir>" -> exit 0 = active, 1 = inactive
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const LOCKFILE_NAMES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
];

/** Directory names we never recurse into while searching for git worktrees. */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next"]);

// ---------------------------------------------------------------------------
// Pure helpers (fully unit-tested, no I/O)
// ---------------------------------------------------------------------------

/**
 * Fail-closed containment check. Returns true only when `realTarget` is
 * strictly inside one of `allowedRealRoots` (never equal to a root itself —
 * a root is a container, not a reapable unit). Both inputs must already be
 * realpath-resolved by the caller; this function does no I/O so it stays
 * trivially testable.
 */
export function isContainedInAllowedRoots(realTarget, allowedRealRoots) {
  if (!realTarget || allowedRealRoots.length === 0) return false;
  return allowedRealRoots.some((root) => {
    if (!root) return false;
    const withSep = root.endsWith(path.sep) ? root : root + path.sep;
    return realTarget !== root && realTarget.startsWith(withSep);
  });
}

/** `git status --porcelain` output -> true when the tree is clean. */
export function isGitStatusClean(porcelainOutput) {
  return porcelainOutput.trim().length === 0;
}

/**
 * True when `git status --porcelain` output shows a modification to one of
 * the recognized lockfiles. Found empirically on a live host: a worktree can
 * be mid-edit on `pnpm-lock.yaml` itself (e.g. adding a dependency) while
 * everything else about it looks reapable. In that state the *committed*
 * lockfile no longer matches the working tree's `node_modules`, so removing
 * `node_modules` would not be reliably reproducible by a plain reinstall —
 * this must block the node_modules-only tier even though a lockfile is
 * technically committed.
 */
export function isLockfileDirty(porcelainOutput) {
  return porcelainOutput
    .split("\n")
    .some((line) => LOCKFILE_NAMES.some((name) => line.trim().endsWith(name)));
}

/**
 * Given `git ls-files` output (newline separated repo-relative paths),
 * true when at least one recognized lockfile is tracked, meaning a plain
 * package-manager install fully reproduces `node_modules`.
 */
/**
 * True when the last commit landed within `thresholdMinutes` of `nowSeconds`.
 * Found on a live host: a worktree can have zero open file handles (nothing
 * for `lsof` to see) yet have a commit from 24 minutes earlier, i.e. an agent
 * mid-task between tool calls, not an idle/abandoned worktree. `lsof` alone
 * only proves "not touching it this instant"; recent commit activity is a
 * cheap, git-native proxy for "may resume any second" that `lsof` cannot see.
 * This is an additional, independent guard -- not a replacement for the
 * active-session (`lsof`) check.
 */
export function isRecentlyCommitted(lastCommitEpochSeconds, nowSeconds, thresholdMinutes) {
  if (lastCommitEpochSeconds == null) return false; // unknown history — nothing to flag on this signal
  if (!(thresholdMinutes > 0)) return false;
  const ageSeconds = nowSeconds - lastCommitEpochSeconds;
  if (ageSeconds < 0) return false; // clock skew / future commit — do not fail closed on this signal alone
  return ageSeconds < thresholdMinutes * 60;
}

export function hasCommittedLockfile(lsFilesOutput) {
  const files = new Set(
    lsFilesOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return LOCKFILE_NAMES.some((name) => files.has(name));
}

/**
 * Given `git ls-files` output, true when at least one tracked path lives
 * inside `node_modules/`. `node_modules` is conventionally .gitignore'd and
 * therefore untracked, but a project can `git add -f` a patched dependency
 * file into it. If that ever happens, "reinstallable from the committed
 * lockfile" is no longer true: a plain package-manager install overwrites
 * that file back to the vanilla upstream version, silently discarding a
 * committed patch that `git checkout` could otherwise have restored. This
 * must block the node_modules-only tier even when the lockfile itself is
 * clean and committed.
 */
export function hasTrackedFilesUnderNodeModules(lsFilesOutput) {
  return lsFilesOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((file) => file === "node_modules" || file.startsWith("node_modules/"));
}

/**
 * Parses `owner/repo` out of a git remote URL (https or ssh form).
 * Returns null when the URL doesn't look like a GitHub remote.
 */
export function parseGitHubOwnerRepo(remoteUrl) {
  const trimmed = remoteUrl.trim();
  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
    /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return { owner: m[1], repo: m[2] };
  }
  return null;
}

/**
 * Pure decision function — the entire reap/preserve policy lives here so it
 * can be tested exhaustively without touching git, gh, or the filesystem.
 *
 * @param {object} facts
 * @param {boolean} facts.activeSession - a process currently has open files/cwd here
 * @param {boolean} facts.gitClean - `git status --porcelain` is empty
 * @param {boolean} facts.aheadOfRemote - local HEAD has commits not on the remote branch
 * @param {"merged"|"closed"|"open"|"none"|"unknown"} facts.prState
 * @param {boolean} facts.hasNodeModules
 * @param {boolean} facts.hasCommittedLockfile
 * @param {boolean} facts.lockfileDirty - the committed lockfile itself has uncommitted edits
 * @param {boolean} facts.nodeModulesTracked - `git ls-files` shows a tracked path under node_modules/
 * @param {boolean} facts.recentlyCommitted - HEAD landed within the recent-commit threshold
 * @param {boolean} facts.isSharedWorktreeParent - `git worktree list` shows >1 entry
 * @param {boolean} facts.hasUnsafeExtraGitState - an unpushed other local branch, a stash, or a local-only tag exists
 * @param {boolean} facts.allowWorktreeRemoval - `--remove-merged-worktrees` was passed
 * @returns {{ action: "reap-worktree" | "reap-node-modules" | "preserve", reason: string }}
 */
export function decideAction(facts) {
  const {
    activeSession,
    gitClean,
    aheadOfRemote,
    prState,
    hasNodeModules,
    hasCommittedLockfile: hasLockfile,
    lockfileDirty,
    nodeModulesTracked,
    recentlyCommitted,
    isSharedWorktreeParent,
    hasUnsafeExtraGitState: unsafeExtraGitState,
    allowWorktreeRemoval,
  } = facts;

  if (activeSession) {
    return { action: "preserve", reason: "active agent/session has open files or cwd here" };
  }

  if (recentlyCommitted) {
    return {
      action: "preserve",
      reason: "HEAD committed within the recent-activity window — a session may resume any moment even with no open file handles",
    };
  }

  const prSaysMergedOrClosed = prState === "merged" || prState === "closed";

  if (
    allowWorktreeRemoval &&
    gitClean &&
    !aheadOfRemote &&
    prSaysMergedOrClosed &&
    !isSharedWorktreeParent &&
    !unsafeExtraGitState
  ) {
    return {
      action: "reap-worktree",
      reason: `clean, fully pushed, PR ${prState}, no extra local branches/stash/tags — safe to remove entire worktree`,
    };
  }

  if (!hasNodeModules) {
    return { action: "preserve", reason: "no node_modules to reclaim and worktree removal not eligible" };
  }

  if (!hasLockfile) {
    return { action: "preserve", reason: "node_modules present but no committed lockfile — reinstall not guaranteed" };
  }

  if (lockfileDirty) {
    return {
      action: "preserve",
      reason: "the committed lockfile itself has uncommitted edits — node_modules may not match any committed state",
    };
  }

  if (nodeModulesTracked) {
    return {
      action: "preserve",
      reason: "a git-tracked file exists under node_modules/ — a plain reinstall would not reproduce it",
    };
  }

  return {
    action: "reap-node-modules",
    reason: "inactive; node_modules is untracked and fully reinstallable from the committed lockfile",
  };
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)}${units[unitIndex]}`;
}

// ---------------------------------------------------------------------------
// Filesystem discovery
// ---------------------------------------------------------------------------

/**
 * Expands both worktree-root conventions observed in the wild without a
 * shell glob dependency:
 *   - `~/.paperclip*\/instances/*\/workspaces` (current convention — one
 *     directory per agent, sub-checkouts per issue underneath).
 *   - `~/.paperclip-worktrees` (an older, still-active convention: named
 *     checkouts directly under this single directory, no `instances` layer).
 */
export function discoverDefaultRoots(homeDir) {
  const roots = [];
  let entries = [];
  try {
    entries = readdirSync(homeDir, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== ".paperclip" && !entry.name.startsWith(".paperclip.") && !entry.name.startsWith(".paperclip-")) {
      continue;
    }
    if (entry.name === ".paperclip-worktrees") {
      roots.push(path.join(homeDir, entry.name));
      continue;
    }
    const instancesDir = path.join(homeDir, entry.name, "instances");
    let instanceEntries = [];
    try {
      instanceEntries = readdirSync(instancesDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const inst of instanceEntries) {
      if (!inst.isDirectory()) continue;
      const workspacesDir = path.join(instancesDir, inst.name, "workspaces");
      if (existsSync(workspacesDir)) roots.push(workspacesDir);
    }
  }
  return roots;
}

/**
 * Breadth-first search, bounded by depth, for directories that are git
 * working directories (contain `.git`, file or directory form — the latter
 * covers `git worktree add` checkouts). Stops descending once a git root is
 * found so we never look inside a nested checkout's own working tree.
 */
export function findGitWorkTrees(rootDir, maxDepth = 4) {
  const found = [];
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const hasGit = entries.some((e) => e.name === ".git");
    if (hasGit) {
      found.push(dir);
      continue; // do not recurse into a discovered working tree
    }
    if (depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Git / gh integrations (thin wrappers, injectable via env for tests)
// ---------------------------------------------------------------------------

function runGit(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function getBranch(cwd) {
  try {
    return runGit(cwd, ["branch", "--show-current"]).trim();
  } catch {
    return "";
  }
}

export function getGitStatusPorcelain(cwd) {
  return runGit(cwd, ["status", "--porcelain"]);
}

export function getLsFiles(cwd) {
  return runGit(cwd, ["ls-files"]);
}

/** Seconds-since-epoch of HEAD's commit time, or null if it cannot be read. */
export function getLastCommitEpochSeconds(cwd) {
  try {
    const raw = runGit(cwd, ["log", "-1", "--format=%ct"]).trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function getUpstreamRef(cwd, branch) {
  if (!branch) return null;
  try {
    return runGit(cwd, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]).trim() || null;
  } catch {
    return null;
  }
}

export function isAheadOfRemote(cwd, branch) {
  const upstream = getUpstreamRef(cwd, branch);
  if (!upstream) return true; // detached HEAD, no upstream, or unknown — fail closed, assume ahead
  try {
    const counts = runGit(cwd, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]).trim();
    const [, aheadStr] = counts.split(/\s+/);
    return Number(aheadStr) > 0;
  } catch {
    return true; // command failed — fail closed
  }
}

export function getRemoteOriginUrl(cwd) {
  try {
    return runGit(cwd, ["remote", "get-url", "origin"]).trim();
  } catch {
    return "";
  }
}

export function isSharedWorktreeParent(cwd) {
  try {
    const listing = runGit(cwd, ["worktree", "list", "--porcelain"]);
    const worktreeLines = listing.split("\n").filter((l) => l.startsWith("worktree "));
    return worktreeLines.length > 1;
  } catch {
    return true; // can't confirm isolation — fail closed
  }
}

/** Local branch names in this repo (`git for-each-ref refs/heads`), or null on error. */
export function getLocalBranches(cwd) {
  try {
    const out = runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null; // unknown — caller must fail closed
  }
}

/**
 * True when `branchRef`'s commit is reachable from at least one
 * remote-tracking ref (`refs/remotes/**`) in this repo — i.e. its history is
 * already mirrored on some remote, even if the branch itself has no matching
 * upstream. Used to tell apart a harmless leftover branch (e.g. the `main`
 * every plain `git clone` keeps locally alongside a checked-out feature
 * branch, fully contained in `origin/main`) from a branch that holds commits
 * that only exist on this disk.
 */
export function isBranchReachableFromAnyRemote(cwd, branchRef) {
  let remoteRefs;
  try {
    remoteRefs = runGit(cwd, ["for-each-ref", "--format=%(refname)", "refs/remotes/"])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return false; // unknown — fail closed (treat as NOT safely mirrored)
  }
  for (const remoteRef of remoteRefs) {
    try {
      execFileSync("git", ["-C", cwd, "merge-base", "--is-ancestor", branchRef, remoteRef], { stdio: "ignore" });
      return true; // fully contained in this remote ref
    } catch {
      // not an ancestor of this remote ref — try the next one
    }
  }
  return false;
}

/**
 * True when at least one local branch OTHER than `currentBranch` holds
 * commits not reachable from any remote-tracking ref — i.e. genuinely
 * unpushed, disk-only history a full worktree removal would destroy. Null
 * (fail closed) when the local branch list itself can't be determined.
 * Merely having another local branch (e.g. a clone's default branch left
 * over after checking out a feature branch) is NOT by itself unsafe — only
 * when that branch's commits exist nowhere else.
 */
export function hasUnpushedOtherLocalBranch(cwd, currentBranch) {
  const branches = getLocalBranches(cwd);
  if (branches === null) return null;
  const others = branches.filter((b) => b !== currentBranch);
  for (const other of others) {
    if (!isBranchReachableFromAnyRemote(cwd, other)) return true;
  }
  return false;
}

/** Number of `git stash` entries in this repo, or null on error. */
export function getStashCount(cwd) {
  try {
    const out = runGit(cwd, ["stash", "list"]);
    return out.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return null; // unknown — caller must fail closed
  }
}

/**
 * Local tags whose commit is NOT reachable from `upstreamRef` (the branch's
 * pushed tracking ref), or null when this can't be determined. A tag like
 * this can point at a commit that would otherwise be unreachable from any
 * pushed branch — exactly the kind of "remote-unavailable" history a full
 * worktree removal must not silently destroy. Deliberately checked via local
 * ancestry (`git merge-base --is-ancestor`) against the already-resolved
 * upstream ref rather than a network `git ls-remote` call: it needs no extra
 * network round trip, and it answers the more precise question ("is this
 * tag's commit preserved by the push we already validated?") rather than
 * merely "does a same-named tag exist on the remote?".
 */
export function getLocalOnlyTags(cwd, upstreamRef) {
  try {
    const localTags = runGit(cwd, ["tag", "--list"])
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
    if (localTags.length === 0) return [];
    if (!upstreamRef) return localTags; // no safe ref to compare against — treat all as unverifiable/local-only
    return localTags.filter((tag) => {
      try {
        execFileSync("git", ["-C", cwd, "merge-base", "--is-ancestor", tag, upstreamRef], { stdio: "ignore" });
        return false; // tag's commit is an ancestor of the pushed upstream — already safely preserved remotely
      } catch {
        return true; // not an ancestor (or command failed) — treat as local-only, fail closed
      }
    });
  } catch {
    return null; // unknown — caller must fail closed
  }
}

/**
 * True when this repo carries git state beyond "the current branch, fully
 * pushed" that a full worktree removal (`rmSync` of the whole directory)
 * would permanently destroy: an unpushed OTHER local branch (one whose
 * commits are not mirrored on any remote — NOT merely "another branch
 * exists", since e.g. a plain `git clone` always keeps the default branch
 * locally alongside a checked-out feature branch, with zero unique commits),
 * any stash entry, or any local-only tag. Also true (fail closed) when any
 * of the three underlying signals could not be determined at all.
 */
export function hasUnsafeExtraGitState({ hasUnpushedOtherBranch, stashCount, localOnlyTags }) {
  if (hasUnpushedOtherBranch === null || stashCount === null || localOnlyTags === null) return true;
  if (hasUnpushedOtherBranch) return true;
  if (stashCount > 0) return true;
  if (localOnlyTags.length > 0) return true;
  return false;
}

/** Resolves PR state for a branch. Injectable via REAP_PR_LOOKUP_CMD for tests. */
export function resolvePrState(owner, repo, branch, env = process.env) {
  const lookupCmd = env.REAP_PR_LOOKUP_CMD;
  try {
    if (lookupCmd) {
      const out = execFileSync(lookupCmd, [owner, repo, branch], { encoding: "utf8" }).trim();
      return out || "unknown";
    }
    const json = execFileSync(
      "gh",
      ["pr", "list", "-R", `${owner}/${repo}`, "--head", branch, "--state", "all", "--json", "state,mergedAt"],
      { encoding: "utf8" },
    );
    const prs = JSON.parse(json);
    if (prs.length === 0) return "none";
    if (prs.some((pr) => pr.mergedAt)) return "merged";
    if (prs.some((pr) => pr.state === "OPEN")) return "open";
    if (prs.every((pr) => pr.state === "CLOSED")) return "closed";
    return "unknown";
  } catch {
    return "unknown"; // gh missing / network error / bad output — fail closed
  }
}

/** True when any process has an open file handle or cwd under `dir`. */
export function hasActiveSession(dir, env = process.env) {
  const probeCmd = env.REAP_ACTIVE_SESSION_CMD;
  try {
    if (probeCmd) {
      execFileSync(probeCmd, [dir], { stdio: "ignore" });
      return true; // exit 0 = active per the documented contract
    }
    const out = execFileSync("lsof", ["+D", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().length > 0;
  } catch (err) {
    if (probeCmd) return false; // probe exits non-zero => inactive
    if (err && err.status === 1) return false; // lsof: no matches
    return true; // any other failure — fail closed, assume active
  }
}

function du(dir) {
  try {
    const out = execFileSync("du", ["-sk", dir], { encoding: "utf8" }).trim();
    const kb = Number(out.split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export const DEFAULT_RECENT_COMMIT_MINUTES = 60;

export function evaluateWorktree(
  dir,
  { allowWorktreeRemoval, env = process.env, recentCommitMinutes = DEFAULT_RECENT_COMMIT_MINUTES, now = Date.now() } = {},
) {
  const branch = getBranch(dir);
  const statusPorcelain = getGitStatusPorcelain(dir);
  const gitClean = isGitStatusClean(statusPorcelain);
  const aheadOfRemote = isAheadOfRemote(dir, branch);
  const remoteUrl = getRemoteOriginUrl(dir);
  const ownerRepo = remoteUrl ? parseGitHubOwnerRepo(remoteUrl) : null;
  const prState = ownerRepo ? resolvePrState(ownerRepo.owner, ownerRepo.repo, branch, env) : "unknown";
  const nodeModulesPath = path.join(dir, "node_modules");
  const hasNodeModules = existsSync(nodeModulesPath);
  const lsFilesOutput = getLsFiles(dir);
  const lockfileCommitted = hasCommittedLockfile(lsFilesOutput);
  const lockfileDirty = isLockfileDirty(statusPorcelain);
  const nodeModulesTracked = hasTrackedFilesUnderNodeModules(lsFilesOutput);
  const sharedParent = isSharedWorktreeParent(dir);
  const activeSession = hasActiveSession(dir, env);
  const lastCommitEpochSeconds = getLastCommitEpochSeconds(dir);
  const recentlyCommitted = isRecentlyCommitted(lastCommitEpochSeconds, Math.floor(now / 1000), recentCommitMinutes);

  // The stash/other-branch/local-tag checks below cost 2-3 extra `git`
  // subprocess calls, all local (no network). Only pay that cost when every
  // OTHER worktree-removal gate already holds — i.e. exactly when
  // `decideAction` would otherwise choose "reap-worktree" — so the default
  // (or a node_modules-only) run never pays for it.
  const prSaysMergedOrClosed = prState === "merged" || prState === "closed";
  const wouldOtherwiseReapWorktree =
    Boolean(allowWorktreeRemoval) && gitClean && !aheadOfRemote && prSaysMergedOrClosed && !sharedParent;
  const unsafeExtraGitState = wouldOtherwiseReapWorktree
    ? hasUnsafeExtraGitState({
        hasUnpushedOtherBranch: hasUnpushedOtherLocalBranch(dir, branch),
        stashCount: getStashCount(dir),
        localOnlyTags: getLocalOnlyTags(dir, getUpstreamRef(dir, branch)),
      })
    : false;

  const decision = decideAction({
    activeSession,
    gitClean,
    aheadOfRemote,
    prState,
    hasNodeModules,
    hasCommittedLockfile: lockfileCommitted,
    lockfileDirty,
    nodeModulesTracked,
    recentlyCommitted,
    isSharedWorktreeParent: sharedParent,
    hasUnsafeExtraGitState: unsafeExtraGitState,
    allowWorktreeRemoval: Boolean(allowWorktreeRemoval),
  });

  return {
    dir,
    branch,
    remoteUrl,
    prState,
    gitClean,
    aheadOfRemote,
    hasNodeModules,
    lockfileCommitted,
    lockfileDirty,
    nodeModulesTracked,
    lastCommitEpochSeconds,
    recentlyCommitted,
    sharedParent,
    unsafeExtraGitState,
    activeSession,
    ...decision,
  };
}

/**
 * Re-checks the cheap, fast-changing safety signals immediately before an
 * actual delete, using fresh I/O rather than the (possibly minutes-stale)
 * `evaluateWorktree` result. A single run can evaluate many worktrees before
 * it reaches any given one's `rmSync`; an agent can resume a session, make a
 * new commit, stash work, or dirty the tree at any point during that window.
 * This does not fully eliminate the race (there is still a gap between this
 * check and the `rmSync` call a few lines later), but it collapses the
 * window from "the whole run's duration" down to milliseconds.
 */
export function revalidateBeforeDelete(
  dir,
  action,
  { env = process.env, recentCommitMinutes = DEFAULT_RECENT_COMMIT_MINUTES, now = Date.now() } = {},
) {
  if (hasActiveSession(dir, env)) {
    return { safe: false, reason: "revalidation-before-delete: a session became active since evaluation" };
  }
  const lastCommitEpochSeconds = getLastCommitEpochSeconds(dir);
  if (isRecentlyCommitted(lastCommitEpochSeconds, Math.floor(now / 1000), recentCommitMinutes)) {
    return { safe: false, reason: "revalidation-before-delete: a new commit landed since evaluation" };
  }
  const statusPorcelain = getGitStatusPorcelain(dir);
  if (isLockfileDirty(statusPorcelain)) {
    return { safe: false, reason: "revalidation-before-delete: the lockfile became dirty since evaluation" };
  }

  if (action === "reap-node-modules") {
    if (hasTrackedFilesUnderNodeModules(getLsFiles(dir))) {
      return { safe: false, reason: "revalidation-before-delete: node_modules now contains a tracked path" };
    }
    return { safe: true };
  }

  if (action === "reap-worktree") {
    if (!isGitStatusClean(statusPorcelain)) {
      return { safe: false, reason: "revalidation-before-delete: the tree became dirty since evaluation" };
    }
    const branch = getBranch(dir);
    if (isAheadOfRemote(dir, branch)) {
      return { safe: false, reason: "revalidation-before-delete: HEAD is now ahead of the remote branch" };
    }
    const unsafeExtraGitState = hasUnsafeExtraGitState({
      hasUnpushedOtherBranch: hasUnpushedOtherLocalBranch(dir, branch),
      stashCount: getStashCount(dir),
      localOnlyTags: getLocalOnlyTags(dir, getUpstreamRef(dir, branch)),
    });
    if (unsafeExtraGitState) {
      return {
        safe: false,
        reason: "revalidation-before-delete: an unpushed local branch/stash/tag appeared since evaluation",
      };
    }
    return { safe: true };
  }

  return { safe: true };
}

function parseArgs(argv, env = process.env) {
  const opts = {
    apply: false,
    allowWorktreeRemoval: false,
    roots: [],
    json: false,
    maxDepth: 4,
    recentCommitMinutes: Number(env.REAP_RECENT_COMMIT_MINUTES) || DEFAULT_RECENT_COMMIT_MINUTES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--remove-merged-worktrees") opts.allowWorktreeRemoval = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--root") opts.roots.push(argv[++i]);
    else if (arg === "--max-depth") opts.maxDepth = Number(argv[++i]);
    else if (arg === "--recent-commit-minutes") opts.recentCommitMinutes = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") opts.help = true;
  }
  return opts;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv, env);
  if (opts.help) {
    console.log(
      "Usage: node scripts/reap-stale-workspaces.mjs [--apply] [--remove-merged-worktrees] [--root <dir>]... " +
        "[--json] [--max-depth <n>] [--recent-commit-minutes <n>]\n\n" +
        "  --recent-commit-minutes <n>  Preserve a worktree whose HEAD committed within the last <n>\n" +
        "                               minutes, even with no open file handles (default: " +
        DEFAULT_RECENT_COMMIT_MINUTES +
        ", env REAP_RECENT_COMMIT_MINUTES).",
    );
    return { results: [], reclaimedBytes: 0 };
  }

  const homeDir = env.REAP_HOME || os.homedir();
  const allowedRoots = (opts.roots.length > 0 ? opts.roots : discoverDefaultRoots(homeDir)).map((r) =>
    path.resolve(r),
  );
  const allowedRealRoots = allowedRoots
    .map((r) => {
      try {
        return realpathSync(r);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const results = [];

  for (const root of allowedRoots) {
    if (!existsSync(root)) continue;
    let workspaceIds;
    try {
      workspaceIds = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const wsEntry of workspaceIds) {
      const wsDir = path.join(root, wsEntry.name);
      const worktrees = findGitWorkTrees(wsDir, opts.maxDepth);
      for (const wt of worktrees) {
        let realWt;
        try {
          realWt = realpathSync(wt);
        } catch {
          continue;
        }
        if (!isContainedInAllowedRoots(realWt, allowedRealRoots)) {
          results.push({ dir: wt, action: "preserve", reason: "FAIL-CLOSED: resolved path escapes allowed roots" });
          continue;
        }

        let evaluation;
        try {
          evaluation = evaluateWorktree(realWt, {
            allowWorktreeRemoval: opts.allowWorktreeRemoval,
            env,
            recentCommitMinutes: opts.recentCommitMinutes,
          });
        } catch (err) {
          // Any unexpected error while reasoning about a candidate (e.g. a
          // malformed/incomplete git directory) fails CLOSED: skip this one
          // entry, never let it crash the whole run or fall through to a
          // destructive default.
          results.push({
            dir: realWt,
            action: "preserve",
            reason: `FAIL-CLOSED: error evaluating worktree: ${err && err.message ? err.message : err}`,
          });
          continue;
        }
        const nodeModulesPath = path.join(realWt, "node_modules");
        const sizeBefore = evaluation.hasNodeModules ? du(nodeModulesPath) : 0;
        const targetSize = evaluation.action === "reap-worktree" ? du(realWt) : sizeBefore;

        const resultEntry = { ...evaluation, bytes: targetSize };
        results.push(resultEntry);

        if (!opts.apply || evaluation.action === "preserve") continue;

        const revalidation = revalidateBeforeDelete(realWt, evaluation.action, {
          env,
          recentCommitMinutes: opts.recentCommitMinutes,
        });
        if (!revalidation.safe) {
          resultEntry.action = "preserve";
          resultEntry.reason = revalidation.reason;
          resultEntry.bytes = 0;
          continue;
        }

        const { rmSync } = await import("node:fs");
        if (evaluation.action === "reap-node-modules") {
          rmSync(nodeModulesPath, { recursive: true, force: true });
        } else if (evaluation.action === "reap-worktree") {
          rmSync(realWt, { recursive: true, force: true });
        }
      }
    }
  }

  // Derived from the final `results` array (not accumulated inline) so the
  // reported total is correct in BOTH modes: in dry-run every candidate's
  // action/bytes reflect the plan; in --apply a candidate downgraded to
  // "preserve" by revalidateBeforeDelete already has its bytes zeroed out,
  // so it is naturally excluded here too. A prior version only accumulated
  // this inside the --apply branch, so dry-run always reported "0B" even
  // when individual lines showed real reclaimable sizes.
  const reclaimedBytes = results
    .filter((r) => r.action !== "preserve")
    .reduce((sum, r) => sum + (r.bytes || 0), 0);

  if (opts.json) {
    console.log(JSON.stringify({ apply: opts.apply, results, reclaimedBytes }, null, 2));
  } else {
    for (const r of results) {
      console.log(`[${r.action}] ${r.dir} — ${r.reason}${r.bytes ? ` (${formatBytes(r.bytes)})` : ""}`);
    }
    console.log(
      `\n${opts.apply ? "Reclaimed" : "Would reclaim"} ${formatBytes(reclaimedBytes)} across ${
        results.filter((r) => r.action !== "preserve").length
      } target(s) out of ${results.length} evaluated.`,
    );
    if (!opts.apply) console.log("Dry run — pass --apply to actually delete.");
  }

  return { results, reclaimedBytes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
