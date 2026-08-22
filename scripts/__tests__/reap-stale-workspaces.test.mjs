import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  decideAction,
  discoverDefaultRoots,
  findGitWorkTrees,
  formatBytes,
  getLocalOnlyTags,
  getUpstreamRef,
  hasCommittedLockfile,
  hasReflogOnlyCommits,
  hasTrackedFilesUnderNodeModules,
  hasUnpushedOtherLocalBranch,
  hasUnsafeExtraGitState,
  isBranchReachableFromAnyRemote,
  isContainedInAllowedRoots,
  isGitStatusClean,
  isLockfileDirty,
  isRecentlyCommitted,
  parseGitHubOwnerRepo,
  refreshRemoteTrackingRefs,
} from "../reap-stale-workspaces.mjs";

const scriptPath = new URL("../reap-stale-workspaces.mjs", import.meta.url).pathname;
const nodeBin = process.execPath;

const cleanupDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * Builds a bare "remote" repo plus a local clone with a lockfile, an initial
 * commit on the default branch, and a checked-out feature branch — the
 * minimal shape `evaluateWorktree` needs to reason about.
 */
function makeRepoFixture({ branchName = "feature/test-branch" } = {}) {
  const remoteDir = makeTempDir("reap-remote-");
  git(remoteDir, ["init", "--bare", "--initial-branch=main"]);

  const seedDir = makeTempDir("reap-seed-");
  git(seedDir, ["init", "--initial-branch=main"]);
  git(seedDir, ["config", "user.email", "test@example.com"]);
  git(seedDir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(seedDir, "pnpm-lock.yaml"), "lockfileVersion: 6\n");
  fs.writeFileSync(path.join(seedDir, "README.md"), "seed\n");
  fs.writeFileSync(path.join(seedDir, ".gitignore"), "node_modules/\n");
  git(seedDir, ["add", "-A"]);
  git(seedDir, ["commit", "-m", "seed"]);
  git(seedDir, ["remote", "add", "origin", remoteDir]);
  git(seedDir, ["push", "origin", "main"]);

  const workDir = makeTempDir("reap-work-");
  git(workDir, ["clone", remoteDir, "."]);
  git(workDir, ["config", "user.email", "test@example.com"]);
  git(workDir, ["config", "user.name", "Test"]);
  git(workDir, ["checkout", "-b", branchName]);
  fs.writeFileSync(path.join(workDir, "feature.txt"), "work\n");
  git(workDir, ["add", "-A"]);
  git(workDir, ["commit", "-m", "feature work"]);
  git(workDir, ["push", "-u", "origin", branchName]);
  git(workDir, ["remote", "set-url", "origin", "https://github.com/acme/widgets.git"]);
  // A real `origin` is actually fetchable — this fixture only needs a
  // github.com-shaped URL so `parseGitHubOwnerRepo` succeeds. Redirect the
  // actual network operation back to the real local bare repo via
  // `insteadOf`, so `refreshRemoteTrackingRefs`'s `git fetch` succeeds here
  // exactly as it would against a real, live origin (Greptile review, PR
  // #11936: "stale refs authorize repository deletion"). `getRemoteOriginUrl`
  // reads the raw `remote.origin.url` config key rather than
  // `git remote get-url`, so this redirect does not corrupt owner/repo
  // parsing above.
  git(workDir, ["config", `url.${remoteDir}.insteadOf`, "https://github.com/acme/widgets.git"]);

  fs.mkdirSync(path.join(workDir, "node_modules"));
  fs.writeFileSync(path.join(workDir, "node_modules", "placeholder.txt"), "x".repeat(1024));

  return { remoteDir, workDir, branchName };
}

function runScript(args, envOverrides = {}) {
  return spawnSync(nodeBin, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...envOverrides },
  });
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

test("isContainedInAllowedRoots: accepts a nested path, rejects the root itself and siblings", () => {
  const roots = ["/home/user/.paperclip/instances/default/workspaces"];
  assert.equal(isContainedInAllowedRoots("/home/user/.paperclip/instances/default/workspaces/abc/wt", roots), true);
  assert.equal(isContainedInAllowedRoots("/home/user/.paperclip/instances/default/workspaces", roots), false);
  assert.equal(isContainedInAllowedRoots("/home/user/.paperclip/instances/default/workspaces-evil/wt", roots), false);
  assert.equal(isContainedInAllowedRoots("/etc/passwd", roots), false);
});

test("isGitStatusClean: empty output is clean, any output is dirty", () => {
  assert.equal(isGitStatusClean(""), true);
  assert.equal(isGitStatusClean("\n"), true);
  assert.equal(isGitStatusClean(" M file.txt\n"), false);
});

test("hasCommittedLockfile: recognizes any of the supported lockfiles", () => {
  assert.equal(hasCommittedLockfile("README.md\npnpm-lock.yaml\nsrc/index.ts"), true);
  assert.equal(hasCommittedLockfile("README.md\npackage-lock.json"), true);
  assert.equal(hasCommittedLockfile("README.md\nsrc/index.ts"), false);
  assert.equal(hasCommittedLockfile(""), false);
});

test("isLockfileDirty: detects an uncommitted edit to a tracked lockfile", () => {
  assert.equal(isLockfileDirty(" M pnpm-lock.yaml\n M src/index.ts\n"), true);
  assert.equal(isLockfileDirty(" M package-lock.json\n"), true);
  assert.equal(isLockfileDirty(" M src/index.ts\n?? scratch.txt\n"), false);
  assert.equal(isLockfileDirty(""), false);
});

test("isRecentlyCommitted: flags a commit inside the window, clears one outside it", () => {
  const now = 1_000_000;
  // Found on a live host: lsof alone missed a worktree with a 24-minute-old
  // commit and no open file handles. This guard exists to catch exactly that.
  assert.equal(isRecentlyCommitted(now - 24 * 60, now, 60), true); // 24 min ago, 60 min window
  assert.equal(isRecentlyCommitted(now - 61 * 60, now, 60), false); // 61 min ago, 60 min window
  assert.equal(isRecentlyCommitted(now - 60 * 60, now, 60), false); // exactly at the boundary — not "within"
  assert.equal(isRecentlyCommitted(null, now, 60), false); // unknown history — nothing to flag on this signal
  assert.equal(isRecentlyCommitted(now - 60, now, 0), false); // threshold disabled
  assert.equal(isRecentlyCommitted(now + 60, now, 60), false); // future commit / clock skew — ignore, don't fail closed here
});

test("parseGitHubOwnerRepo: handles https and ssh remote forms", () => {
  assert.deepEqual(parseGitHubOwnerRepo("https://github.com/acme/widgets.git"), { owner: "acme", repo: "widgets" });
  assert.deepEqual(parseGitHubOwnerRepo("git@github.com:acme/widgets.git"), { owner: "acme", repo: "widgets" });
  assert.deepEqual(parseGitHubOwnerRepo("https://github.com/acme/widgets"), { owner: "acme", repo: "widgets" });
  assert.equal(parseGitHubOwnerRepo("https://gitlab.com/acme/widgets.git"), null);
});

test("formatBytes: renders human units", () => {
  assert.equal(formatBytes(512), "512B");
  assert.equal(formatBytes(2048), "2.0KiB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0MiB");
});

test("hasTrackedFilesUnderNodeModules: flags a force-added file, ignores unrelated tracked paths", () => {
  assert.equal(hasTrackedFilesUnderNodeModules("README.md\nsrc/index.ts\n"), false);
  assert.equal(hasTrackedFilesUnderNodeModules(""), false);
  assert.equal(hasTrackedFilesUnderNodeModules("README.md\nnode_modules/some-pkg/patched.js\n"), true);
  // exact "node_modules" as its own tracked entry (e.g. a submodule) also counts
  assert.equal(hasTrackedFilesUnderNodeModules("node_modules\n"), true);
  // a sibling directory that merely starts with the same prefix must not match
  assert.equal(hasTrackedFilesUnderNodeModules("node_modules-cache/file.js\n"), false);
});

test("hasUnsafeExtraGitState: blocks on an unpushed other branch, a stash, a local-only tag, a reflog-only commit, or unknown facts; clears when all are safe", () => {
  const safe = { hasUnpushedOtherBranch: false, stashCount: 0, localOnlyTags: [], reflogOnlyCommits: false };
  assert.equal(hasUnsafeExtraGitState(safe), false);
  assert.equal(hasUnsafeExtraGitState({ ...safe, hasUnpushedOtherBranch: true }), true);
  assert.equal(hasUnsafeExtraGitState({ ...safe, stashCount: 1 }), true);
  assert.equal(hasUnsafeExtraGitState({ ...safe, localOnlyTags: ["v1-wip"] }), true);
  assert.equal(hasUnsafeExtraGitState({ ...safe, reflogOnlyCommits: true }), true);
  // fail closed when any underlying signal could not be determined at all
  assert.equal(hasUnsafeExtraGitState({ ...safe, hasUnpushedOtherBranch: null }), true);
  assert.equal(hasUnsafeExtraGitState({ ...safe, stashCount: null }), true);
  assert.equal(hasUnsafeExtraGitState({ ...safe, localOnlyTags: null }), true);
  assert.equal(hasUnsafeExtraGitState({ ...safe, reflogOnlyCommits: null }), true);
});

test("decideAction: active session always preserves, regardless of everything else", () => {
  const result = decideAction({
    activeSession: true,
    gitClean: true,
    aheadOfRemote: false,
    prState: "merged",
    hasNodeModules: true,
    hasCommittedLockfile: true,
    lockfileDirty: false,
    recentlyCommitted: false,
    isSharedWorktreeParent: false,
    allowWorktreeRemoval: true,
  });
  assert.equal(result.action, "preserve");
  assert.match(result.reason, /active/i);
});

test("decideAction: merged PR + clean + pushed + opt-in => full worktree removal", () => {
  const result = decideAction({
    activeSession: false,
    gitClean: true,
    aheadOfRemote: false,
    prState: "merged",
    hasNodeModules: true,
    hasCommittedLockfile: true,
    lockfileDirty: false,
    recentlyCommitted: false,
    isSharedWorktreeParent: false,
    allowWorktreeRemoval: true,
  });
  assert.equal(result.action, "reap-worktree");
});

test("decideAction: open PR never allows full worktree removal, even opted in", () => {
  const result = decideAction({
    activeSession: false,
    gitClean: true,
    aheadOfRemote: false,
    prState: "open",
    hasNodeModules: true,
    hasCommittedLockfile: true,
    lockfileDirty: false,
    recentlyCommitted: false,
    isSharedWorktreeParent: false,
    allowWorktreeRemoval: true,
  });
  assert.equal(result.action, "reap-node-modules");
});

test("decideAction: dirty tree blocks full worktree removal but still allows node_modules reclaim", () => {
  const result = decideAction({
    activeSession: false,
    gitClean: false,
    aheadOfRemote: false,
    prState: "merged",
    hasNodeModules: true,
    hasCommittedLockfile: true,
    lockfileDirty: false,
    recentlyCommitted: false,
    isSharedWorktreeParent: false,
    allowWorktreeRemoval: true,
  });
  assert.equal(result.action, "reap-node-modules");
});

test("decideAction: unpushed commits block full worktree removal (regression guard for #3207)", () => {
  const result = decideAction({
    activeSession: false,
    gitClean: true,
    aheadOfRemote: true,
    prState: "merged",
    hasNodeModules: true,
    hasCommittedLockfile: true,
    lockfileDirty: false,
    recentlyCommitted: false,
    isSharedWorktreeParent: false,
    allowWorktreeRemoval: true,
  });
  assert.equal(result.action, "reap-node-modules");
});

test("decideAction: shared worktree parent is never fully removed even if otherwise eligible", () => {
  const result = decideAction({
    activeSession: false,
    gitClean: true,
    aheadOfRemote: false,
    prState: "closed",
    hasNodeModules: true,
    hasCommittedLockfile: true,
    lockfileDirty: false,
    recentlyCommitted: false,
    isSharedWorktreeParent: true,
    allowWorktreeRemoval: true,
  });
  assert.equal(result.action, "reap-node-modules");
});

test("decideAction: without --remove-merged-worktrees, only node_modules tier is ever reached", () => {
  const result = decideAction({
    activeSession: false,
    gitClean: true,
    aheadOfRemote: false,
    prState: "merged",
    hasNodeModules: true,
    hasCommittedLockfile: true,
    lockfileDirty: false,
    recentlyCommitted: false,
    isSharedWorktreeParent: false,
    allowWorktreeRemoval: false,
  });
  assert.equal(result.action, "reap-node-modules");
});

test("decideAction: node_modules without a committed lockfile is preserved (ambiguous, not reinstallable)", () => {
  const result = decideAction({
    activeSession: false,
    gitClean: true,
    aheadOfRemote: false,
    prState: "open",
    hasNodeModules: true,
    hasCommittedLockfile: false,
    lockfileDirty: false,
    recentlyCommitted: false,
    isSharedWorktreeParent: false,
    allowWorktreeRemoval: false,
  });
  assert.equal(result.action, "preserve");
});

test("decideAction: node_modules is preserved when the committed lockfile itself is dirty (real-world edge case)", () => {
  // Found on a live host: a worktree mid-edit on pnpm-lock.yaml. The lockfile
  // is committed (hasCommittedLockfile=true), but its *current* content is
  // uncommitted, so a plain reinstall from the committed lockfile would not
  // reproduce this node_modules. This must block reap-node-modules even
  // though every other signal looks reapable.
  const result = decideAction({
    activeSession: false,
    gitClean: false,
    aheadOfRemote: false,
    prState: "none",
    hasNodeModules: true,
    hasCommittedLockfile: true,
    lockfileDirty: true,
    recentlyCommitted: false,
    isSharedWorktreeParent: false,
    allowWorktreeRemoval: false,
  });
  assert.equal(result.action, "preserve");
  assert.match(result.reason, /uncommitted edits/);
});

test("decideAction: a very recent commit preserves node_modules even with no active session detected (real-world edge case)", () => {
  // Found on a live host: a worktree with a commit 24 minutes old and zero
  // open file handles (lsof saw nothing). recentlyCommitted must block reap
  // even though activeSession is false and every git/PR signal looks reapable.
  const result = decideAction({
    activeSession: false,
    gitClean: true,
    aheadOfRemote: false,
    prState: "open",
    hasNodeModules: true,
    hasCommittedLockfile: true,
    lockfileDirty: false,
    recentlyCommitted: true,
    isSharedWorktreeParent: false,
    allowWorktreeRemoval: true,
  });
  assert.equal(result.action, "preserve");
  assert.match(result.reason, /recent-activity window/);
});


test("decideAction: no node_modules and not eligible for worktree removal preserves", () => {
  const result = decideAction({
    activeSession: false,
    gitClean: true,
    aheadOfRemote: false,
    prState: "open",
    hasNodeModules: false,
    hasCommittedLockfile: true,
    lockfileDirty: false,
    recentlyCommitted: false,
    isSharedWorktreeParent: false,
    allowWorktreeRemoval: false,
  });
  assert.equal(result.action, "preserve");
});

// ---------------------------------------------------------------------------
// Filesystem discovery tests
// ---------------------------------------------------------------------------

test("discoverDefaultRoots: finds *.paperclip*/instances/*/workspaces under a fake home", () => {
  const home = makeTempDir("reap-home-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces"), { recursive: true });
  fs.mkdirSync(path.join(home, ".paperclip.1", "instances", "secondary", "workspaces"), { recursive: true });
  fs.mkdirSync(path.join(home, "Downloads"), { recursive: true }); // must never be picked up
  const roots = discoverDefaultRoots(home).sort();
  assert.deepEqual(roots.sort(), [
    path.join(home, ".paperclip", "instances", "default", "workspaces"),
    path.join(home, ".paperclip.1", "instances", "secondary", "workspaces"),
  ].sort());
});

test("discoverDefaultRoots: also finds the legacy ~/.paperclip-worktrees convention (no instances/ layer)", () => {
  const home = makeTempDir("reap-home-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces"), { recursive: true });
  fs.mkdirSync(path.join(home, ".paperclip-worktrees", "some-checkout"), { recursive: true });
  fs.mkdirSync(path.join(home, "Downloads"), { recursive: true }); // must never be picked up
  const roots = discoverDefaultRoots(home).sort();
  assert.deepEqual(roots.sort(), [
    path.join(home, ".paperclip", "instances", "default", "workspaces"),
    path.join(home, ".paperclip-worktrees"),
  ].sort());
});

test("findGitWorkTrees: locates nested git dirs and does not descend into node_modules or discovered worktrees", () => {
  const root = makeTempDir("reap-scan-");
  const wt1 = path.join(root, "ws-1", "repo-a");
  fs.mkdirSync(path.join(wt1, ".git"), { recursive: true });
  fs.mkdirSync(path.join(wt1, "node_modules", "nested-pkg", ".git"), { recursive: true }); // decoy
  const wt2 = path.join(root, "ws-2", "nested", "repo-b");
  fs.mkdirSync(path.join(wt2, ".git"), { recursive: true });
  const empty = path.join(root, "ws-3");
  fs.mkdirSync(empty, { recursive: true });

  const found = findGitWorkTrees(root, 5).sort();
  assert.deepEqual(found.sort(), [wt1, wt2].sort());
});

// ---------------------------------------------------------------------------
// Real-git-fixture tests for the extra-git-state safety facts
// ---------------------------------------------------------------------------

test("hasUnpushedOtherLocalBranch: a clone's leftover default branch is NOT unsafe (regression guard: false positive found via Greptile review on PR #11936)", () => {
  // Every plain `git clone` leaves the default branch (here "main") checked
  // out locally *before* a feature branch is created — that leftover branch
  // is byte-for-byte identical to origin/main and holds zero unique commits.
  // An earlier version of this check flagged ANY other local branch as
  // unsafe, which would have made --remove-merged-worktrees never fire for
  // the overwhelmingly common "plain clone" case.
  const { workDir, branchName } = makeRepoFixture();
  assert.equal(hasUnpushedOtherLocalBranch(workDir, branchName), false);
});

test("hasUnpushedOtherLocalBranch: a genuinely unpushed commit on another local branch IS unsafe", () => {
  const { workDir, branchName } = makeRepoFixture();
  git(workDir, ["checkout", "-b", "wip/untouched"]);
  fs.writeFileSync(path.join(workDir, "wip.txt"), "not pushed anywhere\n");
  git(workDir, ["add", "-A"]);
  git(workDir, ["commit", "-m", "wip, never pushed"]);
  git(workDir, ["checkout", branchName]);
  assert.equal(hasUnpushedOtherLocalBranch(workDir, branchName), true);
});

test("isBranchReachableFromAnyRemote: true for a branch fully contained in a remote ref, false for one with unique commits", () => {
  const { workDir } = makeRepoFixture();
  assert.equal(isBranchReachableFromAnyRemote(workDir, "main"), true);
  git(workDir, ["checkout", "-b", "wip/unique"]);
  fs.writeFileSync(path.join(workDir, "wip.txt"), "unique\n");
  git(workDir, ["add", "-A"]);
  git(workDir, ["commit", "-m", "unique, unpushed"]);
  assert.equal(isBranchReachableFromAnyRemote(workDir, "wip/unique"), false);
});

test("getLocalOnlyTags: a tag on the pushed commit is safe, a tag on an unpushed commit is local-only (no network call)", () => {
  const { workDir, branchName } = makeRepoFixture();
  git(workDir, ["tag", "pushed-tag"]); // tags the already-pushed HEAD
  fs.writeFileSync(path.join(workDir, "more.txt"), "more\n");
  git(workDir, ["add", "-A"]);
  git(workDir, ["commit", "-m", "unpushed follow-up"]);
  git(workDir, ["tag", "local-only-tag"]); // tags a commit never pushed
  const upstream = getUpstreamRef(workDir, branchName);
  assert.equal(upstream, `origin/${branchName}`);
  const localOnly = getLocalOnlyTags(workDir, upstream);
  assert.deepEqual(localOnly, ["local-only-tag"]);
});

test("hasReflogOnlyCommits: false for an ordinary clean history, true after a hard reset leaves a commit recoverable only via reflog (Greptile review, PR #11936)", () => {
  const { workDir } = makeRepoFixture();
  assert.equal(hasReflogOnlyCommits(workDir), false);
  fs.writeFileSync(path.join(workDir, "throwaway.txt"), "will be reset away\n");
  git(workDir, ["add", "-A"]);
  git(workDir, ["commit", "-m", "about to be discarded"]);
  git(workDir, ["reset", "--hard", "HEAD~1"]);
  assert.equal(hasReflogOnlyCommits(workDir), true);
});

// ---------------------------------------------------------------------------
// End-to-end CLI tests against real git fixtures
// ---------------------------------------------------------------------------

test("CLI dry-run: reports node_modules reclaim for an inactive worktree with an open PR, deletes nothing", () => {
  const { workDir } = makeRepoFixture();
  const home = makeTempDir("reap-home-e2e-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1"), { recursive: true });
  fs.renameSync(workDir, path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  const finalWorkDir = fs.realpathSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));

  const result = runScript(["--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-open.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.apply, false);
  assert.ok(fs.existsSync(path.join(finalWorkDir, "node_modules")), "node_modules must survive a dry run");
  const entry = parsed.results.find((r) => r.dir === finalWorkDir);
  assert.ok(entry, "expected an evaluation entry for the fixture worktree");
  assert.equal(entry.action, "reap-node-modules");
  // Regression guard: dry-run used to always report reclaimedBytes as 0
  // (the accumulator was only ever incremented inside the --apply branch),
  // even though each candidate line correctly showed its own reclaimable
  // size. The summary total must reflect the real plan.
  assert.ok(entry.bytes > 0, "the candidate's own reported size must be nonzero");
  assert.equal(parsed.reclaimedBytes, entry.bytes);
});

test("CLI --apply: removes node_modules but preserves the git worktree and its commit", () => {
  const { workDir, branchName } = makeRepoFixture();
  const home = makeTempDir("reap-home-apply-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1"), { recursive: true });
  fs.renameSync(workDir, path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  const finalWorkDir = fs.realpathSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));

  const before = git(finalWorkDir, ["rev-parse", "HEAD"]).trim();

  const result = runScript(["--apply", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-open.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(finalWorkDir, "node_modules")), false, "node_modules should be removed");
  assert.ok(fs.existsSync(path.join(finalWorkDir, ".git")), "the git worktree itself must be preserved");
  const after = git(finalWorkDir, ["rev-parse", "HEAD"]).trim();
  assert.equal(after, before, "HEAD must be unchanged — this tier never touches git history");
  assert.equal(git(finalWorkDir, ["branch", "--show-current"]).trim(), branchName);

  // Idempotency: running again with nothing left to reclaim must not error
  // and must report zero additional bytes reclaimed.
  const second = runScript(["--apply", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-open.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(second.status, 0, second.stderr);
  const secondParsed = JSON.parse(second.stdout);
  assert.equal(secondParsed.reclaimedBytes, 0);
});

test("CLI --apply: an active session preserves node_modules entirely", () => {
  const { workDir } = makeRepoFixture();
  const home = makeTempDir("reap-home-active-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1"), { recursive: true });
  fs.renameSync(workDir, path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  const finalWorkDir = fs.realpathSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));

  const result = runScript(["--apply", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-open.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-active.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(finalWorkDir, "node_modules")), "active session must block reclaim");
  const parsed = JSON.parse(result.stdout);
  const entry = parsed.results.find((r) => r.dir === finalWorkDir);
  assert.equal(entry.action, "preserve");
});

test("CLI --apply, default settings: a just-made commit blocks node_modules reclaim (regression guard for the lsof/recency gap)", () => {
  // Found on a live host: `age1055-wt` had a commit 24 minutes old and zero
  // lsof matches (no open file handle at the instant of the scan). Under the
  // OLD design (activeSession alone) this would have been reaped. The fixture
  // commit here is made moments ago, so under DEFAULT settings (no
  // --recent-commit-minutes override, i.e. the real 60-minute default) it
  // must be preserved even though every other signal says "reap".
  const { workDir } = makeRepoFixture();
  const home = makeTempDir("reap-home-recent-commit-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1"), { recursive: true });
  fs.renameSync(workDir, path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  const finalWorkDir = fs.realpathSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));

  const result = runScript(["--apply", "--json"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-open.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(finalWorkDir, "node_modules")), "a fresh commit must block reclaim by default");
  const parsed = JSON.parse(result.stdout);
  const entry = parsed.results.find((r) => r.dir === finalWorkDir);
  assert.equal(entry.action, "preserve");
  assert.match(entry.reason, /recent-activity window/);
});

test("CLI --apply --recent-commit-minutes 0: the recency guard can be explicitly disabled", () => {
  const { workDir } = makeRepoFixture();
  const home = makeTempDir("reap-home-recent-commit-disabled-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1"), { recursive: true });
  fs.renameSync(workDir, path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  const finalWorkDir = fs.realpathSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));

  const result = runScript(["--apply", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-open.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(finalWorkDir, "node_modules")), false, "explicit 0 must disable the guard");
});

test("CLI --apply: an uncommitted edit to the lockfile preserves node_modules (real-world edge case)", () => {
  const { workDir } = makeRepoFixture();
  // Simulate the live-host scenario: the tracked lockfile has an in-progress,
  // uncommitted edit (e.g. mid dependency bump), everything else looks
  // otherwise reapable (inactive, node_modules present, lockfile committed).
  fs.writeFileSync(path.join(workDir, "pnpm-lock.yaml"), "lockfileVersion: 6\nextra: edited\n");

  const home = makeTempDir("reap-home-dirty-lockfile-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1"), { recursive: true });
  fs.renameSync(workDir, path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  const finalWorkDir = fs.realpathSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));

  const result = runScript(["--apply", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-open.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(finalWorkDir, "node_modules")), "dirty lockfile must block node_modules reclaim");
  const parsed = JSON.parse(result.stdout);
  const entry = parsed.results.find((r) => r.dir === finalWorkDir);
  assert.equal(entry.action, "preserve");
  assert.match(entry.reason, /uncommitted edits/);
});

test("CLI --apply --remove-merged-worktrees: a merged, clean, fully-pushed, inactive worktree is fully removed", () => {
  const { workDir } = makeRepoFixture({ branchName: "feature/merged-branch" });
  const home = makeTempDir("reap-home-merged-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1"), { recursive: true });
  fs.renameSync(workDir, path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  const finalWorkDir = fs.realpathSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));

  const result = runScript(["--apply", "--remove-merged-worktrees", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-merged.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(finalWorkDir), false, "merged + clean + pushed + inactive worktree must be fully removed");
});

test("CLI --apply --remove-merged-worktrees: a stash entry blocks full removal even with a merged-looking PR (Greptile review, PR #11936)", () => {
  const { workDir } = makeRepoFixture({ branchName: "feature/merged-with-stash" });
  fs.writeFileSync(path.join(workDir, "wip-stash.txt"), "not committed, only stashed\n");
  git(workDir, ["stash", "push", "-u", "-m", "wip"]);
  const home = makeTempDir("reap-home-stash-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1"), { recursive: true });
  fs.renameSync(workDir, path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  const finalWorkDir = fs.realpathSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));

  const result = runScript(["--apply", "--remove-merged-worktrees", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-merged.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(finalWorkDir), "a worktree carrying a stash must not be fully removed (.git survives)");
  assert.ok(fs.existsSync(path.join(finalWorkDir, ".git")), "the git directory itself must survive");
  assert.equal(git(finalWorkDir, ["stash", "list"]).trim().length > 0, true, "the stash itself must survive untouched");
  const parsed = JSON.parse(result.stdout);
  const entry = parsed.results.find((r) => r.dir === finalWorkDir);
  // A stash blocks ONLY the full-worktree tier (documented fallback
  // behavior) — node_modules-only reclaim still fires since it never
  // touches branch/stash/tag state at all.
  assert.equal(entry.action, "reap-node-modules");
  assert.equal(fs.existsSync(path.join(finalWorkDir, "node_modules")), false);
});

test("CLI --apply --remove-merged-worktrees: a reflog-only commit (from a hard reset) blocks full removal (Greptile review, PR #11936)", () => {
  const { workDir } = makeRepoFixture({ branchName: "feature/merged-with-reflog" });
  fs.writeFileSync(path.join(workDir, "throwaway.txt"), "will be reset away, still recoverable via reflog\n");
  git(workDir, ["add", "-A"]);
  git(workDir, ["commit", "-m", "about to be discarded"]);
  git(workDir, ["reset", "--hard", "HEAD~1"]); // matches the pushed upstream again, but leaves a reflog-only commit
  const home = makeTempDir("reap-home-reflog-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1"), { recursive: true });
  fs.renameSync(workDir, path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  const finalWorkDir = fs.realpathSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));

  const result = runScript(["--apply", "--remove-merged-worktrees", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-merged.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(finalWorkDir), "a worktree with a reflog-only commit must not be fully removed");
  assert.ok(fs.existsSync(path.join(finalWorkDir, ".git")), "the git directory (and its reflog) must survive");
  const parsed = JSON.parse(result.stdout);
  const entry = parsed.results.find((r) => r.dir === finalWorkDir);
  assert.equal(entry.action, "reap-node-modules"); // falls back to tier 1, same as the stash case
});

test("refreshRemoteTrackingRefs + isBranchReachableFromAnyRemote: a branch deleted on the real remote after being pushed is no longer 'reachable' once refs are refreshed (Greptile review, PR #11936: stale refs authorize repository deletion)", () => {
  const { remoteDir, workDir } = makeRepoFixture();
  git(workDir, ["checkout", "-b", "other-work"]);
  fs.writeFileSync(path.join(workDir, "other.txt"), "other branch work\n");
  git(workDir, ["add", "-A"]);
  git(workDir, ["commit", "-m", "other branch work"]);
  git(workDir, ["push", "-u", "origin", "other-work"]); // updates workDir's own refs/remotes/origin/other-work

  // At this instant the cached ref correctly shows the branch as mirrored.
  assert.equal(isBranchReachableFromAnyRemote(workDir, "other-work"), true);

  // Simulate the real remote force-deleting that branch WITHOUT workDir ever
  // fetching again — exactly what "an inactive worktree nobody has touched
  // in a while" looks like: the remote can move on without the local
  // tracking ref ever finding out.
  git(remoteDir, ["--git-dir=.", "update-ref", "-d", "refs/heads/other-work"]);

  // Documents the vulnerability this finding described: the STALE cached
  // ref still claims the commit is safely mirrored, because nothing has
  // refreshed refs/remotes/** since the original push.
  assert.equal(
    isBranchReachableFromAnyRemote(workDir, "other-work"),
    true,
    "pre-refresh: a stale cached ref still (wrongly) looks safe",
  );

  // The fix: refreshing remote-tracking refs (which the reaper now does
  // before trusting this check anywhere on the destructive path) prunes the
  // now-deleted remote branch, and the same commit correctly stops looking
  // mirrored.
  assert.equal(refreshRemoteTrackingRefs(workDir), true, "fetch must succeed (redirected to the real bare repo via insteadOf)");
  assert.equal(
    isBranchReachableFromAnyRemote(workDir, "other-work"),
    false,
    "post-refresh: the deleted remote branch is correctly no longer considered reachable",
  );
});

test("CLI --apply --remove-merged-worktrees: a local branch whose remote copy was deleted after the last fetch blocks full removal (Greptile review, PR #11936: stale refs authorize repository deletion)", () => {
  const { remoteDir, workDir } = makeRepoFixture({ branchName: "feature/merged-with-stale-ref" });
  git(workDir, ["checkout", "-b", "stale-other-work"]);
  fs.writeFileSync(path.join(workDir, "other.txt"), "other branch work, unique commit\n");
  git(workDir, ["add", "-A"]);
  git(workDir, ["commit", "-m", "other branch work"]);
  git(workDir, ["push", "-u", "origin", "stale-other-work"]); // caches refs/remotes/origin/stale-other-work as mirrored
  git(workDir, ["checkout", "feature/merged-with-stale-ref"]); // back to the branch with the merged-looking PR
  // Simulate the real remote deleting that branch since the last fetch —
  // the worktree's own cached ref is now stale, and if trusted as-is would
  // wrongly consider "stale-other-work"'s unique commit already mirrored.
  git(remoteDir, ["--git-dir=.", "update-ref", "-d", "refs/heads/stale-other-work"]);

  const home = makeTempDir("reap-home-stale-ref-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1"), { recursive: true });
  fs.renameSync(workDir, path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  const finalWorkDir = fs.realpathSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));

  const result = runScript(["--apply", "--remove-merged-worktrees", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-merged.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    fs.existsSync(finalWorkDir),
    "a worktree whose OTHER local branch's remote copy was deleted since the last fetch must not be fully removed",
  );
  assert.ok(fs.existsSync(path.join(finalWorkDir, ".git")), "the git directory, and the only remaining copy of stale-other-work's commit, must survive");
  const parsed = JSON.parse(result.stdout);
  const entry = parsed.results.find((r) => r.dir === finalWorkDir);
  assert.equal(entry.action, "reap-node-modules"); // falls back to tier 1, same as the stash/reflog cases
});

test("CLI --apply: a git-tracked (force-added) file under node_modules blocks reclaim even with a clean, committed lockfile (Greptile review, PR #11936)", () => {
  const { workDir } = makeRepoFixture({ branchName: "feature/tracked-node-modules" });
  fs.writeFileSync(path.join(workDir, "node_modules", "patched-dep.js"), "// hand patch, force-added\n");
  git(workDir, ["add", "-f", "node_modules/patched-dep.js"]);
  git(workDir, ["commit", "-m", "force-add a patched dependency file"]);
  // Node_modules-only reclaim never checks ahead-of-remote status (only the
  // full-worktree tier does), so this commit is deliberately left unpushed.
  const home = makeTempDir("reap-home-tracked-nm-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1"), { recursive: true });
  fs.renameSync(workDir, path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  const finalWorkDir = fs.realpathSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));

  const result = runScript(["--apply", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-open.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    fs.existsSync(path.join(finalWorkDir, "node_modules", "patched-dep.js")),
    "a git-tracked file under node_modules must survive — a reinstall would silently drop it",
  );
  const parsed = JSON.parse(result.stdout);
  const entry = parsed.results.find((r) => r.dir === finalWorkDir);
  assert.equal(entry.action, "preserve");
  assert.match(entry.reason, /tracked file exists under node_modules/);
});

test("CLI --apply --remove-merged-worktrees: an OPEN pr blocks full removal but node_modules still reclaimed", () => {
  const { workDir } = makeRepoFixture({ branchName: "feature/still-open" });
  const home = makeTempDir("reap-home-open-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1"), { recursive: true });
  fs.renameSync(workDir, path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  const finalWorkDir = fs.realpathSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));

  const result = runScript(["--apply", "--remove-merged-worktrees", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-open.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(finalWorkDir), "worktree must survive while its PR is open");
  assert.equal(fs.existsSync(path.join(finalWorkDir, "node_modules")), false, "node_modules is still reclaimable");
});

test("CLI --apply --remove-merged-worktrees: unpushed commits block removal even with a merged-looking PR lookup", () => {
  const { workDir } = makeRepoFixture({ branchName: "feature/unpushed" });
  const home = makeTempDir("reap-home-unpushed-");
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1"), { recursive: true });
  fs.renameSync(workDir, path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  const finalWorkDir = fs.realpathSync(path.join(home, ".paperclip", "instances", "default", "workspaces", "ws-1", "repo"));
  fs.writeFileSync(path.join(finalWorkDir, "extra-unpushed.txt"), "not on remote\n");
  git(finalWorkDir, ["add", "-A"]);
  git(finalWorkDir, ["commit", "-m", "unpushed local commit"]);

  const result = runScript(["--apply", "--remove-merged-worktrees", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-merged.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(finalWorkDir), "worktree with unpushed commits must never be removed (regression guard for #3207)");
  assert.ok(fs.existsSync(path.join(finalWorkDir, "extra-unpushed.txt")), "unpushed file must remain on disk");
});

test("CLI: default root discovery never scans a directory outside *.paperclip*/instances/*/workspaces", () => {
  // No --root flag: only discoverDefaultRoots' output is ever scanned. A
  // fully-formed, otherwise-eligible-for-reclaim repo sitting just outside
  // that discovered tree (e.g. a sibling directory, or the instance root
  // itself) must never be evaluated or touched, let alone deleted.
  const { workDir } = makeRepoFixture({ branchName: "feature/outside-scope" });
  const home = makeTempDir("reap-home-outside-");
  const notAWorkspacesDir = path.join(home, ".paperclip", "instances", "default", "not-workspaces", "repo");
  fs.mkdirSync(path.dirname(notAWorkspacesDir), { recursive: true });
  fs.renameSync(workDir, notAWorkspacesDir);
  fs.mkdirSync(path.join(home, ".paperclip", "instances", "default", "workspaces"), { recursive: true });

  const result = runScript(["--apply", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-open.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.results.length, 0, "nothing outside the workspaces root should even be evaluated");
  assert.ok(fs.existsSync(path.join(notAWorkspacesDir, "node_modules")), "out-of-scope repo must be untouched");
});

test("CLI: a symlink escaping the workspace root is never followed for deletion", () => {
  const home = makeTempDir("reap-home-symlink-");
  const wsRoot = path.join(home, ".paperclip", "instances", "default", "workspaces");
  fs.mkdirSync(wsRoot, { recursive: true });
  const secretDir = makeTempDir("reap-secret-outside-");
  fs.writeFileSync(path.join(secretDir, "do-not-touch.txt"), "precious\n");
  fs.symlinkSync(secretDir, path.join(wsRoot, "escape-link"));

  const result = runScript(["--apply", "--json", "--recent-commit-minutes", "0"], {
    REAP_HOME: home,
    REAP_PR_LOOKUP_CMD: path.join(fixtureBin(), "pr-lookup-open.sh"),
    REAP_ACTIVE_SESSION_CMD: path.join(fixtureBin(), "always-inactive.sh"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(secretDir, "do-not-touch.txt")), "symlinked-outside content must survive untouched");
});

function fixtureBin() {
  return new URL("./fixtures/reap-stale-workspaces", import.meta.url).pathname;
}
