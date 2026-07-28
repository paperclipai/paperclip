import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, desc, eq, exists, gte, inArray, notInArray, or, sql } from "drizzle-orm";
import type { IssueWorkProductStatus } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
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
  /**
   * When this artifact reached the state that put it in the trace — its creation, or, for a work
   * product moved into a completion status during the episode, that transition.
   */
  recordedAt: Date;
  /**
   * Whether this artifact proves the deliverable is *finished*, as opposed to proving that
   * something was started. Only completion-shaped evidence may flip a stall into an
   * `unreported_completion`; see {@link WORK_PRODUCT_COMPLETION_STATUSES}.
   */
  countsAsCompletion: boolean;
};

/**
 * Work-product statuses an agent reaches only by declaring the artifact finished or handing it to
 * a reviewer. Everything else — `draft`, the default `active`, `failed`, `archived` — describes
 * work in flight, as do issue documents and raw attachments, which carry no status at all.
 *
 * The asymmetry is deliberate and is the whole safety argument of this counter-check. A genuinely
 * stalled agent's *first* act is typically a planning document or a draft: if those counted as
 * proof of completion, the stuck agent would be the one classified `unreported_completion` — the
 * review routed back to itself, reassign/decompose forbidden, continuation hold released — and the
 * stall would become unrecoverable. Counting only completion-shaped evidence means an ambiguous
 * case falls back to `stall`, i.e. to the manager-owned behaviour that existed before this check.
 * The counter-check can therefore only ever widen the evidence base, never weaken the protection.
 */
export const WORK_PRODUCT_COMPLETION_STATUSES: readonly IssueWorkProductStatus[] = [
  "ready_for_review",
  "approved",
  "merged",
];

const WORK_PRODUCT_COMPLETION_STATUS_SET = new Set<string>(WORK_PRODUCT_COMPLETION_STATUSES);

export function workProductCountsAsCompletion(status: string | null | undefined) {
  return WORK_PRODUCT_COMPLETION_STATUS_SET.has((status ?? "").trim());
}

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
 * `aur_1370` / `aur 1370` spellings agents use in commit subjects.
 *
 * The key is bounded on *both* sides: the trailing `([^0-9]|$)` keeps `AUR-13700` out, and the
 * leading `(^|[^0-9A-Za-z])` keeps a longer identifier that merely ends in the key out — a
 * neighbouring company's `BAUR-1370` must not be read as evidence for `AUR-1370`. The leading
 * alternative also covers a key at the start of a continuation line, because `\n` is itself a
 * non-alphanumeric character.
 *
 * Returns null when the identifier is not a plain `PREFIX-NUMBER`, so nothing unvalidated ever
 * reaches the regex engine.
 */
export function buildCommitGrepPattern(identifier: string | null | undefined) {
  const match = /^([A-Za-z][A-Za-z0-9]{0,15})-(\d{1,9})$/.exec(identifier?.trim() ?? "");
  if (!match) return null;
  const [, prefix, number] = match;
  return `(^|[^0-9A-Za-z])${prefix}[-_ ]?${number}([^0-9]|$)`;
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

export const WORK_PRODUCT_UPDATE_ACTION = "issue.work_product_updated";

/**
 * Condition matching a work product that **entered** a completion status on this issue during the
 * episode, read from the activity row that every work-product update writes.
 *
 * Three things are required, and each rules out a specific way of being wrong:
 *
 * - `changedKeys` contains `status` — `updatedAt` cannot stand in for this. It advances on any
 *   write (a title correction, a health-status refresh), so a product merged in an earlier episode
 *   and merely touched in this one would look exactly like a completion that just happened.
 * - the recorded resulting `status` is a completion status — otherwise a status change *away* from
 *   completion would count.
 * - the recorded `previousStatus` is **not** a completion status — otherwise a refinement between
 *   two completion states (`ready_for_review` → `approved`) on work finished long before the
 *   episode would read as a completion inside it, and stale evidence would disarm stall recovery
 *   for a genuinely stuck agent.
 *
 * Rows written before those details existed simply fail the predicate, so the fallback is `stall`,
 * i.e. the manager-owned behaviour that existed before the counter-check.
 *
 * Expressed as a correlated `exists` rather than a pre-fetched id list on purpose: any cap on that
 * list would silently drop an older transition once enough later status changes existed on the
 * issue, which is the same false stall this branch is here to prevent. The outer query is already
 * bounded, so nothing here is unbounded in the result.
 */
function enteredCompletionDuringEpisode(db: Db, input: { issue: WorkTraceIssue; since: Date }) {
  const completionStatuses = [...WORK_PRODUCT_COMPLETION_STATUSES];
  return exists(
    db
      .select({ present: sql`1` })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.issue.companyId),
        eq(activityLog.action, WORK_PRODUCT_UPDATE_ACTION),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issue.id),
        gte(activityLog.createdAt, input.since),
        sql`jsonb_exists(${activityLog.details}->'changedKeys', 'status')`,
        sql`${activityLog.details}->>'workProductId' = ${issueWorkProducts.id}::text`,
        inArray(sql`${activityLog.details}->>'status'`, completionStatuses),
        // A missing `previousStatus` makes this NULL, so the row is filtered out — an audit entry
        // that cannot prove the product was incomplete before does not count as evidence.
        notInArray(sql`${activityLog.details}->>'previousStatus'`, completionStatuses),
      )),
  );
}

async function readArtifactTrace(db: Db, input: { issue: WorkTraceIssue; since: Date }) {
  const { issue, since } = input;
  const [workProducts, attachments, documents] = await Promise.all([
    db
      .select({
        id: issueWorkProducts.id,
        title: issueWorkProducts.title,
        type: issueWorkProducts.type,
        status: issueWorkProducts.status,
        createdAt: issueWorkProducts.createdAt,
        updatedAt: issueWorkProducts.updatedAt,
      })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, issue.companyId),
        eq(issueWorkProducts.issueId, issue.id),
        or(
          gte(issueWorkProducts.createdAt, since),
          // A product created in an earlier episode and only *moved into* a completion status
          // during this one is the same evidence as one created here — the completion is what
          // matters, not the creation. Filtering on `createdAt` alone made that transition
          // invisible and routed finished work back through the destructive stall path.
          and(
            inArray(issueWorkProducts.status, [...WORK_PRODUCT_COMPLETION_STATUSES]),
            enteredCompletionDuringEpisode(db, input),
          ),
        ),
      ))
      // Completion status first, *in SQL*: the row limit is applied by the database, so sorting
      // only in memory would let five newer drafts push the one completed product out of the
      // result set — and with it the evidence the classification turns on.
      .orderBy(
        sql`case when ${inArray(issueWorkProducts.status, [...WORK_PRODUCT_COMPLETION_STATUSES])} then 0 else 1 end`,
        sql`greatest(${issueWorkProducts.createdAt}, ${issueWorkProducts.updatedAt}) desc`,
      )
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

  const mostRecent = (createdAt: Date, updatedAt: Date | null | undefined) =>
    updatedAt && updatedAt.getTime() > createdAt.getTime() ? updatedAt : createdAt;

  const artifacts: WorkTraceArtifact[] = [
    ...workProducts.map((row) => ({
      kind: "work_product" as const,
      id: row.id,
      label: `${row.type} (${row.status}): ${row.title}`,
      // The completion transition, not the creation, is what made this evidence.
      recordedAt: mostRecent(row.createdAt, row.updatedAt),
      countsAsCompletion: workProductCountsAsCompletion(row.status),
    })),
    // An attachment is a raw upload — a screenshot, a log, an interim export. It says work
    // happened, never that it finished.
    ...attachments.map((row) => ({
      kind: "attachment" as const,
      id: row.id,
      label: "issue attachment",
      recordedAt: row.createdAt,
      countsAsCompletion: false,
    })),
    // Issue documents are plans, notes and continuation summaries. A stalled run writes one
    // *before* it does the work, so a document is the weakest possible completion signal.
    ...documents.map((row) => ({
      kind: "issue_document" as const,
      id: row.id,
      label: `document \`${row.key}\``,
      recordedAt: mostRecent(row.createdAt, row.updatedAt),
      countsAsCompletion: false,
    })),
  ];
  const byNewestFirst = (left: WorkTraceArtifact, right: WorkTraceArtifact) =>
    right.recordedAt.getTime() - left.recordedAt.getTime();
  // Completion evidence is what the classification turns on, so it must never be pushed out of the
  // capped list by a burst of newer planning documents.
  return [
    ...artifacts.filter((artifact) => artifact.countsAsCompletion).sort(byNewestFirst),
    ...artifacts.filter((artifact) => !artifact.countsAsCompletion).sort(byNewestFirst),
  ].slice(0, WORK_TRACE_MAX_ARTIFACTS);
}

export function completionArtifacts(trace: IssueWorkTrace | null | undefined) {
  return trace?.artifacts.filter((artifact) => artifact.countsAsCompletion) ?? [];
}

export function progressOnlyArtifacts(trace: IssueWorkTrace | null | undefined) {
  return trace?.artifacts.filter((artifact) => !artifact.countsAsCompletion) ?? [];
}

/**
 * True only when the trace proves the deliverable is *done*: a commit carrying the issue key, or a
 * work product the assignee itself moved into a completion status. Progress-only artifacts are
 * still reported, but they leave the classification at `stall`.
 */
export function hasCompletionEvidence(trace: IssueWorkTrace | null | undefined) {
  return Boolean(trace && (trace.commits.length > 0 || completionArtifacts(trace).length > 0));
}

/**
 * Counter-check run before a stall is reported: does demonstrable work exist since the issue went
 * `in_progress`, even though the assignee never commented? Commits carrying the issue key and
 * artifacts (work products, attachments, issue documents) are all collected; which of them counts
 * as proof of *completion* is decided by {@link hasCompletionEvidence}.
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
