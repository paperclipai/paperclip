#!/usr/bin/env node
// audit-worktrees.mjs
//
// Read-only operational audit for EAOS/Paperclip git worktrees.
// Scans /opt/paperclip and /opt/paperclip-worktrees for stranded work
// (dirty/ahead/no-PR worktrees), classifies each entry, and emits a
// concise human-readable + JSON report. No diffs, no file contents, no
// secrets are printed.
//
// Implements LET-335 (decision from LET-333).
//
// Usage:
//   node scripts/audit-worktrees.mjs [--json] [--root <path>]... [--base <ref>]
//                                    [--repo <owner/name>] [--no-gh]
//                                    [--no-paperclip] [--quiet]
//
// Exit codes:
//   0 - OK or WARN-only (informational)
//   2 - one or more BLOCK findings
//   1 - unexpected error
//
// Safety: read-only. Never runs destructive git operations (reset, clean,
// branch -D, etc.). Never prints diff bodies or file contents. Filenames
// only — paths/branches/short SHAs/subjects.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_ROOTS = ["/opt/paperclip", "/opt/paperclip-worktrees"];
const DEFAULT_BASE_REF = "fork/master";
const DEFAULT_GH_REPO = "lmanualm/paperclip";
const FINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

// Canonical worktree paths are the live, primary repo checkouts (e.g.
// /opt/paperclip). They are NOT the same as scan roots: a user may pass
// `--root /opt/paperclip-worktrees/...` to scope an audit to a single
// child worktree, but that child is still a non-canonical PR worktree,
// not a canonical checkout. Conflating the two (the LET-335 QA blocker)
// caused legitimate PR worktrees to be reported as canonical/diverged
// and BLOCKed when the user scoped the audit to themselves.
export const CANONICAL_WORKTREE_PATHS = new Set(["/opt/paperclip"]);

// Pure helper: a worktree path is canonical only when it matches the
// hardcoded canonical set. Scan roots have no bearing on canonicality.
export function isCanonicalWorktreePath(worktreePath) {
  return CANONICAL_WORKTREE_PATHS.has(worktreePath);
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export function parseCliArgs(argv) {
  const opts = {
    json: false,
    quiet: false,
    roots: [],
    baseRef: DEFAULT_BASE_REF,
    ghRepo: DEFAULT_GH_REPO,
    useGh: true,
    usePaperclip: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--no-gh") opts.useGh = false;
    else if (a === "--no-paperclip") opts.usePaperclip = false;
    else if (a === "--root") opts.roots.push(argv[++i]);
    else if (a === "--base") opts.baseRef = argv[++i];
    else if (a === "--repo") opts.ghRepo = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.roots.length === 0) opts.roots = [...DEFAULT_ROOTS];
  return opts;
}

// ---------------------------------------------------------------------------
// Pure parsers (exported for tests)
// ---------------------------------------------------------------------------

// Parse `git worktree list --porcelain` output into structured records.
export function parseWorktreeListPorcelain(text) {
  const out = [];
  let current = null;
  const flush = () => {
    if (current && current.worktree) out.push(current);
    current = null;
  };
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { worktree: line.slice("worktree ".length), branch: null, head: null, detached: false, bare: false };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      // refs/heads/<name>
      const ref = line.slice("branch ".length);
      current.branch = ref.replace(/^refs\/heads\//, "");
    } else if (current && line === "detached") {
      current.detached = true;
    } else if (current && line === "bare") {
      current.bare = true;
    }
  }
  flush();
  return out;
}

// Parse `git status --porcelain=v1` lines into filename buckets (filenames only).
export function parseStatusPorcelain(text) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const rawLine of String(text).split("\n")) {
    if (!rawLine) continue;
    // format: XY <space> path  (path may contain spaces)
    const X = rawLine[0];
    const Y = rawLine[1];
    const rest = rawLine.slice(3);
    if (!rest) continue;
    // Rename/copy: "R  old -> new" — keep the new name only.
    const file = rest.includes(" -> ") ? rest.split(" -> ").pop() : rest;
    if (X === "?" && Y === "?") {
      untracked.push(file);
      continue;
    }
    if (X !== " " && X !== "?") staged.push(file);
    if (Y !== " " && Y !== "?") unstaged.push(file);
  }
  return { staged, unstaged, untracked };
}

// Parse `git for-each-ref` upstream/ahead-behind output.
// Input: "<upstream>\t<ahead>\t<behind>" or empty upstream.
export function parseUpstreamLine(text) {
  const line = String(text || "").split("\n")[0] || "";
  const [upstreamRaw, aheadRaw, behindRaw] = line.split("\t");
  const upstream = upstreamRaw && upstreamRaw.length > 0 ? upstreamRaw : null;
  const ahead = aheadRaw && /^\d+$/.test(aheadRaw) ? Number(aheadRaw) : 0;
  const behind = behindRaw && /^\d+$/.test(behindRaw) ? Number(behindRaw) : 0;
  return { upstream, ahead, behind };
}

// Infer the Paperclip issue identifier from branch and path.
// Looks for the first ALL-CAPS prefix + number, e.g. LET-181, PAP-2351.
export function inferIssueIdentifier({ branch, worktreePath }) {
  const candidates = [branch || "", worktreePath || ""];
  const re = /\b([A-Z]{2,6})-(\d{1,6})\b/;
  for (const c of candidates) {
    const m = re.exec(c);
    if (m) return `${m[1]}-${m[2]}`;
  }
  return null;
}

// Classify a worktree finding. Pure function.
// Inputs come from already-collected metadata; never reads disk.
// Returns { level: "OK"|"WARN"|"BLOCK", reasons: string[] }
//
// Label discipline: `localCommitCount` is measured against `baseRef`
// (e.g. `git log fork/master..HEAD`), while `ahead` is measured against
// `upstream` (e.g. fork/enterprise-agent-os/LET-335). Reasons must label
// each count with the ref it was computed from. Conflating them — saying
// "N local commits not in <upstream>" when the count came from baseRef —
// is the LET-335 QA blocker fixed on 2026-05-17 (the upstream may match
// the branch and report 0 local commits while `fork/master..HEAD` has
// 9, which silently misled reviewers).
export function classifyWorktree({
  worktreePath,
  branch,
  upstream,
  ahead,
  behind,
  dirtyFileCount,
  localCommitCount,
  prState, // "OPEN" | "MERGED" | "CLOSED" | "NONE" | "UNKNOWN"
  issueIdentifier,
  issueStatus, // "done"|"cancelled"|"in_progress"|... | "unknown" | null
  protectedBranches = ["master", "main", "fork/master"],
  isCanonicalPath = false,
  baseRef = DEFAULT_BASE_REF,
}) {
  const reasons = [];
  const isProtected = branch && protectedBranches.includes(branch);
  const dirty = dirtyFileCount > 0;
  const ahead0 = ahead > 0;
  const hasLocalUnpushedCommits = localCommitCount > 0;
  const prMerged = prState === "MERGED";
  const prOpen = prState === "OPEN";
  // "No current reconciliation path" — anything other than OPEN/MERGED.
  // CLOSED, NONE, and UNKNOWN all mean the branch is not currently being
  // reconciled into master via a live PR, so unmerged ahead/local-commit
  // work attached to that branch needs to be surfaced (WARN/BLOCK), not
  // silently treated as healthy.
  const noActivePr = !prOpen && !prMerged;
  const finalIssue = issueStatus && FINAL_ISSUE_STATUSES.has(issueStatus);

  // Protected branch (master/main/fork/master) — only flag dirty state, never branch hygiene.
  if (isProtected) {
    if (dirty) reasons.push("dirty files on canonical/protected worktree");
    return { level: dirty ? "WARN" : "OK", reasons };
  }

  // Canonical path (e.g. /opt/paperclip) on a NON-protected branch:
  // BLOCK when it has diverged from base without a current PR reconciliation path.
  // This is the "live branch diverged from master without reconciliation issue/PR"
  // case called out in LET-335 scope. Use either upstream ahead-count OR commits
  // not in baseRef as the divergence signal — the latter catches branches with
  // no upstream tracking, which is exactly how /opt/paperclip stranded during
  // the LET-181 incident pattern.
  //
  // A historical MERGED PR is NOT a current reconciliation path for commits
  // added on top of the branch after that merge: it covered only the commits
  // it merged. Post-merge divergence on a canonical live checkout must still
  // BLOCK — otherwise the same risk fixed for non-canonical active issues
  // (QA comment fd1c7fee) is re-introduced through the canonical path.
  if (isCanonicalPath) {
    const divergedFromBase = ahead0 || hasLocalUnpushedCommits;
    if (divergedFromBase && !prOpen) {
      // Divergence is measured against base (master), not upstream. The
      // canonical reconciliation path for /opt/paperclip is master, so the
      // label must reflect that even when upstream points elsewhere.
      const refLabel = baseRef || "base";
      const prTail = prMerged
        ? "after historical merged PR (pr=MERGED, not reconciled in base)"
        : "with no open/merged PR";
      reasons.push(
        `canonical worktree on non-master branch ${branch || "(detached)"} diverged from ${refLabel} ${prTail}`,
      );
      if (dirty) reasons.push("dirty files on canonical worktree");
      return { level: "BLOCK", reasons };
    }
    if (dirty) {
      reasons.push("dirty files on canonical/protected worktree");
      return { level: "WARN", reasons };
    }
    return { level: "OK", reasons };
  }

  // BLOCK: dirty/ahead/no-PR attached to a final-status issue (done/cancelled).
  // LET-181 is the canonical example: useful work stranded on a worktree whose
  // issue has already been marked complete. A historical MERGED PR does NOT
  // reconcile post-merge ahead-only divergence (e.g. merge commits or commits
  // added after the PR merged), so ahead>0 on a final-status issue must
  // BLOCK regardless of PR state.
  if (finalIssue && (dirty || hasLocalUnpushedCommits || ahead0)) {
    if (dirty) reasons.push(`dirty worktree attached to ${issueStatus} issue ${issueIdentifier || "(unknown)"}`);
    // `hasLocalUnpushedCommits` was measured against baseRef, so label it as such.
    if (hasLocalUnpushedCommits) reasons.push(`local commits not in ${baseRef || "base"} on ${issueStatus} issue ${issueIdentifier || "(unknown)"}`);
    if (ahead0) {
      const prTail = prMerged
        ? "after historical merged PR (pr=MERGED, not reconciled in base)"
        : "with no merged PR";
      // `ahead` was measured against upstream tracking, so keep the upstream label here.
      reasons.push(`branch ahead of ${upstream || "base"} ${prTail} on ${issueStatus} issue`);
    }
    return { level: "BLOCK", reasons };
  }

  // Clean worktree with an OPEN PR is healthy — the PR is the current
  // reconciliation path regardless of ahead/behind counts.
  if (!dirty && prOpen) {
    return { level: "OK", reasons: [] };
  }

  // Clean, fully-reconciled worktree on a MERGED PR is healthy only when
  // localCommitCount=0 and ahead=0. A historical merged PR reconciled the
  // commits that were merged at that time; it does NOT cover commits added
  // afterwards. New commits on top of the merged branch are not in master,
  // so silently treating MERGED as OK would recreate the LET-181 class of
  // false "merged/green" evidence after a post-merge branch advance.
  if (!dirty && prMerged && !hasLocalUnpushedCommits && !ahead0) {
    return { level: "OK", reasons: [] };
  }

  // WARN: dirty / ahead / no-active-PR on active non-final issue (in_progress,
  // todo, in_review, blocked) or on unknown issue status (treated as
  // potentially active — only known-final statuses escalate to BLOCK).
  //
  // "No active PR" means anything other than OPEN/MERGED. A CLOSED PR is
  // *not* a current reconciliation path: it was either rejected or
  // superseded and the branch is still ahead/dirty without a live
  // replacement. UNKNOWN means the PR lookup failed and we cannot prove a
  // reconciliation path exists. MERGED is a *historical* reconciliation
  // path: it covers the commits it merged, but not new commits added on
  // top of the branch afterwards, so post-merge local-only commits or
  // ahead-only divergence must also surface, not silently pass.
  const prTail = (() => {
    if (prState === "NONE") return "with no PR";
    if (prState === "CLOSED") return "with no open/merged PR (pr=CLOSED)";
    if (prState === "UNKNOWN") return "(PR status unknown)";
    if (prState === "MERGED") return "after historical merged PR (pr=MERGED, not reconciled in base)";
    return `with no open/merged PR (pr=${prState || "?"})`;
  })();
  if (dirty) reasons.push("dirty (uncommitted/untracked) files");
  // Surface unmerged local commits when no current reconciliation path
  // exists OR when the only PR is a historical merge (which did not
  // include these commits — that is the LET-181 mask path).
  //
  // localCommitCount comes from `git log baseRef..HEAD`, so label it with
  // baseRef. ahead0 comes from upstream tracking, so it keeps the upstream
  // label. The two refs can differ (e.g. branch pushed to its own remote
  // tracking ref while baseRef is fork/master): mixing the labels misled
  // QA on the LET-335 PR worktree.
  if (hasLocalUnpushedCommits && (noActivePr || prMerged)) {
    reasons.push(`${localCommitCount} local commit(s) not in ${baseRef || "base"} ${prTail}`);
  }
  if (ahead0 && (noActivePr || prMerged) && !hasLocalUnpushedCommits) {
    reasons.push(`ahead of ${upstream || "base"} ${prTail}`);
  }
  if (reasons.length === 0) return { level: "OK", reasons: [] };
  return { level: "WARN", reasons };
}

// Classify the overall exit level from a list of findings.
export function summarizeFindings(findings) {
  let block = 0;
  let warn = 0;
  let ok = 0;
  for (const f of findings) {
    if (f.classification.level === "BLOCK") block += 1;
    else if (f.classification.level === "WARN") warn += 1;
    else ok += 1;
  }
  return { block, warn, ok, total: findings.length };
}

// ---------------------------------------------------------------------------
// I/O helpers (kept thin and side-effect-only)
// ---------------------------------------------------------------------------

function runGit(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Discover worktrees attached to a given root git directory using `git worktree list`.
function discoverWorktreesFromRoot(root) {
  if (!isDir(root)) return [];
  // If the root itself is a git checkout, `git worktree list` from inside it
  // lists ALL worktrees attached to that repository. We prefer that.
  const res = runGit(["worktree", "list", "--porcelain"], root);
  if (res.code === 0 && res.stdout.trim()) {
    return parseWorktreeListPorcelain(res.stdout);
  }
  return [];
}

// For each candidate root, collect a deduplicated set of worktree records.
function discoverAllWorktrees(roots) {
  const byPath = new Map();
  for (const root of roots) {
    const items = discoverWorktreesFromRoot(root);
    for (const item of items) {
      // Restrict to worktrees actually within /opt/paperclip{,-worktrees}.
      const inScope = roots.some((r) => item.worktree === r || item.worktree.startsWith(`${r}/`));
      if (!inScope) continue;
      if (!byPath.has(item.worktree)) byPath.set(item.worktree, item);
    }
  }
  return [...byPath.values()];
}

function collectGitStatus(worktreePath) {
  const status = runGit(["status", "--porcelain=v1", "--untracked-files=normal"], worktreePath);
  if (status.code !== 0) return { staged: [], unstaged: [], untracked: [], error: status.stderr.trim() || null };
  const parsed = parseStatusPorcelain(status.stdout);
  return { ...parsed, error: null };
}

function collectUpstream(worktreePath) {
  // Use for-each-ref on HEAD's branch to get upstream + ahead/behind counts.
  const headRef = runGit(["symbolic-ref", "--quiet", "HEAD"], worktreePath);
  if (headRef.code !== 0) {
    // detached HEAD
    return { upstream: null, ahead: 0, behind: 0, detached: true };
  }
  const fmt = "%(upstream:short)%09%(upstream:track,nobracket)";
  const res = runGit(["for-each-ref", `--format=${fmt}`, headRef.stdout.trim()], worktreePath);
  if (res.code !== 0 || !res.stdout) return { upstream: null, ahead: 0, behind: 0, detached: false };
  // upstream:track,nobracket emits e.g. "ahead 3, behind 6" or "gone" or "".
  const [upstreamRaw, trackRaw] = res.stdout.trim().split("\t");
  const upstream = upstreamRaw && upstreamRaw.length > 0 ? upstreamRaw : null;
  let ahead = 0;
  let behind = 0;
  if (trackRaw) {
    const am = /ahead (\d+)/.exec(trackRaw);
    const bm = /behind (\d+)/.exec(trackRaw);
    if (am) ahead = Number(am[1]);
    if (bm) behind = Number(bm[1]);
  }
  return { upstream, ahead, behind, detached: false };
}

function collectLocalOnlyCommits(worktreePath, baseRef) {
  // Commits on HEAD that are not in baseRef.
  const res = runGit(["log", "--no-merges", "--pretty=%h\t%s", `${baseRef}..HEAD`], worktreePath);
  if (res.code !== 0) return { commits: [], error: res.stderr.trim() || null };
  const commits = res.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, ...rest] = l.split("\t");
      return { sha, subject: rest.join("\t") };
    });
  return { commits, error: null };
}

function collectShortHead(worktreePath) {
  const res = runGit(["rev-parse", "--short", "HEAD"], worktreePath);
  return res.code === 0 ? res.stdout.trim() : null;
}

function ghAvailable() {
  const which = spawnSync("which", ["gh"], { encoding: "utf8" });
  return which.status === 0 && (which.stdout || "").trim().length > 0;
}

function collectPrState({ branch, ghRepo }) {
  if (!branch) return { state: "UNKNOWN", number: null, url: null, reason: "no branch" };
  const args = ["pr", "list", "--repo", ghRepo, "--head", branch, "--state", "all", "--json", "number,state,url", "--limit", "5"];
  const res = spawnSync("gh", args, { encoding: "utf8", timeout: 15000 });
  if (res.status !== 0) {
    return { state: "UNKNOWN", number: null, url: null, reason: (res.stderr || "").split("\n")[0] || `gh exited ${res.status}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout || "[]");
  } catch (err) {
    return { state: "UNKNOWN", number: null, url: null, reason: `gh json parse: ${err.message}` };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { state: "NONE", number: null, url: null, reason: null };
  }
  // Prefer OPEN, then MERGED, then CLOSED.
  const order = { OPEN: 0, MERGED: 1, CLOSED: 2 };
  parsed.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
  const top = parsed[0];
  return { state: top.state || "UNKNOWN", number: top.number ?? null, url: top.url ?? null, reason: null };
}

// Env var names checked, in priority order. PAPERCLIP_API_BASE_URL is the
// historical name; PAPERCLIP_API_URL / PAPERCLIP_RUNTIME_API_URL are what the
// Paperclip runtime actually injects into agents. PAPERCLIP_BASE_URL kept for
// legacy compatibility.
export const PAPERCLIP_API_BASE_ENV_NAMES = [
  "PAPERCLIP_API_BASE_URL",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_RUNTIME_API_URL",
  "PAPERCLIP_BASE_URL",
];

export const PAPERCLIP_API_TOKEN_ENV_NAMES = [
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_API_TOKEN",
  "PAPERCLIP_BEARER_TOKEN",
];

// Pure helper: resolves the Paperclip API base + token from an env-like object.
// Returns the env var name that supplied each value so callers can render that
// in diagnostics without printing the value itself. The trimmed token value is
// included so callers do not need to re-resolve against process.env (which
// would re-introduce the "whitespace in higher-priority var wins" bug).
export function resolvePaperclipApiConfig(env) {
  const e = env || {};
  let base = null;
  let baseEnv = null;
  for (const name of PAPERCLIP_API_BASE_ENV_NAMES) {
    const v = e[name];
    if (typeof v === "string" && v.trim().length > 0) {
      base = v.trim();
      baseEnv = name;
      break;
    }
  }
  let token = null;
  let tokenEnv = null;
  for (const name of PAPERCLIP_API_TOKEN_ENV_NAMES) {
    const v = e[name];
    if (typeof v === "string" && v.trim().length > 0) {
      token = v.trim();
      tokenEnv = name;
      break;
    }
  }
  return { base, baseEnv, token, tokenPresent: token !== null, tokenEnv };
}

// Pure helper: builds the Paperclip issue URL for a given base + identifier.
// Accepts both origin-style values (`https://host`) and API-base values
// (`https://host/api`) and always produces exactly `/api/issues/:identifier`
// — never `/api/api/issues/:identifier`. Returns null if base is missing.
export function buildIssueUrl(base, identifier) {
  if (!base || !identifier) return null;
  let trimmed = String(base).trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  // Detect a trailing `/api` (case-insensitive) so we don't double up.
  if (/\/api$/i.test(trimmed)) {
    trimmed = trimmed.replace(/\/api$/i, "");
  }
  return `${trimmed}/api/issues/${encodeURIComponent(identifier)}`;
}

export async function fetchIssueStatus({ identifier, base, token }) {
  if (!identifier || !base || !token) return { status: "unknown", reason: "missing api env" };
  const url = buildIssueUrl(base, identifier);
  if (!url) return { status: "unknown", reason: "missing api env" };
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!res.ok) return { status: "unknown", reason: `http ${res.status}` };
    const body = await res.json();
    return { status: body && typeof body.status === "string" ? body.status : "unknown", reason: null };
  } catch (err) {
    return { status: "unknown", reason: err.message || "fetch error" };
  }
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

async function runAudit(opts) {
  const roots = opts.roots;
  const worktrees = discoverAllWorktrees(roots);

  const useGh = opts.useGh && ghAvailable();
  // Resolve API base + token from any of the supported env var names. The
  // value itself is only used as a Bearer header — never printed. The env var
  // *name* is fine to surface in diagnostics.
  const apiConfig = opts.usePaperclip ? resolvePaperclipApiConfig(process.env) : { base: null, baseEnv: null, token: null, tokenPresent: false, tokenEnv: null };
  const apiBase = apiConfig.base;
  const apiToken = apiConfig.token;

  const findings = [];
  for (const wt of worktrees) {
    const finding = await auditOneWorktree({
      wt,
      baseRef: opts.baseRef,
      ghRepo: opts.ghRepo,
      useGh,
      apiBase,
      apiToken,
      roots,
    });
    findings.push(finding);
  }
  findings.sort((a, b) => {
    const rank = { BLOCK: 0, WARN: 1, OK: 2 };
    const ra = rank[a.classification.level] ?? 9;
    const rb = rank[b.classification.level] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.worktree.localeCompare(b.worktree);
  });
  return { findings, useGh, apiUsed: Boolean(apiBase && apiToken), summary: summarizeFindings(findings) };
}

async function auditOneWorktree({ wt, baseRef, ghRepo, useGh, apiBase, apiToken, roots }) {
  const status = collectGitStatus(wt.worktree);
  const upstream = wt.detached ? { upstream: null, ahead: 0, behind: 0, detached: true } : collectUpstream(wt.worktree);
  const local = collectLocalOnlyCommits(wt.worktree, baseRef);
  const shortHead = wt.head ? wt.head.slice(0, 8) : collectShortHead(wt.worktree);
  const dirtyFileCount = status.staged.length + status.unstaged.length + status.untracked.length;

  const identifier = inferIssueIdentifier({ branch: wt.branch, worktreePath: wt.worktree });

  let prInfo = { state: useGh && wt.branch ? "UNKNOWN" : "UNKNOWN", number: null, url: null, reason: useGh ? null : "gh disabled or unavailable" };
  if (useGh && wt.branch) prInfo = collectPrState({ branch: wt.branch, ghRepo });

  let issue = { status: "unknown", reason: apiBase ? null : "no Paperclip API base env set (PAPERCLIP_API_BASE_URL/PAPERCLIP_API_URL/PAPERCLIP_RUNTIME_API_URL/PAPERCLIP_BASE_URL)" };
  if (identifier && apiBase && apiToken) {
    issue = await fetchIssueStatus({ identifier, base: apiBase, token: apiToken });
  }

  // Canonical = the live /opt/paperclip checkout itself, never a child
  // worktree under /opt/paperclip-worktrees/. `--root` only narrows scan
  // scope; it does not redefine canonicality (LET-335 QA blocker).
  const isCanonicalPath = isCanonicalWorktreePath(wt.worktree);
  const classification = classifyWorktree({
    worktreePath: wt.worktree,
    branch: wt.branch,
    upstream: upstream.upstream,
    ahead: upstream.ahead,
    behind: upstream.behind,
    dirtyFileCount,
    localCommitCount: local.commits.length,
    prState: prInfo.state,
    issueIdentifier: identifier,
    issueStatus: issue.status,
    isCanonicalPath,
    baseRef,
  });

  return {
    worktree: wt.worktree,
    branch: wt.branch,
    detached: Boolean(wt.detached),
    head: shortHead,
    upstream: upstream.upstream,
    ahead: upstream.ahead,
    behind: upstream.behind,
    dirty: {
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
      total: dirtyFileCount,
    },
    localCommits: local.commits,
    issue: { identifier, status: issue.status, reason: issue.reason },
    pr: prInfo,
    classification,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHuman(report) {
  const lines = [];
  const { summary } = report;
  lines.push(`audit-worktrees: ${summary.total} worktrees | BLOCK=${summary.block} WARN=${summary.warn} OK=${summary.ok}`);
  lines.push(`gh: ${report.useGh ? "enabled" : "disabled/unavailable"}  paperclip-api: ${report.apiUsed ? "enabled" : "disabled/unavailable"}`);
  lines.push("");
  for (const f of report.findings) {
    const label = `[${f.classification.level}]`;
    const tail = f.branch ? `${f.branch}@${f.head ?? "?"}` : f.detached ? `(detached)@${f.head ?? "?"}` : "(no branch)";
    lines.push(`${label} ${f.worktree}  ${tail}`);
    const upstreamLine = f.upstream
      ? `   upstream=${f.upstream} ahead=${f.ahead} behind=${f.behind}`
      : `   upstream=(none) detached=${f.detached}`;
    lines.push(upstreamLine);
    if (f.issue.identifier) {
      lines.push(`   issue=${f.issue.identifier} status=${f.issue.status}${f.issue.reason ? ` (${f.issue.reason})` : ""}`);
    } else {
      lines.push(`   issue=(unknown)`);
    }
    const prTail = f.pr.number ? ` #${f.pr.number}` : "";
    lines.push(`   pr=${f.pr.state}${prTail}${f.pr.reason ? ` (${f.pr.reason})` : ""}`);
    if (f.dirty.total > 0) {
      const groups = [];
      if (f.dirty.staged.length) groups.push(`staged(${f.dirty.staged.length})`);
      if (f.dirty.unstaged.length) groups.push(`unstaged(${f.dirty.unstaged.length})`);
      if (f.dirty.untracked.length) groups.push(`untracked(${f.dirty.untracked.length})`);
      lines.push(`   dirty: ${groups.join(", ")}`);
      const allFiles = [...f.dirty.staged, ...f.dirty.unstaged, ...f.dirty.untracked].slice(0, 12);
      for (const file of allFiles) lines.push(`     - ${file}`);
      if (f.dirty.total > 12) lines.push(`     ... +${f.dirty.total - 12} more`);
    }
    if (f.localCommits.length > 0) {
      lines.push(`   local-only commits (vs base):`);
      for (const c of f.localCommits.slice(0, 8)) lines.push(`     - ${c.sha}  ${c.subject}`);
      if (f.localCommits.length > 8) lines.push(`     ... +${f.localCommits.length - 8} more`);
    }
    if (f.classification.reasons.length > 0) {
      lines.push(`   reasons: ${f.classification.reasons.join("; ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function helpText() {
  return [
    "audit-worktrees.mjs — read-only EAOS worktree audit",
    "",
    "Usage:",
    "  node scripts/audit-worktrees.mjs [--json] [--root <path>]... [--base <ref>]",
    "                                   [--repo <owner/name>] [--no-gh]",
    "                                   [--no-paperclip] [--quiet]",
    "",
    "Defaults:",
    "  roots = /opt/paperclip /opt/paperclip-worktrees",
    "  base  = fork/master",
    "  repo  = lmanualm/paperclip",
    "",
    "Environment (optional, for issue-status enrichment):",
    "  Base URL (first non-empty wins):",
    "    PAPERCLIP_API_BASE_URL, PAPERCLIP_API_URL, PAPERCLIP_RUNTIME_API_URL, PAPERCLIP_BASE_URL",
    "    Both origin (https://host) and api-base (https://host/api) forms accepted.",
    "  Bearer token (first non-empty wins):",
    "    PAPERCLIP_API_KEY, PAPERCLIP_API_TOKEN, PAPERCLIP_BEARER_TOKEN",
    "    Value is sent as Authorization: Bearer ... and never printed.",
    "",
    "Exit codes:",
    "  0 OK or WARN-only, 2 one or more BLOCK findings, 1 error",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(argv) {
  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n${helpText()}\n`);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  const report = await runAudit(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (!opts.quiet) {
    process.stdout.write(`${renderHuman(report)}\n`);
  }
  if (report.summary.block > 0) return 2;
  return 0;
}

const isDirectInvocation = (() => {
  const entry = process.argv[1] || "";
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`audit-worktrees: ${err && err.stack ? err.stack : err}\n`);
      process.exit(1);
    },
  );
}

// Touch existsSync to keep import for future filesystem hooks; harmless and tree-shake-free.
void existsSync;
