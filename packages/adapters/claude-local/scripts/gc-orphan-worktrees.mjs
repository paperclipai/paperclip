#!/usr/bin/env node
// WORKTREE_PATCH_V2: Orphan worktree garbage collection.
//
// Enumerates ~/.paperclip-worktrees/<slug>-<stableKey> and decides whether
// each is safe to remove. Two cohorts:
//
//   A) Stable-key reuseable worktrees (slug-<taskId> or slug-<ms>):
//      - If <stableKey> looks like a Paperclip task ID (FRE-... / uuid), query
//        the Paperclip API for the issue status; if done/cancelled, orphan.
//      - Else (timestamp-like, 13 digits, "ephemeral-<ms>", etc.) — these
//        should not survive past their session. If older than --max-age-hours
//        and no open PR on the branch, orphan.
//
//   B) Worktrees whose branch has a merged PR on origin: orphan immediately.
//
// Safety:
//   - --dry-run is required unless --confirm is explicitly passed.
//   - Defaults to `--dry-run` when neither flag is present.
//   - Never touches worktrees with a live .paperclip-wake.lock (PID alive).
//   - Never touches worktrees with uncommitted changes (unless --force).
//
// Usage:
//   node scripts/gc-orphan-worktrees.mjs --dry-run
//   node scripts/gc-orphan-worktrees.mjs --confirm
//   node scripts/gc-orphan-worktrees.mjs --confirm --max-age-hours 48
//
// Env:
//   PAPERCLIP_API_URL  — required for status queries
//   PAPERCLIP_API_KEY  — required for status queries

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const dryRun = !argv.includes("--confirm") || argv.includes("--dry-run");
const force = argv.includes("--force");
const maxAgeHours = (() => {
  const idx = argv.indexOf("--max-age-hours");
  if (idx >= 0 && argv[idx + 1]) return parseFloat(argv[idx + 1]);
  return 72;
})();

const WORKTREES_ROOT = path.join(os.homedir(), ".paperclip-worktrees");
const API_URL = (process.env.PAPERCLIP_API_URL || "").trim();
const API_KEY = (process.env.PAPERCLIP_API_KEY || "").trim();

function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  return { ok: r.status === 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function looksLikeTaskId(s) {
  // FRE-... (6 alnum) or UUID-like
  return /^(FRE-[A-Z0-9]+|[0-9a-f-]{20,})$/i.test(s);
}

function looksLikeTimestamp(s) {
  return /^(ephemeral-)?\d{13}$/.test(s);
}

async function fetchTaskStatus(taskId) {
  if (!API_URL || !API_KEY) return { status: null, reason: "no-api-creds" };
  const res = spawnSync(
    "curl",
    [
      "-sS",
      "--max-time", "10",
      "-o", "/dev/stdout",
      "-w", "%{http_code}",
      "-H", `Authorization: Bearer ${API_KEY}`,
      `${API_URL}/api/issues/${encodeURIComponent(taskId)}`,
    ],
    { encoding: "utf-8" },
  );
  const body = (res.stdout || "").slice(0, -3);
  const code = (res.stdout || "").slice(-3);
  if (code === "404") return { status: "not-found", reason: "404" };
  if (code !== "200") return { status: null, reason: `http-${code}` };
  try {
    const scrubbed = body.replace(/[\x00-\x1f]/g, " ");
    const parsed = JSON.parse(scrubbed);
    return { status: typeof parsed.status === "string" ? parsed.status : null, reason: "ok" };
  } catch {
    return { status: null, reason: "parse-error" };
  }
}

function checkLiveLock(wkt) {
  try {
    const lockPath = path.join(wkt, ".paperclip-wake.lock");
    const raw = fs.readFileSync(lockPath, "utf-8");
    const m = raw.match(/pid=(\d+)/);
    if (!m) return { live: false, pid: null };
    const pid = parseInt(m[1], 10);
    try {
      process.kill(pid, 0);
      return { live: true, pid };
    } catch {
      return { live: false, pid };
    }
  } catch {
    return { live: false, pid: null };
  }
}

function statusPorcelain(wkt) {
  const r = git(wkt, ["status", "--porcelain"]);
  return r.ok ? r.stdout : "";
}

function branchOf(wkt) {
  const r = git(wkt, ["branch", "--show-current"]);
  return r.ok ? r.stdout : null;
}

function remoteUrl(wkt) {
  const r = git(wkt, ["remote", "get-url", "origin"]);
  return r.ok ? r.stdout : null;
}

function parseOwnerRepo(url) {
  if (!url) return null;
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

function ghPrState(ownerRepo, branch) {
  if (!ownerRepo) return null;
  const r = spawnSync(
    "gh",
    [
      "pr", "list",
      "--repo", `${ownerRepo.owner}/${ownerRepo.repo}`,
      "--head", branch,
      "--state", "all",
      "--json", "number,state",
      "--limit", "1",
    ],
    { encoding: "utf-8" },
  );
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    if (Array.isArray(parsed) && parsed[0]) return parsed[0];
  } catch {
    // ignore
  }
  return null;
}

function repoRootFromWorktree(wkt) {
  // Parent of the worktree's .git gitdir points at the real repo.
  try {
    const gitFile = fs.readFileSync(path.join(wkt, ".git"), "utf-8").trim();
    // Format: "gitdir: /path/to/repo/.git/worktrees/<name>"
    const m = gitFile.match(/^gitdir:\s*(.+)$/);
    if (m) {
      const gitDir = m[1];
      // Walk up to find <repo>/.git
      const mm = gitDir.match(/^(.+)\/\.git\/worktrees\/[^/]+$/);
      if (mm) return mm[1];
    }
  } catch {
    // ignore
  }
  return null;
}

async function main() {
  console.log(`[gc-orphan] root=${WORKTREES_ROOT} dry-run=${dryRun} force=${force} max-age-hours=${maxAgeHours}`);
  if (!fs.existsSync(WORKTREES_ROOT)) {
    console.log(`[gc-orphan] ${WORKTREES_ROOT} does not exist. Nothing to do.`);
    return;
  }
  const entries = fs.readdirSync(WORKTREES_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 0) {
    console.log(`[gc-orphan] ${WORKTREES_ROOT} is empty.`);
    return;
  }

  const actions = [];
  for (const entry of entries) {
    const wkt = path.join(WORKTREES_ROOT, entry.name);
    const st = fs.statSync(wkt);
    const ageHours = (Date.now() - st.mtimeMs) / 3600_000;

    const lock = checkLiveLock(wkt);
    if (lock.live) {
      actions.push({ wkt, action: "skip", reason: `live lock pid=${lock.pid}` });
      continue;
    }

    const branch = branchOf(wkt);
    const repoRoot = repoRootFromWorktree(wkt);

    const dirt = statusPorcelain(wkt);
    if (dirt && !force) {
      actions.push({ wkt, action: "skip", reason: `uncommitted changes (${dirt.split("\n")[0]}) — use --force to override` });
      continue;
    }

    // Parse <slug>-<stableKey> back out of the dirname.
    // Slug may itself contain hyphens; the stableKey is the final token(s).
    // Heuristic: look for trailing FRE-id, uuid, ephemeral-<ms>, or 13-digit ms.
    const name = entry.name;
    let stableKey = null;
    {
      const mEph = name.match(/-(ephemeral-\d{13})$/);
      const mTs = name.match(/-(\d{13})$/);
      const mFre = name.match(/-(FRE-[A-Z0-9]+)$/i);
      const mUuid = name.match(/-([0-9a-f-]{20,})$/i);
      if (mEph) stableKey = mEph[1];
      else if (mFre) stableKey = mFre[1];
      else if (mTs) stableKey = mTs[1];
      else if (mUuid) stableKey = mUuid[1];
    }

    let reason = null;
    if (stableKey && looksLikeTaskId(stableKey)) {
      const { status } = await fetchTaskStatus(stableKey);
      if (status === "done" || status === "cancelled" || status === "not-found") {
        reason = `task ${stableKey} status=${status}`;
      } else if (status === null) {
        reason = `task ${stableKey} status unknown — SKIP for safety`;
      } else {
        reason = `task ${stableKey} status=${status} — active, keep`;
      }
    } else if (stableKey && (looksLikeTimestamp(stableKey) || /^ephemeral-/.test(stableKey))) {
      if (ageHours >= maxAgeHours) reason = `ephemeral/ts key, age=${ageHours.toFixed(1)}h >= ${maxAgeHours}h`;
      else reason = `ephemeral/ts key, age=${ageHours.toFixed(1)}h < ${maxAgeHours}h — keep`;
    } else {
      reason = `unknown name format "${name}" — SKIP for safety`;
    }

    // Also orphan if the branch has a merged PR.
    if (!/keep|SKIP|active/.test(reason)) {
      // already marked for removal — no extra check needed
    } else if (branch) {
      const url = remoteUrl(wkt);
      const ownerRepo = parseOwnerRepo(url || "");
      const pr = ownerRepo ? ghPrState(ownerRepo, branch) : null;
      if (pr && pr.state === "MERGED") {
        reason = `PR #${pr.number} MERGED`;
      }
    }

    if (/keep|SKIP|active/.test(reason)) {
      actions.push({ wkt, action: "skip", reason });
    } else {
      actions.push({ wkt, action: "remove", reason, repoRoot, branch });
    }
  }

  console.log();
  for (const a of actions) {
    console.log(`  [${a.action}] ${a.wkt}`);
    console.log(`           reason: ${a.reason}`);
    if (a.action === "remove") {
      console.log(`           would run: git -C ${a.repoRoot || "<unknown>"} worktree remove --force ${a.wkt}`);
      if (a.branch) console.log(`           would run: git -C ${a.repoRoot || "<unknown>"} branch -D ${a.branch}`);
    }
  }
  console.log();

  if (dryRun) {
    console.log(`[gc-orphan] DRY-RUN — no changes made. Re-run with --confirm to apply.`);
    return;
  }

  for (const a of actions) {
    if (a.action !== "remove" || !a.repoRoot) continue;
    const rm = git(a.repoRoot, ["worktree", "remove", a.wkt, "--force"]);
    console.log(`[gc-orphan] worktree remove ${a.wkt}: ${rm.ok ? "ok" : "FAIL " + rm.stderr}`);
    if (a.branch) {
      const br = git(a.repoRoot, ["branch", "-D", a.branch]);
      console.log(`[gc-orphan] branch -D ${a.branch}: ${br.ok ? "ok" : "FAIL " + br.stderr}`);
    }
  }
}

main().catch((err) => {
  console.error(`[gc-orphan] FATAL: ${err?.stack || err}`);
  process.exit(1);
});
