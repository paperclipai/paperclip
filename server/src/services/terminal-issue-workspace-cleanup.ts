import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logActivity } from "./activity-log.js";

const execFileAsync = promisify(execFile);
const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const WORKTREE_CONTAINER_NAME = /^(?:\.|\.[a-z0-9_-]+-|[a-z0-9_-]+-)?worktrees?$/i;
const SKIP_DURING_CONTAINER_DISCOVERY = new Set([
  ".git",
  ".next",
  ".turbo",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

export type TerminalIssueWorkspaceCleanupEntry = {
  path: string;
  source: "agent_workspace" | "nested_worktree_container";
  outcome: "removed" | "skipped" | "failed";
  method: "git_worktree_remove" | "remove_directory" | "none";
  reason?: string;
  error?: string;
};

export type TerminalIssueWorkspaceCleanupReport = {
  issueId: string | null;
  identifier: string;
  status: string;
  workspaceRoot: string;
  matched: number;
  removed: number;
  skipped: number;
  failed: number;
  entries: TerminalIssueWorkspaceCleanupEntry[];
};

type CleanupIssue = {
  id?: string | null;
  companyId: string;
  identifier?: string | null;
  issueNumber?: number | null;
  status: string;
};

type CleanupActor = {
  actorType?: "agent" | "user" | "system";
  actorId?: string | null;
  agentId?: string | null;
  runId?: string | null;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseIssueIdentity(input: Pick<CleanupIssue, "identifier" | "issueNumber">) {
  const identifier = input.identifier?.trim().toUpperCase() ?? "";
  const match = /^([A-Z][A-Z0-9_]*)-(\d+)$/.exec(identifier);
  if (!match) return null;
  const identifierIssueNumber = Number(match[2]);
  const issueNumber = input.issueNumber ?? identifierIssueNumber;
  if (
    !Number.isSafeInteger(identifierIssueNumber) ||
    identifierIssueNumber < 1 ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1 ||
    issueNumber !== identifierIssueNumber
  ) {
    return null;
  }
  return { identifier, prefix: match[1], issueNumber };
}

function containsTerminalIssueIdentity(
  name: string,
  input: Pick<CleanupIssue, "identifier" | "issueNumber">,
) {
  const identity = parseIssueIdentity(input);
  if (!identity) return false;
  const escapedPrefix = escapeRegExp(identity.prefix);
  const issueNumber = String(identity.issueNumber);
  return new RegExp(
    `(?:^|[-_])(?:(?:qa|pr|merge)[-_]?)?(?:${escapedPrefix}[-_]?)?${issueNumber}(?!\\d)(?:$|[-_.])`,
    "i",
  ).test(name);
}

/**
 * Match only workspace naming conventions. Numeric look-ahead is deliberate:
 * closing issue 123 must never select a workspace for issue 1234.
 */
export function matchesTerminalIssueWorkspaceName(
  name: string,
  input: Pick<CleanupIssue, "identifier" | "issueNumber">,
  options: {
    workspaceFamilies?: ReadonlySet<string>;
  } = {},
) {
  const identity = parseIssueIdentity(input);
  if (!identity) return false;
  const escapedPrefix = escapeRegExp(identity.prefix);
  const issueNumber = String(identity.issueNumber);
  const standaloneIdentifier = new RegExp(
    `^${escapedPrefix}[-_]?${issueNumber}(?!\\d)(?:[-_.].*)?$`,
    "i",
  );
  if (standaloneIdentifier.test(name)) return true;

  // QA, PR, and merge operators historically omitted the company prefix.
  const standaloneOperatorAlias = new RegExp(
    `^(?:qa|pr|merge)[-_]?(?:${escapedPrefix}[-_]?)?${issueNumber}(?!\\d)(?:[-_.].*)?$`,
    "i",
  );
  if (standaloneOperatorAlias.test(name)) return true;

  // A repository-prefixed direct child is eligible only when the prefix maps
  // to a real sibling checkout in the same agent workspace. Without that
  // context, names such as archive-LIV-321-old are ambiguous and must survive.
  const repositoryPrefixed = new RegExp(
    `^(.+?)[-_](?:(?:qa|pr|merge)[-_]?(?:${escapedPrefix}[-_]?)?|${escapedPrefix}[-_]?)${issueNumber}(?!\\d)(?:[-_.].*)?$`,
    "i",
  ).exec(name);
  if (!repositoryPrefixed) return false;
  return options.workspaceFamilies?.has(repositoryPrefixed[1].toLowerCase()) ?? false;
}

async function hasGitMetadata(targetPath: string) {
  try {
    const stat = await fs.lstat(path.join(targetPath, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

async function isDirectoryWithoutFollowingSymlinks(targetPath: string) {
  try {
    const stat = await fs.lstat(targetPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function discoverNestedWorktreeContainers(
  startPath: string,
  onContainer: (containerPath: string) => Promise<void>,
) {
  const queue = [startPath];
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor++];
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DURING_CONTAINER_DISCOVERY.has(entry.name)) continue;
      const entryPath = path.join(current, entry.name);
      if (WORKTREE_CONTAINER_NAME.test(entry.name)) {
        await onContainer(entryPath);
        continue;
      }
      queue.push(entryPath);
    }
  }
}

function parseGitWorktreePaths(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length).trim()));
}

async function canonicalPath(targetPath: string) {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

async function removeCandidate(
  workspaceRoot: string,
  candidatePath: string,
  source: TerminalIssueWorkspaceCleanupEntry["source"],
): Promise<TerminalIssueWorkspaceCleanupEntry> {
  const resolvedCandidate = path.resolve(candidatePath);
  if (!isPathInside(workspaceRoot, resolvedCandidate)) {
    return { path: resolvedCandidate, source, outcome: "skipped", method: "none", reason: "outside_workspace_root" };
  }
  if (!(await isDirectoryWithoutFollowingSymlinks(resolvedCandidate))) {
    return { path: resolvedCandidate, source, outcome: "skipped", method: "none", reason: "missing_or_not_plain_directory" };
  }

  let registeredPaths: string[] | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["-C", resolvedCandidate, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    registeredPaths = parseGitWorktreePaths(stdout);
  } catch {
    // Not a git checkout, or a directly-created scratch directory whose git
    // metadata is unavailable. Guarded directory removal below still applies.
  }

  if (registeredPaths) {
    const canonicalRegisteredPaths = await Promise.all(registeredPaths.map(canonicalPath));
    const candidateIndex = canonicalRegisteredPaths.indexOf(await canonicalPath(resolvedCandidate));
    if (candidateIndex > 0) {
      const mainWorktree = registeredPaths[0];
      try {
        await execFileAsync("git", ["-C", mainWorktree, "worktree", "remove", "--force", resolvedCandidate], {
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        });
        return { path: resolvedCandidate, source, outcome: "removed", method: "git_worktree_remove" };
      } catch (error) {
        return {
          path: resolvedCandidate,
          source,
          outcome: "failed",
          method: "git_worktree_remove",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (candidateIndex === 0 && registeredPaths.length > 1) {
      return {
        path: resolvedCandidate,
        source,
        outcome: "skipped",
        method: "none",
        reason: "primary_checkout_has_linked_worktrees",
      };
    }
  }

  try {
    await fs.rm(resolvedCandidate, { recursive: true, force: false });
    return { path: resolvedCandidate, source, outcome: "removed", method: "remove_directory" };
  } catch (error) {
    return {
      path: resolvedCandidate,
      source,
      outcome: "failed",
      method: "remove_directory",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function cleanupTerminalIssueWorkspaces(input: {
  issue: CleanupIssue;
  agentIds: string[];
  workspaceRoot?: string;
}): Promise<TerminalIssueWorkspaceCleanupReport> {
  const workspaceRoot = path.resolve(
    input.workspaceRoot ?? path.join(resolvePaperclipInstanceRoot(), "workspaces"),
  );
  const identity = parseIssueIdentity(input.issue);
  const report: TerminalIssueWorkspaceCleanupReport = {
    issueId: input.issue.id ?? null,
    identifier: identity?.identifier ?? input.issue.identifier?.trim().toUpperCase() ?? "unknown",
    status: input.issue.status,
    workspaceRoot,
    matched: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
    entries: [],
  };
  if (!TERMINAL_STATUSES.has(input.issue.status) || !identity) return report;

  const candidates = new Map<string, TerminalIssueWorkspaceCleanupEntry["source"]>();
  const inspectContainer = async (containerPath: string, workspaceFamilies: ReadonlySet<string>) => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(containerPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (!matchesTerminalIssueWorkspaceName(entry.name, input.issue, { workspaceFamilies })) continue;
      candidates.set(path.resolve(containerPath, entry.name), "nested_worktree_container");
    }
  };

  for (const agentId of [...new Set(input.agentIds)]) {
    const agentRoot = path.resolve(workspaceRoot, agentId);
    if (!isPathInside(workspaceRoot, agentRoot) || !(await isDirectoryWithoutFollowingSymlinks(agentRoot))) continue;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(agentRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    const workspaceFamilies = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const entryPath = path.join(agentRoot, entry.name);
      if (!(await hasGitMetadata(entryPath))) continue;
      // A repository family must be a stable sibling checkout, not a
      // candidate-shaped directory for the issue currently being cleaned.
      if (containsTerminalIssueIdentity(entry.name, input.issue)) continue;
      workspaceFamilies.add(entry.name.toLowerCase());
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const entryPath = path.join(agentRoot, entry.name);
      if (matchesTerminalIssueWorkspaceName(entry.name, input.issue, { workspaceFamilies })) {
        candidates.set(path.resolve(entryPath), "agent_workspace");
        continue;
      }
      if (!workspaceFamilies.has(entry.name.toLowerCase())) continue;
      await discoverNestedWorktreeContainers(
        entryPath,
        (containerPath) => inspectContainer(containerPath, workspaceFamilies),
      );
    }
  }

  for (const [candidatePath, source] of candidates) {
    const entry = await removeCandidate(workspaceRoot, candidatePath, source);
    report.entries.push(entry);
    report.matched += 1;
    report[entry.outcome] += 1;
  }

  const logContext = {
    issueId: report.issueId,
    identifier: report.identifier,
    status: report.status,
    workspaceRoot: report.workspaceRoot,
    matched: report.matched,
    removed: report.removed,
    skipped: report.skipped,
    failed: report.failed,
    entries: report.entries,
  };
  if (report.failed > 0) logger.warn(logContext, "terminal issue workspace cleanup completed with failures");
  else logger.info(logContext, "terminal issue workspace cleanup completed");
  return report;
}

export async function cleanupTerminalIssueWorkspacesForIssue(
  db: Db,
  issue: CleanupIssue,
  actor: CleanupActor = {},
) {
  if (!TERMINAL_STATUSES.has(issue.status) || !parseIssueIdentity(issue)) return null;
  let report: TerminalIssueWorkspaceCleanupReport;
  try {
    const agentIds = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.companyId, issue.companyId))
      .then((rows) => rows.map((row) => row.id));
    report = await cleanupTerminalIssueWorkspaces({ issue, agentIds });
  } catch (error) {
    logger.warn(
      { error, issueId: issue.id ?? null, identifier: issue.identifier ?? null },
      "terminal issue workspace cleanup failed before candidate processing",
    );
    return null;
  }

  try {
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType ?? "system",
      actorId: actor.actorId ?? "terminal_issue_workspace_cleanup",
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "issue.terminal_workspace_cleanup",
      entityType: "issue",
      entityId: issue.id ?? report.identifier,
      details: {
        identifier: report.identifier,
        status: report.status,
        matched: report.matched,
        removed: report.removed,
        skipped: report.skipped,
        failed: report.failed,
        entries: report.entries,
      },
    });
  } catch (error) {
    logger.warn(
      { error, issueId: issue.id ?? null, identifier: report.identifier },
      "failed to persist terminal issue workspace cleanup activity",
    );
  }
  return report;
}
