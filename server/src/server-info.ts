import { execFileSync } from "node:child_process";
import type { ServerGitInfo, ServerInfoSnapshot } from "@paperclipai/shared";

export type { ServerGitInfo, ServerInfoSnapshot };

type GitCommand = () => string;

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const SHORT_SHA_RE = /^[0-9a-f]{7,40}$/i;

function defaultGitCommand() {
  return execFileSync(
    "git",
    ["show", "-s", "--format=%H%n%h%n%s%n%cI", "HEAD"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    },
  );
}

function readGitInfo(gitCommand: GitCommand = defaultGitCommand): ServerGitInfo {
  try {
    return parseGitInfo(gitCommand());
  } catch {
    return { available: false, unavailableReason: "git_unavailable" };
  }
}

function parseGitInfo(output: string): ServerGitInfo {
  const [fullSha = "", shortSha = "", subject = "", committedAt = ""] = output
    .trimEnd()
    .split("\n");
  const committedAtTime = Date.parse(committedAt);

  if (!FULL_SHA_RE.test(fullSha) || !SHORT_SHA_RE.test(shortSha)) {
    return { available: false, unavailableReason: "invalid_git_metadata" };
  }

  return {
    available: true,
    fullSha,
    shortSha,
    subject: subject.trim() || "No commit subject",
    committedAt: Number.isNaN(committedAtTime) ? null : new Date(committedAtTime).toISOString(),
  };
}

export function createServerInfoSnapshot(
  opts: { now?: Date; gitCommand?: GitCommand } = {},
): ServerInfoSnapshot {
  return {
    processStartedAt: (opts.now ?? new Date()).toISOString(),
    git: readGitInfo(opts.gitCommand),
  };
}

// processStartedAt is a true boot constant, but the running commit can change
// without the Node process restarting: a managed dev-server restart re-runs the
// code while keeping this module alive, so a commit captured once at boot goes
// stale. Re-read git HEAD on demand, throttled by a short TTL so frequent health
// polls don't spawn git on every request.
const GIT_INFO_CACHE_TTL_MS = 3000;
const processStartedAt = new Date().toISOString();
let gitInfoCache: { value: ServerGitInfo; expiresAt: number } | null = null;

export function getServerInfoSnapshot(
  opts: { now?: number; gitCommand?: GitCommand } = {},
): ServerInfoSnapshot {
  const now = opts.now ?? Date.now();
  if (!gitInfoCache || now >= gitInfoCache.expiresAt) {
    gitInfoCache = {
      value: readGitInfo(opts.gitCommand),
      expiresAt: now + GIT_INFO_CACHE_TTL_MS,
    };
  }
  return { processStartedAt, git: gitInfoCache.value };
}

export function resetServerInfoCacheForTests(): void {
  gitInfoCache = null;
}
