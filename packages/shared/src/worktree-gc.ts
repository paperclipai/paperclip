import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const DEFAULT_WORKTREE_GC_HOME = "~/.paperclip-worktrees";
export const WORKTREE_NAME_PREFIX = "paperclip-";
export const DEFAULT_WORKTREE_GC_MIN_AGE_MS = 60 * 60 * 1000;

export type WorktreeGcLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
};

export type StaleWorktreeReason = "branch_missing";

export type StaleWorktreeCandidate = {
  instanceId: string;
  instanceRoot: string;
  candidateBranchNames: string[];
  worktreeCheckoutPath: string | null;
  reason: StaleWorktreeReason;
  ageMs: number;
};

export type WorktreeGcOptions = {
  repoCwd: string;
  homeDir?: string;
  minAgeMs?: number;
  now?: Date;
  logger?: WorktreeGcLogger;
};

export type WorktreeGcRunOptions = WorktreeGcOptions & {
  dryRun?: boolean;
  force?: boolean;
};

export type WorktreeGcRunResult = {
  scanned: number;
  pruned: string[];
  skipped: { instanceId: string; reason: string }[];
  errors: { instanceId: string; error: string }[];
};

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

function resolveHomeDir(homeDir: string | undefined): string {
  return path.resolve(expandHome(homeDir ?? DEFAULT_WORKTREE_GC_HOME));
}

function listInstanceDirectories(homeDir: string): string[] {
  const instancesDir = path.resolve(homeDir, "instances");
  if (!fs.existsSync(instancesDir)) return [];
  try {
    return fs
      .readdirSync(instancesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function instanceCandidateBranchNames(instanceId: string): string[] {
  const candidates = new Set<string>();
  candidates.add(instanceId);
  if (!instanceId.startsWith(WORKTREE_NAME_PREFIX)) {
    candidates.add(`${WORKTREE_NAME_PREFIX}${instanceId}`);
  } else {
    candidates.add(instanceId.slice(WORKTREE_NAME_PREFIX.length));
  }
  return [...candidates].filter((value) => value.length > 0);
}

function gitOutput(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function listLocalAndRemoteBranchTips(repoCwd: string): Set<string> | null {
  const out = gitOutput(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
    repoCwd,
  );
  if (out === null) return null;
  const refs = new Set<string>();
  for (const rawLine of out.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === "HEAD" || line.endsWith("/HEAD")) continue;
    refs.add(line);
    const slashIndex = line.indexOf("/");
    if (slashIndex > 0) {
      const withoutRemote = line.slice(slashIndex + 1);
      if (withoutRemote.length > 0) refs.add(withoutRemote);
    }
  }
  return refs;
}

function pickWorktreeCheckoutPath(candidateBranchNames: string[]): string | null {
  const home = os.homedir();
  for (const candidate of candidateBranchNames) {
    const guess = path.resolve(home, candidate);
    if (fs.existsSync(guess) && fs.statSync(guess).isDirectory()) {
      return guess;
    }
  }
  return null;
}

function instanceMtimeMs(instanceRoot: string): number {
  try {
    return fs.statSync(instanceRoot).mtimeMs;
  } catch {
    return Date.now();
  }
}

function postmasterAlive(instanceRoot: string): boolean {
  const pidFile = path.resolve(instanceRoot, "db", "postmaster.pid");
  if (!fs.existsSync(pidFile)) return false;
  try {
    const lines = fs.readFileSync(pidFile, "utf8").split(/\r?\n/);
    const pid = Number.parseInt(lines[0]?.trim() ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM") return true;
      return false;
    }
  } catch {
    return false;
  }
}

function checkoutHasUncommittedChanges(checkoutPath: string): boolean {
  const out = gitOutput(["status", "--porcelain"], checkoutPath);
  if (out === null) return false;
  return out.trim().length > 0;
}

export function findStaleWorktreeInstances(opts: WorktreeGcOptions): StaleWorktreeCandidate[] {
  const homeDir = resolveHomeDir(opts.homeDir);
  const instanceIds = listInstanceDirectories(homeDir);
  if (instanceIds.length === 0) return [];

  const minAgeMs = opts.minAgeMs ?? DEFAULT_WORKTREE_GC_MIN_AGE_MS;
  const nowMs = (opts.now ?? new Date()).getTime();
  const liveBranches = listLocalAndRemoteBranchTips(opts.repoCwd);
  if (liveBranches === null) {
    opts.logger?.warn?.("worktree gc skipped: git ref enumeration unavailable", {
      repoCwd: opts.repoCwd,
    });
    return [];
  }

  const candidates: StaleWorktreeCandidate[] = [];

  for (const instanceId of instanceIds) {
    const instanceRoot = path.resolve(homeDir, "instances", instanceId);
    const ageMs = nowMs - instanceMtimeMs(instanceRoot);
    if (ageMs < minAgeMs) continue;

    const candidateBranchNames = instanceCandidateBranchNames(instanceId);
    const hasLiveBranch = candidateBranchNames.some((name) => liveBranches.has(name));
    if (hasLiveBranch) continue;

    const worktreeCheckoutPath = pickWorktreeCheckoutPath(candidateBranchNames);

    candidates.push({
      instanceId,
      instanceRoot,
      candidateBranchNames,
      worktreeCheckoutPath,
      reason: "branch_missing",
      ageMs,
    });
  }

  return candidates;
}

export function pruneStaleWorktreeInstance(
  candidate: StaleWorktreeCandidate,
  opts: { repoCwd: string; force?: boolean; logger?: WorktreeGcLogger; dryRun?: boolean },
): { pruned: boolean; skipped?: string; error?: string } {
  const logger = opts.logger;
  const dryRun = opts.dryRun === true;

  if (postmasterAlive(candidate.instanceRoot)) {
    return { pruned: false, skipped: "postmaster_alive" };
  }

  if (
    candidate.worktreeCheckoutPath !== null &&
    fs.existsSync(candidate.worktreeCheckoutPath) &&
    !opts.force &&
    checkoutHasUncommittedChanges(candidate.worktreeCheckoutPath)
  ) {
    return { pruned: false, skipped: "uncommitted_changes_in_checkout" };
  }

  if (dryRun) {
    logger?.info?.("worktree gc would prune (dry-run)", {
      instanceId: candidate.instanceId,
      instanceRoot: candidate.instanceRoot,
      worktreeCheckoutPath: candidate.worktreeCheckoutPath,
      reason: candidate.reason,
    });
    return { pruned: true };
  }

  if (candidate.worktreeCheckoutPath && fs.existsSync(candidate.worktreeCheckoutPath)) {
    try {
      const args = ["worktree", "remove", candidate.worktreeCheckoutPath];
      if (opts.force) args.push("--force");
      execFileSync("git", args, { cwd: opts.repoCwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      logger?.warn?.("git worktree remove failed; will fall back to filesystem cleanup", {
        instanceId: candidate.instanceId,
        worktreeCheckoutPath: candidate.worktreeCheckoutPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd: opts.repoCwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Pruning broken refs is best-effort.
  }

  if (candidate.worktreeCheckoutPath && fs.existsSync(candidate.worktreeCheckoutPath)) {
    try {
      fs.rmSync(candidate.worktreeCheckoutPath, { recursive: true, force: true });
    } catch (err) {
      return {
        pruned: false,
        error: `failed to remove worktree checkout: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  try {
    fs.rmSync(candidate.instanceRoot, { recursive: true, force: true });
  } catch (err) {
    return {
      pruned: false,
      error: `failed to remove instance root: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  logger?.info?.("worktree gc pruned stale instance", {
    instanceId: candidate.instanceId,
    instanceRoot: candidate.instanceRoot,
    worktreeCheckoutPath: candidate.worktreeCheckoutPath,
    reason: candidate.reason,
  });

  return { pruned: true };
}

export function runWorktreeGc(opts: WorktreeGcRunOptions): WorktreeGcRunResult {
  const candidates = findStaleWorktreeInstances(opts);
  const result: WorktreeGcRunResult = {
    scanned: candidates.length,
    pruned: [],
    skipped: [],
    errors: [],
  };

  for (const candidate of candidates) {
    const outcome = pruneStaleWorktreeInstance(candidate, {
      repoCwd: opts.repoCwd,
      force: opts.force,
      logger: opts.logger,
      dryRun: opts.dryRun,
    });
    if (outcome.pruned) {
      result.pruned.push(candidate.instanceId);
    } else if (outcome.skipped) {
      result.skipped.push({ instanceId: candidate.instanceId, reason: outcome.skipped });
    } else if (outcome.error) {
      result.errors.push({ instanceId: candidate.instanceId, error: outcome.error });
    }
  }

  return result;
}
