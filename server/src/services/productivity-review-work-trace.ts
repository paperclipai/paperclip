import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  issueAttachments,
  issueDocuments,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

const execFileAsync = promisify(execFile);

export const WORK_TRACE_MAX_COMMITS = 5;
export const WORK_TRACE_MAX_ARTIFACTS = 5;
export const WORK_TRACE_GIT_TIMEOUT_MS = 10_000;
const WORK_TRACE_MAX_REPO_PATHS = 3;
const GIT_FIELD_SEPARATOR = "\u001f";

export type WorkTraceCommit = {
  sha: string;
  subject: string;
  committedAt: string;
  repoPath: string;
};

export type WorkTraceArtifact = {
  kind: "work_product" | "attachment" | "issue_document";
  id: string;
  label: string;
  createdAt: Date;
};

export type IssueWorkTrace = {
  since: Date;
  commits: WorkTraceCommit[];
  artifacts: WorkTraceArtifact[];
  repoPathsChecked: string[];
  repoLookupErrors: string[];
  grepPattern: string | null;
};

export type WorkTraceIssue = {
  id: string;
  companyId: string;
  identifier: string | null;
  executionWorkspaceId: string | null;
  startedAt: Date | null;
  executionLockedAt: Date | null;
  createdAt: Date;
};

/**
 * The moment the issue entered `in_progress`. Work that lands after this point is what the
 * counter-check looks for, so a run that dies after committing is not mistaken for a stall.
 */
export function resolveWorkTraceSince(issue: Pick<WorkTraceIssue, "startedAt" | "executionLockedAt" | "createdAt">) {
  return issue.startedAt ?? issue.executionLockedAt ?? issue.createdAt;
}

/**
 * Turn `AUR-1370` into a git `--grep` pattern that also matches the compact `aur1370` /
 * `aur_1370` / `aur 1370` spellings agents use in commit subjects, without matching `AUR-13700`.
 * Returns null when the identifier is not a plain `PREFIX-NUMBER`, so nothing unvalidated ever
 * reaches the regex engine.
 */
export function buildCommitGrepPattern(identifier: string | null | undefined) {
  const match = /^([A-Za-z][A-Za-z0-9]{0,15})-(\d{1,9})$/.exec(identifier?.trim() ?? "");
  if (!match) return null;
  const [, prefix, number] = match;
  return `${prefix}[-_ ]?${number}([^0-9]|$)`;
}

async function pathIsDirectory(value: string) {
  try {
    const stat = await fs.stat(value);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Repos that could carry the issue's commits, most specific first: the workspace bound to the
 * issue, then the assignee's default agent workspace (issues that never opened an execution
 * workspace still commit there — that is exactly the AUR-1370 shape).
 */
export async function resolveIssueRepoPaths(
  db: Db,
  input: {
    issue: WorkTraceIssue;
    agentId: string;
    resolveAgentWorkspaceDir?: (agentId: string) => string | null;
  },
): Promise<{ paths: string[]; errors: string[] }> {
  const candidates: string[] = [];
  const errors: string[] = [];

  const workspaceRows = await db
    .select({ cwd: executionWorkspaces.cwd, providerRef: executionWorkspaces.providerRef })
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.companyId, input.issue.companyId),
        input.issue.executionWorkspaceId
          ? or(
            eq(executionWorkspaces.id, input.issue.executionWorkspaceId),
            eq(executionWorkspaces.sourceIssueId, input.issue.id),
          )
          : eq(executionWorkspaces.sourceIssueId, input.issue.id),
      ),
    )
    .orderBy(desc(executionWorkspaces.lastUsedAt))
    .limit(WORK_TRACE_MAX_REPO_PATHS);
  for (const row of workspaceRows) {
    const candidate = row.cwd?.trim() || row.providerRef?.trim() || null;
    if (candidate) candidates.push(path.resolve(candidate));
  }

  const resolveAgentWorkspaceDir = input.resolveAgentWorkspaceDir ?? resolveDefaultAgentWorkspaceDir;
  try {
    const agentWorkspaceDir = resolveAgentWorkspaceDir(input.agentId);
    if (agentWorkspaceDir) candidates.push(path.resolve(agentWorkspaceDir));
  } catch (err) {
    errors.push(`agent workspace path unavailable: ${(err as Error).message}`);
  }

  const paths: string[] = [];
  for (const candidate of candidates) {
    if (paths.includes(candidate)) continue;
    if (!(await pathIsDirectory(candidate))) continue;
    paths.push(candidate);
    if (paths.length >= WORK_TRACE_MAX_REPO_PATHS) break;
  }
  return { paths, errors };
}

/**
 * Commits in `repoPath` (any ref) whose message carries the issue key and whose commit date is at
 * or after `since`. Best effort: a missing/broken repo yields an error string, never a throw.
 */
export async function readCommitTrace(input: {
  repoPath: string;
  grepPattern: string;
  since: Date;
  limit?: number;
}): Promise<{ commits: WorkTraceCommit[]; error: string | null }> {
  const args = [
    "-C",
    input.repoPath,
    "log",
    "--all",
    "--regexp-ignore-case",
    "--extended-regexp",
    `--grep=${input.grepPattern}`,
    `--since=${input.since.toISOString()}`,
    `--max-count=${input.limit ?? WORK_TRACE_MAX_COMMITS}`,
    `--format=%H${GIT_FIELD_SEPARATOR}%cI${GIT_FIELD_SEPARATOR}%s`,
  ];
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: input.repoPath,
      timeout: WORK_TRACE_GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    const commits: WorkTraceCommit[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [sha, committedAt, ...subjectParts] = trimmed.split(GIT_FIELD_SEPARATOR);
      if (!sha || !committedAt) continue;
      commits.push({
        sha,
        committedAt,
        subject: subjectParts.join(GIT_FIELD_SEPARATOR),
        repoPath: input.repoPath,
      });
    }
    return { commits, error: null };
  } catch (err) {
    return { commits: [], error: `${input.repoPath}: ${(err as Error).message.split("\n")[0]}` };
  }
}

async function readArtifactTrace(db: Db, input: { issue: WorkTraceIssue; since: Date }) {
  const { issue, since } = input;
  const [workProducts, attachments, documents] = await Promise.all([
    db
      .select({ id: issueWorkProducts.id, title: issueWorkProducts.title, type: issueWorkProducts.type, createdAt: issueWorkProducts.createdAt })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, issue.companyId),
        eq(issueWorkProducts.issueId, issue.id),
        gte(issueWorkProducts.createdAt, since),
      ))
      .orderBy(desc(issueWorkProducts.createdAt))
      .limit(WORK_TRACE_MAX_ARTIFACTS),
    db
      .select({ id: issueAttachments.id, createdAt: issueAttachments.createdAt })
      .from(issueAttachments)
      .where(and(
        eq(issueAttachments.companyId, issue.companyId),
        eq(issueAttachments.issueId, issue.id),
        gte(issueAttachments.createdAt, since),
      ))
      .orderBy(desc(issueAttachments.createdAt))
      .limit(WORK_TRACE_MAX_ARTIFACTS),
    db
      .select({ id: issueDocuments.id, key: issueDocuments.key, createdAt: issueDocuments.createdAt, updatedAt: issueDocuments.updatedAt })
      .from(issueDocuments)
      .where(and(
        eq(issueDocuments.companyId, issue.companyId),
        eq(issueDocuments.issueId, issue.id),
        sql`greatest(${issueDocuments.createdAt}, ${issueDocuments.updatedAt}) >= ${since.toISOString()}::timestamptz`,
      ))
      .orderBy(desc(issueDocuments.updatedAt))
      .limit(WORK_TRACE_MAX_ARTIFACTS),
  ]);

  const artifacts: WorkTraceArtifact[] = [
    ...workProducts.map((row) => ({
      kind: "work_product" as const,
      id: row.id,
      label: `${row.type}: ${row.title}`,
      createdAt: row.createdAt,
    })),
    ...attachments.map((row) => ({
      kind: "attachment" as const,
      id: row.id,
      label: "issue attachment",
      createdAt: row.createdAt,
    })),
    ...documents.map((row) => ({
      kind: "issue_document" as const,
      id: row.id,
      label: `document \`${row.key}\``,
      createdAt: row.updatedAt ?? row.createdAt,
    })),
  ];
  artifacts.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  return artifacts.slice(0, WORK_TRACE_MAX_ARTIFACTS);
}

export function hasWorkTrace(trace: IssueWorkTrace | null | undefined) {
  return Boolean(trace && (trace.commits.length > 0 || trace.artifacts.length > 0));
}

/**
 * Counter-check run before a stall is reported: does demonstrable work exist since the issue went
 * `in_progress`, even though the assignee never commented? Commits carrying the issue key and
 * artifacts (work products, attachments, issue documents) both count.
 */
export async function collectIssueWorkTrace(
  db: Db,
  input: {
    issue: WorkTraceIssue;
    agentId: string;
    resolveAgentWorkspaceDir?: (agentId: string) => string | null;
  },
): Promise<IssueWorkTrace> {
  const since = resolveWorkTraceSince(input.issue);
  const grepPattern = buildCommitGrepPattern(input.issue.identifier);
  const trace: IssueWorkTrace = {
    since,
    commits: [],
    artifacts: await readArtifactTrace(db, { issue: input.issue, since }),
    repoPathsChecked: [],
    repoLookupErrors: [],
    grepPattern,
  };

  if (!grepPattern) return trace;

  const { paths, errors } = await resolveIssueRepoPaths(db, input);
  trace.repoPathsChecked = paths;
  trace.repoLookupErrors.push(...errors);
  for (const repoPath of paths) {
    const { commits, error } = await readCommitTrace({ repoPath, grepPattern, since });
    if (error) {
      trace.repoLookupErrors.push(error);
      logger.debug({ issueId: input.issue.id, repoPath, error }, "productivity review commit counter-check skipped a repo");
      continue;
    }
    for (const commit of commits) {
      if (trace.commits.some((existing) => existing.sha === commit.sha)) continue;
      trace.commits.push(commit);
    }
    if (trace.commits.length >= WORK_TRACE_MAX_COMMITS) break;
  }
  trace.commits = trace.commits.slice(0, WORK_TRACE_MAX_COMMITS);
  return trace;
}

export function toWorkTraceIssue(issue: typeof issues.$inferSelect): WorkTraceIssue {
  return {
    id: issue.id,
    companyId: issue.companyId,
    identifier: issue.identifier,
    executionWorkspaceId: issue.executionWorkspaceId,
    startedAt: issue.startedAt,
    executionLockedAt: issue.executionLockedAt,
    createdAt: issue.createdAt,
  };
}
