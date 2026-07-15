import { execFileSync } from "node:child_process";
import type { ServerGitInfo, ServerGitLocalChanges, ServerInfoSnapshot } from "@paperclipai/shared";
import { parseBuildCommit, readBuildCommit } from "./build-commit.js";

export type { ServerGitInfo, ServerInfoSnapshot };

type GitCommand = () => string;
type BuildCommitCommand = () => string | null;

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

function defaultGitStatusCommand() {
  return execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    },
  );
}

function defaultGitBranchCommand() {
  return execFileSync(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    },
  );
}

function parseGitLocalChanges(output: string): ServerGitLocalChanges {
  let stagedFileCount = 0;
  let unstagedFileCount = 0;
  let untrackedFileCount = 0;

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";

    if (indexStatus === "?" && worktreeStatus === "?") {
      untrackedFileCount += 1;
      continue;
    }
    if (indexStatus !== " " && indexStatus !== "?") stagedFileCount += 1;
    if (worktreeStatus !== " " && worktreeStatus !== "?") unstagedFileCount += 1;
  }

  return {
    available: true,
    hasLocalChanges: stagedFileCount + unstagedFileCount + untrackedFileCount > 0,
    stagedFileCount,
    unstagedFileCount,
    untrackedFileCount,
  };
}

function getGitLocalChanges(gitStatusCommand: GitCommand): ServerGitLocalChanges {
  try {
    return parseGitLocalChanges(gitStatusCommand());
  } catch {
    return { available: false, unavailableReason: "git_status_unavailable" };
  }
}

function parseGitInfo(
  output: string,
  branchName: string | null,
  localChanges: ServerGitLocalChanges,
): ServerGitInfo {
  const [fullSha = "", shortSha = "", subject = "", committedAt = ""] = output
    .trimEnd()
    .split("\n");
  const parsedFullSha = parseBuildCommit(fullSha);
  const committedAtTime = Date.parse(committedAt);

  if (!parsedFullSha || !SHORT_SHA_RE.test(shortSha)) {
    return { available: false, unavailableReason: "invalid_git_metadata" };
  }

  return {
    available: true,
    fullSha: parsedFullSha,
    shortSha,
    branchName,
    subject: subject.trim() || "No commit subject",
    committedAt: Number.isNaN(committedAtTime) ? null : new Date(committedAtTime).toISOString(),
    localChanges,
  };
}

function readGitInfo(
  gitCommand: GitCommand = defaultGitCommand,
  gitStatusCommand: GitCommand = defaultGitStatusCommand,
  gitBranchCommand: GitCommand = defaultGitBranchCommand,
  buildCommitCommand: BuildCommitCommand = readBuildCommit,
): ServerGitInfo {
  try {
    const output = gitCommand();
    const localChanges = getGitLocalChanges(gitStatusCommand);
    let branchName: string | null = null;
    try {
      branchName = gitBranchCommand().trim() || null;
    } catch {
      branchName = null;
    }
    return parseGitInfo(output, branchName, localChanges);
  } catch {
    const buildCommit = parseBuildCommit(buildCommitCommand());
    if (!buildCommit) {
      return { available: false, unavailableReason: "git_unavailable" };
    }

    return {
      available: true,
      fullSha: buildCommit,
      shortSha: buildCommit.slice(0, 7),
      branchName: null,
      subject: "Source build",
      committedAt: null,
      localChanges: {
        available: false,
        unavailableReason: "git_status_unavailable",
      },
    };
  }
}

export function createServerInfoSnapshot(
  opts: {
    now?: Date;
    gitCommand?: GitCommand;
    gitStatusCommand?: GitCommand;
    gitBranchCommand?: GitCommand;
    buildCommitCommand?: BuildCommitCommand;
  } = {},
): ServerInfoSnapshot {
  return {
    processStartedAt: (opts.now ?? new Date()).toISOString(),
    git: readGitInfo(
      opts.gitCommand,
      opts.gitStatusCommand,
      opts.gitBranchCommand,
      opts.buildCommitCommand,
    ),
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
  opts: {
    now?: number;
    gitCommand?: GitCommand;
    gitStatusCommand?: GitCommand;
    gitBranchCommand?: GitCommand;
    buildCommitCommand?: BuildCommitCommand;
  } = {},
): ServerInfoSnapshot {
  const now = opts.now ?? Date.now();
  if (!gitInfoCache || now >= gitInfoCache.expiresAt) {
    gitInfoCache = {
      value: readGitInfo(
        opts.gitCommand,
        opts.gitStatusCommand,
        opts.gitBranchCommand,
        opts.buildCommitCommand,
      ),
      expiresAt: now + GIT_INFO_CACHE_TTL_MS,
    };
  }
  return { processStartedAt, git: gitInfoCache.value };
}

export function resetServerInfoCacheForTests(): void {
  gitInfoCache = null;
}
