import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  buildIssueUrl,
  classifyWorktree,
  fetchIssueStatus,
  inferIssueIdentifier,
  isCanonicalWorktreePath,
  parseCliArgs,
  parseStatusPorcelain,
  parseUpstreamLine,
  parseWorktreeListPorcelain,
  resolvePaperclipApiConfig,
  summarizeFindings,
  CANONICAL_WORKTREE_PATHS,
  PAPERCLIP_API_BASE_ENV_NAMES,
  PAPERCLIP_API_TOKEN_ENV_NAMES,
} from "./audit-worktrees.mjs";

test("parseWorktreeListPorcelain handles multiple worktrees + detached HEAD", () => {
  const text = [
    "worktree /opt/paperclip",
    "HEAD 1234567890abcdef1234567890abcdef12345678",
    "branch refs/heads/master",
    "",
    "worktree /opt/paperclip-worktrees/enterprise-agent-os/LET-181",
    "HEAD 9ecb6e64aaaaaaaabbbbbbbbccccccccdddddddd",
    "branch refs/heads/enterprise-agent-os/LET-181",
    "",
    "worktree /tmp/paperclip-fork-master",
    "HEAD 8f44211000000000000000000000000000000000",
    "detached",
    "",
  ].join("\n");

  const result = parseWorktreeListPorcelain(text);
  assert.equal(result.length, 3);
  assert.equal(result[0].worktree, "/opt/paperclip");
  assert.equal(result[0].branch, "master");
  assert.equal(result[1].worktree, "/opt/paperclip-worktrees/enterprise-agent-os/LET-181");
  assert.equal(result[1].branch, "enterprise-agent-os/LET-181");
  assert.equal(result[2].detached, true);
  assert.equal(result[2].branch, null);
});

test("parseStatusPorcelain bucketizes staged, unstaged, and untracked filenames", () => {
  const text = [
    "M  src/staged.ts",
    " M src/unstaged.ts",
    "MM src/both.ts",
    "?? new-file.txt",
    "R  old.ts -> new.ts",
  ].join("\n");
  const out = parseStatusPorcelain(text);
  assert.deepEqual(out.staged.sort(), ["new.ts", "src/both.ts", "src/staged.ts"].sort());
  assert.deepEqual(out.unstaged.sort(), ["src/both.ts", "src/unstaged.ts"].sort());
  assert.deepEqual(out.untracked, ["new-file.txt"]);
});

test("parseUpstreamLine parses upstream and ahead/behind numbers", () => {
  assert.deepEqual(parseUpstreamLine("fork/master\t3\t6"), { upstream: "fork/master", ahead: 3, behind: 6 });
  assert.deepEqual(parseUpstreamLine("\t0\t0"), { upstream: null, ahead: 0, behind: 0 });
  assert.deepEqual(parseUpstreamLine(""), { upstream: null, ahead: 0, behind: 0 });
});

test("inferIssueIdentifier extracts canonical Paperclip identifiers from branch or path", () => {
  assert.equal(
    inferIssueIdentifier({ branch: "enterprise-agent-os/LET-181", worktreePath: "/x" }),
    "LET-181",
  );
  assert.equal(
    inferIssueIdentifier({ branch: "feature/x", worktreePath: "/opt/paperclip-worktrees/LET-326" }),
    "LET-326",
  );
  assert.equal(inferIssueIdentifier({ branch: null, worktreePath: null }), null);
  assert.equal(
    inferIssueIdentifier({ branch: "release/phase-3c-runtime-hardening-20260516", worktreePath: "/x" }),
    null,
  );
});

test("classifyWorktree marks LET-181-like condition as BLOCK when issue is done", () => {
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/enterprise-agent-os/LET-181",
    branch: "enterprise-agent-os/LET-181",
    upstream: "fork/master",
    ahead: 1,
    behind: 6,
    dirtyFileCount: 4,
    localCommitCount: 1,
    prState: "NONE",
    issueIdentifier: "LET-181",
    issueStatus: "done",
  });
  assert.equal(out.level, "BLOCK");
  assert.ok(out.reasons.some((r) => r.includes("LET-181")), `expected reasons to mention LET-181, got: ${out.reasons.join("|")}`);
});

test("classifyWorktree downgrades LET-181-like condition to WARN when issue status is unknown (offline / no API key)", () => {
  // QA contract: only known-final statuses (done/cancelled) escalate
  // dirty/ahead/no-PR to BLOCK on a non-canonical worktree. Unknown is
  // treated as potentially active to avoid false-positive blocks when
  // the Paperclip API is unavailable. With PAPERCLIP_API_KEY configured
  // the audit promotes this to BLOCK via the live API enrichment path.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/enterprise-agent-os/LET-181",
    branch: "enterprise-agent-os/LET-181",
    upstream: "fork/master",
    ahead: 1,
    behind: 6,
    dirtyFileCount: 4,
    localCommitCount: 1,
    prState: "NONE",
    issueIdentifier: "LET-181",
    issueStatus: "unknown",
  });
  assert.equal(out.level, "WARN");
  assert.ok(out.reasons.length > 0, "expected at least one warn reason");
});

test("classifyWorktree marks dirty active-issue worktree as WARN (not BLOCK)", () => {
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-326",
    branch: "eaos/phase-4a-sandbox-runtime-dashboard",
    upstream: "fork/master",
    ahead: 0,
    behind: 2,
    dirtyFileCount: 3,
    localCommitCount: 0,
    prState: "OPEN",
    issueIdentifier: "LET-326",
    issueStatus: "in_progress",
  });
  assert.equal(out.level, "WARN");
  assert.ok(out.reasons.some((r) => r.includes("dirty")));
});

test("classifyWorktree returns OK for clean worktree with open PR", () => {
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-326",
    branch: "eaos/phase-4a-sandbox-runtime-dashboard",
    upstream: "fork/master",
    ahead: 2,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 2,
    prState: "OPEN",
    issueIdentifier: "LET-326",
    issueStatus: "in_progress",
  });
  assert.equal(out.level, "OK");
});

test("classifyWorktree only flags dirtiness on protected canonical worktree (never branch hygiene)", () => {
  const dirty = classifyWorktree({
    worktreePath: "/opt/paperclip",
    branch: "master",
    upstream: "fork/master",
    ahead: 5,
    behind: 1,
    dirtyFileCount: 2,
    localCommitCount: 5,
    prState: "NONE",
    issueIdentifier: null,
    issueStatus: "unknown",
    isCanonicalPath: true,
  });
  assert.equal(dirty.level, "WARN");
  assert.deepEqual(dirty.reasons, ["dirty files on canonical/protected worktree"]);

  const clean = classifyWorktree({
    worktreePath: "/opt/paperclip",
    branch: "master",
    upstream: "fork/master",
    ahead: 0,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 0,
    prState: "NONE",
    issueIdentifier: null,
    issueStatus: "unknown",
    isCanonicalPath: true,
  });
  assert.equal(clean.level, "OK");
});

test("classifyWorktree treats ahead branch with no PR on active non-final issue as WARN (not BLOCK)", () => {
  // LET-335 contract: dirty/ahead/no-PR on an active non-final issue is
  // in-flight work and warrants a WARN, not a BLOCK. BLOCK is reserved
  // for (a) final-status issues (done/cancelled) and (b) canonical
  // /opt/paperclip on a non-master branch ahead of base with no PR.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-999",
    branch: "feat/whatever",
    upstream: "fork/master",
    ahead: 3,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 3,
    prState: "NONE",
    issueIdentifier: "LET-999",
    issueStatus: "in_progress",
  });
  assert.equal(out.level, "WARN");
  assert.ok(out.reasons.some((r) => r.includes("no PR")));
});

test("classifyWorktree BLOCKs canonical /opt/paperclip on a non-master branch diverged from base with no PR", () => {
  // LET-335 scope: "live branch diverged from master without reconciliation
  // issue/PR" must BLOCK. The canonical /opt/paperclip checkout on a feature
  // or release branch ahead of fork/master with no open/merged PR is the
  // production-shaped form of this hazard.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip",
    branch: "release/phase-3c-runtime-hardening",
    upstream: "fork/master",
    ahead: 4,
    behind: 1,
    dirtyFileCount: 0,
    localCommitCount: 4,
    prState: "NONE",
    issueIdentifier: null,
    issueStatus: "unknown",
    isCanonicalPath: true,
  });
  assert.equal(out.level, "BLOCK");
  assert.ok(out.reasons.some((r) => r.includes("canonical")));
});

test("classifyWorktree BLOCKs canonical /opt/paperclip on a non-master branch with NO upstream tracking when local commits are not in base", () => {
  // Real-world shape from current /opt/paperclip: branched off fork/master to
  // a local feature branch, never pushed (no upstream), so git ahead=0 but
  // localCommitCount > 0 vs base. Must still BLOCK.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip",
    branch: "eaos/feature-branch",
    upstream: null,
    ahead: 0,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 5,
    prState: "NONE",
    issueIdentifier: null,
    issueStatus: "unknown",
    isCanonicalPath: true,
  });
  assert.equal(out.level, "BLOCK");
  assert.ok(out.reasons.some((r) => r.includes("diverged")));
});

test("classifyWorktree leaves canonical /opt/paperclip on non-master branch with an OPEN PR as OK", () => {
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip",
    branch: "release/phase-3c-runtime-hardening",
    upstream: "fork/master",
    ahead: 4,
    behind: 1,
    dirtyFileCount: 0,
    localCommitCount: 4,
    prState: "OPEN",
    issueIdentifier: null,
    issueStatus: "unknown",
    isCanonicalPath: true,
  });
  assert.equal(out.level, "OK");
});

test("classifyWorktree BLOCKs canonical /opt/paperclip on non-master branch with historical MERGED PR + post-merge local commits", () => {
  // QA blocker (2026-05-17): canonical/live checkout must not silently pass
  // when the only PR is a historical MERGED one but new commits have been
  // added on top of the branch — those commits are not in master, so the
  // merge is not a current reconciliation path for them.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip",
    branch: "release/post-merge-advance",
    upstream: "fork/master",
    ahead: 1,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 1,
    prState: "MERGED",
    issueIdentifier: "LET-999",
    issueStatus: "in_progress",
    isCanonicalPath: true,
  });
  assert.equal(out.level, "BLOCK", `reasons: ${out.reasons.join("|")}`);
  assert.ok(
    out.reasons.some((r) => r.toLowerCase().includes("merged")),
    `expected reason to call out historical MERGED PR; got: ${out.reasons.join("|")}`,
  );
});

test("classifyWorktree BLOCKs canonical /opt/paperclip on non-master branch with historical MERGED PR + ahead-only divergence", () => {
  // ahead>0 with localCommitCount=0 (e.g. merge commits or upstream-only
  // ahead reporting) is still post-merge divergence the historical PR did
  // not reconcile. Canonical path must BLOCK.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip",
    branch: "release/post-merge-advance",
    upstream: "fork/master",
    ahead: 2,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 0,
    prState: "MERGED",
    issueIdentifier: "LET-999",
    issueStatus: "in_progress",
    isCanonicalPath: true,
  });
  assert.equal(out.level, "BLOCK", `reasons: ${out.reasons.join("|")}`);
  assert.ok(
    out.reasons.some((r) => r.toLowerCase().includes("merged")),
    `expected reason to call out historical MERGED PR; got: ${out.reasons.join("|")}`,
  );
});

test("classifyWorktree keeps canonical /opt/paperclip on non-master branch with fully-reconciled MERGED PR as OK", () => {
  // After the merge lands and the branch is fully reconciled (no ahead,
  // no local commits, clean), a MERGED PR is healthy on a canonical path.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip",
    branch: "release/post-merge-reconciled",
    upstream: "fork/master",
    ahead: 0,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 0,
    prState: "MERGED",
    issueIdentifier: "LET-999",
    issueStatus: "in_progress",
    isCanonicalPath: true,
  });
  assert.equal(out.level, "OK");
});

test("summarizeFindings aggregates levels", () => {
  const out = summarizeFindings([
    { classification: { level: "BLOCK" } },
    { classification: { level: "WARN" } },
    { classification: { level: "WARN" } },
    { classification: { level: "OK" } },
  ]);
  assert.deepEqual(out, { block: 1, warn: 2, ok: 1, total: 4 });
});

test("parseCliArgs defaults and overrides", () => {
  const def = parseCliArgs([]);
  assert.equal(def.json, false);
  assert.equal(def.baseRef, "fork/master");
  assert.deepEqual(def.roots, ["/opt/paperclip", "/opt/paperclip-worktrees"]);
  assert.equal(def.useGh, true);
  assert.equal(def.usePaperclip, true);

  const custom = parseCliArgs([
    "--json",
    "--no-gh",
    "--no-paperclip",
    "--root",
    "/tmp/a",
    "--root",
    "/tmp/b",
    "--base",
    "origin/main",
    "--repo",
    "acme/repo",
  ]);
  assert.deepEqual(custom, {
    json: true,
    quiet: false,
    roots: ["/tmp/a", "/tmp/b"],
    baseRef: "origin/main",
    ghRepo: "acme/repo",
    useGh: false,
    usePaperclip: false,
    help: false,
  });
});

test("parseCliArgs rejects unknown args", () => {
  assert.throws(() => parseCliArgs(["--what"]));
});

// ---------------------------------------------------------------------------
// LET-335 QA blocker (2026-05-17): canonical-path detection must not be tied
// to `--root` scope. A user scoping the audit to a child worktree under
// /opt/paperclip-worktrees/... must still see that worktree classified as
// non-canonical. Only /opt/paperclip itself is canonical.
// ---------------------------------------------------------------------------

test("CANONICAL_WORKTREE_PATHS is restricted to the live /opt/paperclip checkout", () => {
  assert.ok(CANONICAL_WORKTREE_PATHS instanceof Set);
  assert.equal(CANONICAL_WORKTREE_PATHS.has("/opt/paperclip"), true);
  // Critical: the worktrees container directory is NOT itself canonical,
  // and individual child worktrees beneath it are never canonical.
  assert.equal(CANONICAL_WORKTREE_PATHS.has("/opt/paperclip-worktrees"), false);
  assert.equal(
    CANONICAL_WORKTREE_PATHS.has("/opt/paperclip-worktrees/enterprise-agent-os/LET-335"),
    false,
  );
});

test("isCanonicalWorktreePath only matches the hardcoded canonical set, not arbitrary scan roots", () => {
  assert.equal(isCanonicalWorktreePath("/opt/paperclip"), true);
  // The bug fixed here: any non-canonical worktree path must be reported as
  // non-canonical even when it is the user-supplied --root.
  assert.equal(isCanonicalWorktreePath("/opt/paperclip-worktrees"), false);
  assert.equal(
    isCanonicalWorktreePath("/opt/paperclip-worktrees/enterprise-agent-os/LET-335"),
    false,
  );
  assert.equal(isCanonicalWorktreePath("/tmp/paperclip-pr40-qa"), false);
  assert.equal(isCanonicalWorktreePath(null), false);
  assert.equal(isCanonicalWorktreePath(""), false);
});

test("classifyWorktree: scoped child worktree (isCanonicalPath=false) with gh/api unavailable degrades to WARN, not BLOCK", () => {
  // Mirrors the QA repro:
  //   node scripts/audit-worktrees.mjs --root /opt/paperclip-worktrees/enterprise-agent-os/LET-335 \
  //                                    --no-gh --no-paperclip --json
  // Expected: non-canonical worktree + UNKNOWN PR + unknown issue status =>
  // WARN (informational), not BLOCK. Only known-final issue statuses or true
  // canonical /opt/paperclip divergence escalate to BLOCK.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/enterprise-agent-os/LET-335",
    branch: "enterprise-agent-os/LET-335",
    upstream: "fork/enterprise-agent-os/LET-335",
    ahead: 0,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 8,
    prState: "UNKNOWN",
    issueIdentifier: "LET-335",
    issueStatus: "unknown",
    isCanonicalPath: false,
  });
  assert.equal(out.level, "WARN", `expected WARN, got ${out.level} (reasons: ${out.reasons.join("|")})`);
  assert.ok(
    out.reasons.every((r) => !r.includes("canonical")),
    `non-canonical scope must not produce "canonical" reasons; got: ${out.reasons.join("|")}`,
  );
});

test("LET-181 fixture: classifyWorktree validates the documented incident scenario", () => {
  // Fixture mirrors the validation requirements from LET-335:
  // - branch enterprise-agent-os/LET-181, HEAD 9ecb6e64, upstream fork/master
  // - ahead 1 / behind 6, dirty files under ui/src/eaos/*
  // - no PR for head branch in lmanualm/paperclip
  // - issue LET-181 status "done"
  const fixture = {
    worktreePath: "/opt/paperclip-worktrees/enterprise-agent-os/LET-181",
    branch: "enterprise-agent-os/LET-181",
    upstream: "fork/master",
    ahead: 1,
    behind: 6,
    dirtyFileCount: 5,
    localCommitCount: 1,
    prState: "NONE",
    issueIdentifier: "LET-181",
    issueStatus: "done",
  };
  const out = classifyWorktree(fixture);
  assert.equal(out.level, "BLOCK", `expected BLOCK for LET-181 incident, got ${out.level}`);
  assert.ok(out.reasons.length > 0, "expected at least one block reason");
});

// ---------------------------------------------------------------------------
// resolvePaperclipApiConfig / buildIssueUrl — base + token env resolution
// ---------------------------------------------------------------------------

test("PAPERCLIP_API_BASE_ENV_NAMES priority order matches documented contract", () => {
  assert.deepEqual(PAPERCLIP_API_BASE_ENV_NAMES, [
    "PAPERCLIP_API_BASE_URL",
    "PAPERCLIP_API_URL",
    "PAPERCLIP_RUNTIME_API_URL",
    "PAPERCLIP_BASE_URL",
  ]);
});

test("PAPERCLIP_API_TOKEN_ENV_NAMES priority order matches documented contract", () => {
  assert.deepEqual(PAPERCLIP_API_TOKEN_ENV_NAMES, [
    "PAPERCLIP_API_KEY",
    "PAPERCLIP_API_TOKEN",
    "PAPERCLIP_BEARER_TOKEN",
  ]);
});

test("resolvePaperclipApiConfig returns nothing when env is empty", () => {
  const out = resolvePaperclipApiConfig({});
  assert.equal(out.base, null);
  assert.equal(out.baseEnv, null);
  assert.equal(out.tokenPresent, false);
  assert.equal(out.tokenEnv, null);
});

test("resolvePaperclipApiConfig picks PAPERCLIP_API_BASE_URL with highest priority", () => {
  const out = resolvePaperclipApiConfig({
    PAPERCLIP_API_BASE_URL: "https://primary",
    PAPERCLIP_API_URL: "https://secondary",
    PAPERCLIP_RUNTIME_API_URL: "https://tertiary",
    PAPERCLIP_BASE_URL: "https://legacy",
  });
  assert.equal(out.base, "https://primary");
  assert.equal(out.baseEnv, "PAPERCLIP_API_BASE_URL");
});

test("resolvePaperclipApiConfig falls back to PAPERCLIP_API_URL when only it is set", () => {
  const out = resolvePaperclipApiConfig({
    PAPERCLIP_API_URL: "https://paperclip.example",
  });
  assert.equal(out.base, "https://paperclip.example");
  assert.equal(out.baseEnv, "PAPERCLIP_API_URL");
});

test("resolvePaperclipApiConfig falls back to PAPERCLIP_RUNTIME_API_URL when only it is set", () => {
  const out = resolvePaperclipApiConfig({
    PAPERCLIP_RUNTIME_API_URL: "https://runtime.example",
  });
  assert.equal(out.base, "https://runtime.example");
  assert.equal(out.baseEnv, "PAPERCLIP_RUNTIME_API_URL");
});

test("resolvePaperclipApiConfig respects runtime-host env shape (LET-335 QA blocker)", () => {
  // Mirrors the runtime env the QA validator reported: both PAPERCLIP_API_URL
  // and PAPERCLIP_RUNTIME_API_URL set, PAPERCLIP_API_KEY present, no
  // PAPERCLIP_API_BASE_URL. Must resolve cleanly without that legacy var.
  const out = resolvePaperclipApiConfig({
    PAPERCLIP_API_KEY: "tok",
    PAPERCLIP_API_URL: "https://paperclip.46-224-56-114.sslip.io",
    PAPERCLIP_RUNTIME_API_URL: "https://paperclip.46-224-56-114.sslip.io",
  });
  assert.equal(out.base, "https://paperclip.46-224-56-114.sslip.io");
  assert.equal(out.baseEnv, "PAPERCLIP_API_URL");
  assert.equal(out.tokenPresent, true);
  assert.equal(out.tokenEnv, "PAPERCLIP_API_KEY");
});

test("resolvePaperclipApiConfig token priority: KEY > TOKEN > BEARER_TOKEN", () => {
  const allThree = resolvePaperclipApiConfig({
    PAPERCLIP_API_KEY: "a",
    PAPERCLIP_API_TOKEN: "b",
    PAPERCLIP_BEARER_TOKEN: "c",
  });
  assert.equal(allThree.tokenEnv, "PAPERCLIP_API_KEY");
  const tokenOnly = resolvePaperclipApiConfig({ PAPERCLIP_API_TOKEN: "b" });
  assert.equal(tokenOnly.tokenEnv, "PAPERCLIP_API_TOKEN");
  const bearerOnly = resolvePaperclipApiConfig({ PAPERCLIP_BEARER_TOKEN: "c" });
  assert.equal(bearerOnly.tokenEnv, "PAPERCLIP_BEARER_TOKEN");
});

test("resolvePaperclipApiConfig ignores whitespace-only values", () => {
  const out = resolvePaperclipApiConfig({
    PAPERCLIP_API_BASE_URL: "   ",
    PAPERCLIP_API_URL: "https://real",
    PAPERCLIP_API_KEY: "",
    PAPERCLIP_API_TOKEN: "real-token",
  });
  assert.equal(out.base, "https://real");
  assert.equal(out.baseEnv, "PAPERCLIP_API_URL");
  assert.equal(out.tokenEnv, "PAPERCLIP_API_TOKEN");
});

test("resolvePaperclipApiConfig trims surrounding whitespace on base", () => {
  const out = resolvePaperclipApiConfig({
    PAPERCLIP_API_URL: "  https://trimmed  ",
  });
  assert.equal(out.base, "https://trimmed");
});

test("buildIssueUrl produces the canonical path for origin-style base", () => {
  const url = buildIssueUrl("https://paperclip.example", "LET-181");
  assert.equal(url, "https://paperclip.example/api/issues/LET-181");
});

test("buildIssueUrl does not double the /api segment for api-base style base", () => {
  const url = buildIssueUrl("https://paperclip.example/api", "LET-181");
  assert.equal(url, "https://paperclip.example/api/issues/LET-181");
});

test("buildIssueUrl handles trailing slashes idempotently", () => {
  assert.equal(
    buildIssueUrl("https://paperclip.example/", "LET-181"),
    "https://paperclip.example/api/issues/LET-181",
  );
  assert.equal(
    buildIssueUrl("https://paperclip.example/api/", "LET-181"),
    "https://paperclip.example/api/issues/LET-181",
  );
  assert.equal(
    buildIssueUrl("https://paperclip.example/api///", "LET-181"),
    "https://paperclip.example/api/issues/LET-181",
  );
});

test("buildIssueUrl is case-insensitive on the trailing /api segment", () => {
  assert.equal(
    buildIssueUrl("https://paperclip.example/API", "LET-181"),
    "https://paperclip.example/api/issues/LET-181",
  );
});

test("buildIssueUrl url-encodes the identifier", () => {
  const url = buildIssueUrl("https://paperclip.example", "LET 181/odd");
  assert.equal(url, "https://paperclip.example/api/issues/LET%20181%2Fodd");
});

test("buildIssueUrl returns null when inputs are missing or empty", () => {
  assert.equal(buildIssueUrl(null, "LET-181"), null);
  assert.equal(buildIssueUrl("https://paperclip.example", null), null);
  assert.equal(buildIssueUrl("", "LET-181"), null);
  assert.equal(buildIssueUrl("   ", "LET-181"), null);
});

test("buildIssueUrl does not strip /api when it is part of a deeper path", () => {
  // Only a *trailing* /api segment should be collapsed; mid-path /api/v1 must stay.
  const url = buildIssueUrl("https://paperclip.example/api/v1", "LET-181");
  assert.equal(url, "https://paperclip.example/api/v1/api/issues/LET-181");
});

// ---------------------------------------------------------------------------
// classifyWorktree — CLOSED / UNKNOWN PR states are NOT a current
// reconciliation path. Active non-final issue + ahead/local commits with
// a non-OPEN/non-MERGED PR must surface as WARN, not silently OK.
// ---------------------------------------------------------------------------

test("classifyWorktree: active non-final + CLOSED PR + local commits => WARN (not OK)", () => {
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-999",
    branch: "feature/LET-999",
    upstream: "fork/master",
    ahead: 2,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 2,
    prState: "CLOSED",
    issueIdentifier: "LET-999",
    issueStatus: "in_progress",
  });
  assert.equal(out.level, "WARN", `expected WARN for active+CLOSED+local commits, got ${out.level} (reasons: ${out.reasons.join("|")})`);
  assert.ok(
    out.reasons.some((r) => r.includes("CLOSED")),
    `expected reason to call out the CLOSED PR state; got: ${out.reasons.join("|")}`,
  );
});

test("classifyWorktree: active non-final + CLOSED PR + ahead (no local commits) => WARN", () => {
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-999",
    branch: "feature/LET-999",
    upstream: "fork/master",
    ahead: 3,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 0,
    prState: "CLOSED",
    issueIdentifier: "LET-999",
    issueStatus: "in_progress",
  });
  assert.equal(out.level, "WARN");
  assert.ok(out.reasons.some((r) => r.includes("CLOSED")));
});

test("classifyWorktree: active non-final + UNKNOWN PR + local commits => WARN", () => {
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-999",
    branch: "feature/LET-999",
    upstream: "fork/master",
    ahead: 1,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 1,
    prState: "UNKNOWN",
    issueIdentifier: "LET-999",
    issueStatus: "in_progress",
  });
  assert.equal(out.level, "WARN", `expected WARN for active+UNKNOWN+local commits, got ${out.level}`);
  assert.ok(
    out.reasons.some((r) => r.toLowerCase().includes("unknown")),
    `expected reason to call out PR status unknown; got: ${out.reasons.join("|")}`,
  );
});

test("classifyWorktree: active non-final + MERGED PR fully reconciled (no ahead, no local commits) is OK", () => {
  // A historical merged PR covers exactly the commits it merged. When the
  // branch matches base (localCommitCount=0, ahead=0) and the worktree is
  // clean, this is the healthy post-merge state.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-999",
    branch: "feature/LET-999",
    upstream: "fork/master",
    ahead: 0,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 0,
    prState: "MERGED",
    issueIdentifier: "LET-999",
    issueStatus: "in_progress",
  });
  assert.equal(out.level, "OK", `expected OK for fully-reconciled MERGED PR, got ${out.level} (reasons: ${out.reasons.join("|")})`);
});

test("classifyWorktree: active non-final + MERGED PR + local commits not in base is WARN", () => {
  // QA blocker (comment fd1c7fee): a historical merged PR must not mask new
  // commits added after the merge. localCommitCount>0 means the branch has
  // advanced past whatever the PR reconciled — those commits are not in
  // master and must surface.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-999",
    branch: "feature/LET-999",
    upstream: "fork/master",
    ahead: 1,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 1,
    prState: "MERGED",
    issueIdentifier: "LET-999",
    issueStatus: "in_progress",
  });
  assert.equal(out.level, "WARN", `expected WARN for MERGED PR with new local commits, got ${out.level} (reasons: ${out.reasons.join("|")})`);
  assert.ok(
    out.reasons.some((r) => r.toLowerCase().includes("merged")),
    `expected reason to call out historical MERGED PR; got: ${out.reasons.join("|")}`,
  );
});

test("classifyWorktree: active non-final + MERGED PR + ahead-only divergence (no local commits counted) is WARN", () => {
  // Even when localCommitCount=0 (e.g. upstream-only ahead reporting),
  // ahead>0 against base after a historical merge still indicates
  // post-merge work not reconciled into base.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-999",
    branch: "feature/LET-999",
    upstream: "fork/master",
    ahead: 2,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 0,
    prState: "MERGED",
    issueIdentifier: "LET-999",
    issueStatus: "in_progress",
  });
  assert.equal(out.level, "WARN", `expected WARN for MERGED PR with ahead-only divergence, got ${out.level} (reasons: ${out.reasons.join("|")})`);
  assert.ok(
    out.reasons.some((r) => r.toLowerCase().includes("merged")),
    `expected reason to call out historical MERGED PR; got: ${out.reasons.join("|")}`,
  );
});

test("classifyWorktree: UNKNOWN-status issue + MERGED PR + local commits is WARN", () => {
  // Unknown issue status (e.g. offline/no Paperclip enrichment) is treated
  // as potentially active. A historical merged PR with new local commits
  // must still surface for review.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-999",
    branch: "feature/LET-999",
    upstream: "fork/master",
    ahead: 1,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 1,
    prState: "MERGED",
    issueIdentifier: "LET-999",
    issueStatus: "unknown",
  });
  assert.equal(out.level, "WARN", `expected WARN for unknown-status MERGED PR with new local commits, got ${out.level} (reasons: ${out.reasons.join("|")})`);
});

test("classifyWorktree: final-status issue + MERGED PR + ahead-only divergence is BLOCK", () => {
  // QA blocker (2026-05-17): a done/cancelled issue with ahead>0 must BLOCK
  // even when localCommitCount=0 and the historical PR is MERGED. The merge
  // did not reconcile commits added after it, so ahead-only post-merge
  // divergence on a final-status issue is still stranded work.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-999",
    branch: "feature/LET-999",
    upstream: "fork/master",
    ahead: 1,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 0,
    prState: "MERGED",
    issueIdentifier: "LET-999",
    issueStatus: "done",
  });
  assert.equal(out.level, "BLOCK", `reasons: ${out.reasons.join("|")}`);
  assert.ok(
    out.reasons.some((r) => r.toLowerCase().includes("merged")),
    `expected reason to call out historical MERGED PR; got: ${out.reasons.join("|")}`,
  );
});

test("classifyWorktree: final-status issue + MERGED PR + local commits remains BLOCK", () => {
  // Final-issue rule must still escalate to BLOCK regardless of MERGED PR
  // state — done/cancelled issues should not have any post-merge local
  // commits stranded.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-181",
    branch: "enterprise-agent-os/LET-181",
    upstream: "fork/master",
    ahead: 1,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 1,
    prState: "MERGED",
    issueIdentifier: "LET-181",
    issueStatus: "done",
  });
  assert.equal(out.level, "BLOCK", `expected BLOCK for done-issue MERGED PR with new local commits, got ${out.level} (reasons: ${out.reasons.join("|")})`);
});

test("classifyWorktree: clean worktree with CLOSED PR (no ahead/local commits) is OK", () => {
  // Nothing to reconcile — the branch matches base and the closed PR is
  // historical. Only ahead/local-commit work attached to a non-active PR
  // should surface.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-999",
    branch: "feature/LET-999",
    upstream: "fork/master",
    ahead: 0,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 0,
    prState: "CLOSED",
    issueIdentifier: "LET-999",
    issueStatus: "in_progress",
  });
  assert.equal(out.level, "OK");
});

// ---------------------------------------------------------------------------
// QA blocker (comment 1f915618): runtime token selection must honor
// "first non-empty token wins". A whitespace-only PAPERCLIP_API_KEY must not
// shadow a valid PAPERCLIP_API_TOKEN, and the resolved token must be the one
// actually sent in the Bearer header — not a raw `process.env.A || B || C`
// fallback that re-introduces the whitespace-wins bug.
// ---------------------------------------------------------------------------

test("resolvePaperclipApiConfig returns the trimmed token value of the selected env var", () => {
  // Whitespace in PAPERCLIP_API_KEY must be ignored — fall through to
  // PAPERCLIP_API_TOKEN with the trimmed value.
  const out = resolvePaperclipApiConfig({
    PAPERCLIP_API_KEY: " ",
    PAPERCLIP_API_TOKEN: "mock-token",
  });
  assert.equal(out.tokenEnv, "PAPERCLIP_API_TOKEN");
  assert.equal(out.tokenPresent, true);
  assert.equal(out.token, "mock-token");

  // Surrounding whitespace on the actual selected token is also trimmed.
  const padded = resolvePaperclipApiConfig({
    PAPERCLIP_API_TOKEN: "  mock-token  ",
  });
  assert.equal(padded.token, "mock-token");

  // No token at all => null + tokenPresent false.
  const empty = resolvePaperclipApiConfig({});
  assert.equal(empty.token, null);
  assert.equal(empty.tokenPresent, false);
  assert.equal(empty.tokenEnv, null);
});

test("fetchIssueStatus sends Bearer header with the resolved token when PAPERCLIP_API_KEY is whitespace (LET-335 QA blocker)", async () => {
  // Mirrors the QA repro: env PAPERCLIP_API_URL=<mock> PAPERCLIP_API_KEY=' '
  // PAPERCLIP_API_TOKEN='mock-token' must send Authorization: Bearer mock-token.
  const cfg = resolvePaperclipApiConfig({
    PAPERCLIP_API_URL: "http://127.0.0.1",
    PAPERCLIP_API_KEY: " ",
    PAPERCLIP_API_TOKEN: "mock-token",
  });
  assert.equal(cfg.tokenEnv, "PAPERCLIP_API_TOKEN");
  assert.equal(cfg.token, "mock-token");

  const captured = [];
  const server = http.createServer((req, res) => {
    captured.push({
      url: req.url,
      authorization: req.headers.authorization || "",
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "done" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await fetchIssueStatus({
      identifier: "LET-999",
      base: `http://127.0.0.1:${port}`,
      token: cfg.token,
    });
    assert.equal(result.status, "done");
    assert.equal(result.reason, null);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, "/api/issues/LET-999");
    assert.equal(
      captured[0].authorization,
      "Bearer mock-token",
      `expected resolved token in Bearer header, got: ${captured[0].authorization}`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// QA blocker (2026-05-17): `localCommitCount` is measured against `baseRef`
// (e.g. fork/master) via `git log baseRef..HEAD`, while `ahead` is measured
// against `upstream`. Reasons must label each count with the ref it was
// computed against. Previously the localCommits reason used the upstream
// label, which on the LET-335 PR worktree (upstream=fork/enterprise-agent-os/LET-335)
// emitted the misleading "9 local commit(s) not in fork/enterprise-agent-os/LET-335"
// when the count was actually `fork/master..HEAD == 9`.
// ---------------------------------------------------------------------------

test("classifyWorktree: local-commit reason labels baseRef, not upstream (LET-335 PR worktree repro)", () => {
  // Repro state: clean PR worktree, upstream tracks the branch's own remote
  // ref so ahead=0, but `git log fork/master..HEAD` returns 9. The label
  // must be the baseRef the count was computed from.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/enterprise-agent-os/LET-335",
    branch: "enterprise-agent-os/LET-335",
    upstream: "fork/enterprise-agent-os/LET-335",
    ahead: 0,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 9,
    prState: "UNKNOWN",
    issueIdentifier: "LET-335",
    issueStatus: "unknown",
    isCanonicalPath: false,
    baseRef: "fork/master",
  });
  assert.equal(out.level, "WARN");
  const joined = out.reasons.join("|");
  assert.ok(
    out.reasons.some((r) => /9 local commit\(s\) not in fork\/master/.test(r)),
    `expected reason to label baseRef (fork/master); got: ${joined}`,
  );
  assert.ok(
    !/not in fork\/enterprise-agent-os\/LET-335/.test(joined),
    `reason must not attribute baseRef-measured count to upstream tracking ref; got: ${joined}`,
  );
});

test("classifyWorktree: baseRef defaults to fork/master when not provided (back-compat)", () => {
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/LET-999",
    branch: "feature/LET-999",
    upstream: "fork/feature/LET-999",
    ahead: 0,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 3,
    prState: "NONE",
    issueIdentifier: "LET-999",
    issueStatus: "in_progress",
  });
  assert.equal(out.level, "WARN");
  assert.ok(
    out.reasons.some((r) => r.includes("not in fork/master")),
    `expected default baseRef label fork/master; got: ${out.reasons.join("|")}`,
  );
});

test("classifyWorktree: final-issue local-commit reason labels baseRef, not upstream", () => {
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip-worktrees/enterprise-agent-os/LET-181",
    branch: "enterprise-agent-os/LET-181",
    upstream: "fork/enterprise-agent-os/LET-181",
    ahead: 0,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 4,
    prState: "NONE",
    issueIdentifier: "LET-181",
    issueStatus: "done",
    baseRef: "fork/master",
  });
  assert.equal(out.level, "BLOCK");
  assert.ok(
    out.reasons.some((r) => /local commits not in fork\/master/.test(r)),
    `expected baseRef label on final-issue reason; got: ${out.reasons.join("|")}`,
  );
});

test("classifyWorktree: canonical-path divergence label uses baseRef, not upstream", () => {
  // Canonical /opt/paperclip on a non-master branch whose upstream is its
  // own remote ref (not master). The "diverged from" label must point at
  // master, since master is the reconciliation target.
  const out = classifyWorktree({
    worktreePath: "/opt/paperclip",
    branch: "release/phase-3c",
    upstream: "fork/release/phase-3c",
    ahead: 0,
    behind: 0,
    dirtyFileCount: 0,
    localCommitCount: 5,
    prState: "NONE",
    issueIdentifier: null,
    issueStatus: "unknown",
    isCanonicalPath: true,
    baseRef: "fork/master",
  });
  assert.equal(out.level, "BLOCK");
  assert.ok(
    out.reasons.some((r) => /diverged from fork\/master/.test(r)),
    `expected canonical divergence to label baseRef (fork/master); got: ${out.reasons.join("|")}`,
  );
});

test("fetchIssueStatus returns 'unknown' with reason when token is missing (does not send blank Bearer)", async () => {
  // Defensive: when no non-empty token resolves, the helper must short-circuit
  // and not issue a `Bearer ` (blank) header to the API.
  const captured = [];
  const server = http.createServer((req, res) => {
    captured.push(req.headers.authorization || "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "done" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await fetchIssueStatus({
      identifier: "LET-999",
      base: `http://127.0.0.1:${port}`,
      token: null,
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "missing api env");
    assert.equal(captured.length, 0, "must not contact the API without a token");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
