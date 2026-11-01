// Cold-wake briefing assembler — step-by-step in service of the parent
// initiative: when an agent has been hibernated past a threshold and is woken
// onto an active issue, the harness prepends a "what changed under you"
// briefing into the wake payload so the agent does not start work blind.
//
// This file holds the focused, adjacent assembler that the heartbeat service
// calls right after `buildPaperclipWakePayload`. Each piece (detection,
// section assembly, token-budget guard, telemetry) lands as a separate PR
// against the parent tracker.
//
// **Steps shipped:**
// - Step 2 (detection): `detectColdWake`, `resolveHibernationThresholdHours`,
//   `getLastSucceededRunFinishedAt`.
// - Step 3 (per-section assembler): `buildColdWakeBriefing` — collects the
//   five sections from §3.2 of the parent plan (recent commits, recently
//   closed referenced issues, sibling in-progress issues, plan document +
//   pending request_confirmation, recent related comments). Each section is
//   wrapped in a try/catch so a single failure degrades the briefing rather
//   than failing the wake.
// - Step 4 (token-budget guard): `DEFAULT_COLD_WAKE_BRIEFING_TOKEN_CAP`,
//   `resolveColdWakeBriefingTokenCap`, `estimateBriefingTokens`,
//   `enforceBriefingBudget`. Deterministic eviction order per parent plan
//   §3.3: oldest comments → oldest commits → siblings beyond top-3 →
//   closed-issues beyond top-3 → set `truncated: true`. Staleness header,
//   `planDocument`, and `pendingRequestConfirmation` are never dropped.
//
// The bypass switch, telemetry, and the call-site wiring land in follow-up
// PRs (steps 5–6).

import { execFile } from "node:child_process";
import { and, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";

/** Default hibernation threshold. 24h ≈ one working day; gaps longer than
 *  that are unambiguously stale from the agent's perspective. Tunable via
 *  `PAPERCLIP_HIBERNATION_THRESHOLD_HOURS` so operators can dial it down
 *  once telemetry justifies a tighter value. */
export const DEFAULT_HIBERNATION_THRESHOLD_HOURS = 24;

const SUCCEEDED_RUN_STATUS = "succeeded";
const MS_PER_HOUR = 3_600_000;

export type ColdWakeDetectionInput = {
  /** `null` when there is no prior succeeded run for the agent. */
  lastRunFinishedAt: Date | null;
  /** Override the default. Falsy values fall back to env / default. */
  thresholdHours?: number;
  /** Injectable clock for tests. Defaults to `new Date()`. */
  now?: Date;
};

export type ColdWakeDetection = {
  isColdWake: boolean;
  hoursSinceLastRun: number | null;
  lastRunFinishedAt: Date | null;
  thresholdHours: number;
};

/** Resolve the hibernation threshold from the supplied env or `process.env`,
 *  falling back to the default when unset, non-numeric, or non-positive. */
export function resolveHibernationThresholdHours(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.PAPERCLIP_HIBERNATION_THRESHOLD_HOURS;
  if (typeof raw !== "string" || raw.length === 0) {
    return DEFAULT_HIBERNATION_THRESHOLD_HOURS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HIBERNATION_THRESHOLD_HOURS;
  }
  return parsed;
}

/** Pure detection — given the last succeeded run's finish time, decide
 *  whether this wake should be treated as a cold wake. No DB access.
 *
 *  Boundary rule: a gap **strictly greater than** the threshold is cold.
 *  Exactly-at-threshold is warm; this keeps daily cron wakes (~24h apart)
 *  from being flagged cold by default while still catching multi-day gaps
 *  like the ALL-779 incident that motivated the briefing. */
export function detectColdWake(input: ColdWakeDetectionInput): ColdWakeDetection {
  const thresholdHours =
    typeof input.thresholdHours === "number" && Number.isFinite(input.thresholdHours) && input.thresholdHours > 0
      ? input.thresholdHours
      : resolveHibernationThresholdHours();
  const now = input.now ?? new Date();
  const lastRunFinishedAt = input.lastRunFinishedAt;

  if (!lastRunFinishedAt) {
    return {
      isColdWake: true,
      hoursSinceLastRun: null,
      lastRunFinishedAt: null,
      thresholdHours,
    };
  }

  const hoursSinceLastRun = (now.getTime() - lastRunFinishedAt.getTime()) / MS_PER_HOUR;
  return {
    isColdWake: hoursSinceLastRun > thresholdHours,
    hoursSinceLastRun,
    lastRunFinishedAt,
    thresholdHours,
  };
}

/** Look up the most recent succeeded `heartbeat_runs.finished_at` for an
 *  agent within a company. Returns `null` when no succeeded run is on
 *  record. The query is covered by the existing
 *  `heartbeat_runs_company_agent_started_idx` for filter selectivity; the
 *  trailing `order by finished_at desc` falls back to a small in-memory
 *  sort, which is acceptable for the per-wake call cadence. */
export async function getLastSucceededRunFinishedAt(input: {
  db: Db;
  companyId: string;
  agentId: string;
}): Promise<Date | null> {
  const rows = await input.db
    .select({ finishedAt: heartbeatRuns.finishedAt })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.status, SUCCEEDED_RUN_STATUS),
      ),
    )
    .orderBy(desc(heartbeatRuns.finishedAt))
    .limit(1);
  return rows[0]?.finishedAt ?? null;
}

// =============================================================================
// Step 3 — per-section assembler.
// =============================================================================

const RECENT_COMMITS_MAX = 20;
const SIBLING_LIMIT = 10;
const COMMENT_LIMIT_PER_ISSUE = 3;
const COMMENT_TOTAL_LIMIT = 25;
const COMMENT_PREVIEW_LIMIT = 280;
const CLOSED_ISSUE_LOOKBACK_DAYS = 14;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Default cap for the assembled cold-wake briefing, in estimated tokens.
 *  8000 is the parent plan §3.3 target: room for a meaningful briefing
 *  without crowding the wake payload itself. Tunable via
 *  `PAPERCLIP_COLD_WAKE_BRIEFING_TOKEN_CAP`. */
export const DEFAULT_COLD_WAKE_BRIEFING_TOKEN_CAP = 8000;

export type ColdWakeRecentCommit = {
  sha: string;
  subject: string;
  author: string;
  date: string;
  touchedReferencedPath: boolean;
};

export type ColdWakeClosedIssue = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  closedAt: string;
};

export type ColdWakeSiblingIssue = {
  id: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
  updatedAt: string;
};

export type ColdWakePlanDocument = {
  key: string;
  revisionId: string;
  updatedAt: string;
};

export type ColdWakePendingRequestConfirmation = {
  interactionId: string;
  revisionId: string | null;
  createdAt: string;
};

export type ColdWakeRelatedComment = {
  issueId: string;
  issueIdentifier: string | null;
  commentId: string;
  authorType: string;
  createdAt: string;
  bodyPreview: string;
  bodyTruncated: boolean;
};

export type ColdWakeBriefingError = {
  code: string;
  message: string;
};

/** The assembled briefing. Shape mirrors `PaperclipColdWakeBriefing` on
 *  `PaperclipWakePayload` (step 1) — `normalizePaperclipColdWakeBriefing`
 *  in `@paperclipai/adapter-utils` accepts this object verbatim. */
export type ColdWakeBriefing = {
  thresholdHours: number;
  hoursSinceLastRun: number | null;
  lastRunFinishedAt: string | null;
  recentCommits: ColdWakeRecentCommit[];
  recentCommitsTruncated: boolean;
  recentlyClosedReferencedIssues: ColdWakeClosedIssue[];
  siblingInProgressIssues: ColdWakeSiblingIssue[];
  planDocument: ColdWakePlanDocument | null;
  pendingRequestConfirmation: ColdWakePendingRequestConfirmation | null;
  recentRelatedComments: ColdWakeRelatedComment[];
  /** Section keys actually populated — matches the §3.2 source list:
   *  `"git" | "closed_issues" | "siblings" | "plan" | "interaction" | "comments"`.
   *  Sections that failed are omitted. When `enforceBriefingBudget` evicts
   *  items from a section, the entry is rewritten as `"<key>:truncated"`. */
  sourcesIncluded: string[];
  /** Estimated tokens after the budget guard runs. See
   *  `estimateBriefingTokens`. */
  budgetTokens: number;
  /** Cap the guard ran against. See `resolveColdWakeBriefingTokenCap`. */
  budgetTokenCap: number;
  /** True when any section was reduced by `enforceBriefingBudget`, or when
   *  the budget could not be hit even after evicting every droppable
   *  section. */
  truncated: boolean;
  briefingError: ColdWakeBriefingError | null;
};

/** Minimal context the assembler needs from the wake payload context
 *  snapshot. The wiring layer (step 6) maps the existing snapshot onto
 *  this shape; deliberately permissive so it can absorb upstream changes
 *  without ripping through every test. */
export type ColdWakeContextSnapshot = {
  /** Paths that the recent-commits section should flag as
   *  `touchedReferencedPath: true` when a commit touches them. Despite the
   *  legacy field name, this is consumed as a list of path fragments
   *  matched by substring against each commit's touched files. */
  referencedIssueIdentifiers?: string[] | null;
  /** Related work summary as produced by `listIssueReferenceSummary`. Only
   *  `outbound[*].issue.{id,identifier}` is consulted here. */
  relatedWork?: {
    outbound?: Array<
      | {
          issue?: {
            id?: string | null;
            identifier?: string | null;
          } | null;
        }
      | null
    > | null;
  } | null;
  /** Optional ancestor metadata. `chainOfCommand` widens the sibling-issue
   *  search to peers and supervisors; `ancestorIssueIds` widens the
   *  pending-request_confirmation search to plan reviews living on parents. */
  issueAncestry?: {
    chainOfCommand?: string[] | null;
    ancestorIssueIds?: string[] | null;
  } | null;
};

/** Raw commit shape returned by the git reader. Keeps the I/O concern
 *  (simple-git vs. `execFile('git', …)`) behind a single seam so tests can
 *  substitute a deterministic implementation. */
export type RawGitCommit = {
  sha: string;
  subject: string;
  author: string;
  date: string;
  files: string[];
};

/** Per-section runners. Default implementations hit the DB / filesystem;
 *  callers (tests) can override any subset to inject deterministic values
 *  or simulate failures. */
export type ColdWakeSectionRunners = {
  detectColdWake: typeof detectColdWake;
  getLastSucceededRunFinishedAt: typeof getLastSucceededRunFinishedAt;
  readRecentCommits: (
    workspaceCwd: string,
    maxCount: number,
  ) => Promise<RawGitCommit[]>;
  loadClosedReferencedIssues: (args: {
    db: Db;
    companyId: string;
    issueIds: string[];
    since: Date;
  }) => Promise<ColdWakeClosedIssue[]>;
  loadSiblingInProgressIssues: (args: {
    db: Db;
    companyId: string;
    assigneeAgentIds: string[];
    excludeIssueId: string;
    limit: number;
  }) => Promise<ColdWakeSiblingIssue[]>;
  loadPlanDocument: (args: {
    db: Db;
    companyId: string;
    issueId: string;
  }) => Promise<ColdWakePlanDocument | null>;
  loadPendingRequestConfirmation: (args: {
    db: Db;
    companyId: string;
    issueIds: string[];
  }) => Promise<ColdWakePendingRequestConfirmation | null>;
  loadRecentRelatedComments: (args: {
    db: Db;
    companyId: string;
    outbound: Array<{ id: string; identifier: string | null }>;
    perIssue: number;
    total: number;
    previewLimit: number;
  }) => Promise<ColdWakeRelatedComment[]>;
};

export type BuildColdWakeBriefingInput = {
  db: Db;
  companyId: string;
  agentId: string;
  issueId: string;
  contextSnapshot: ColdWakeContextSnapshot;
  /** Absolute path to the git workspace whose history the section 1 reader
   *  should walk. `null` (or unset) means the agent has no checked-out
   *  workspace and the git section degrades gracefully. */
  workspaceCwd?: string | null;
  /** Injectable clock for tests. Defaults to `new Date()`. */
  now?: Date;
  /** Test seam — override any subset of section runners. Defaults to the
   *  real DB / filesystem-backed implementations. */
  __overrides?: Partial<ColdWakeSectionRunners>;
};

/** Default git-log reader. Shells out to the system `git` binary to avoid a
 *  new runtime dependency; output is parsed via record/field separators
 *  (`%x1e` between commits, `%x1f` between header fields) so commit
 *  subjects with newlines do not split a record. */
async function defaultReadRecentCommits(
  workspaceCwd: string,
  maxCount: number,
): Promise<RawGitCommit[]> {
  return new Promise<RawGitCommit[]>((resolve, reject) => {
    execFile(
      "git",
      [
        "log",
        `--max-count=${maxCount}`,
        "--pretty=format:%x1e%H%x1f%s%x1f%an%x1f%aI",
        "--name-only",
      ],
      { cwd: workspaceCwd, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const commits: RawGitCommit[] = [];
        const records = stdout.split("\x1e");
        for (const rec of records) {
          const trimmed = rec.replace(/^\n+/, "");
          if (!trimmed) continue;
          const lines = trimmed.split("\n");
          const headerLine = lines[0] ?? "";
          const fileLines = lines.slice(1).filter((l) => l.length > 0);
          const [sha, subject, author, date] = headerLine.split("\x1f");
          if (!sha) continue;
          commits.push({
            sha,
            subject: subject ?? "",
            author: author ?? "",
            date: date ?? "",
            files: fileLines,
          });
        }
        resolve(commits);
      },
    );
  });
}

async function defaultLoadClosedReferencedIssues(args: {
  db: Db;
  companyId: string;
  issueIds: string[];
  since: Date;
}): Promise<ColdWakeClosedIssue[]> {
  if (args.issueIds.length === 0) return [];
  const rows = await args.db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, args.companyId),
        inArray(issues.id, args.issueIds),
        inArray(issues.status, ["done", "cancelled"]),
        gte(issues.updatedAt, args.since),
      ),
    )
    .orderBy(desc(issues.updatedAt));
  return rows.map((row) => ({
    id: row.id,
    identifier: row.identifier ?? null,
    title: row.title,
    status: row.status,
    closedAt: row.updatedAt.toISOString(),
  }));
}

async function defaultLoadSiblingInProgressIssues(args: {
  db: Db;
  companyId: string;
  assigneeAgentIds: string[];
  excludeIssueId: string;
  limit: number;
}): Promise<ColdWakeSiblingIssue[]> {
  if (args.assigneeAgentIds.length === 0) return [];
  const rows = await args.db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      assigneeAgentId: issues.assigneeAgentId,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, args.companyId),
        eq(issues.status, "in_progress"),
        inArray(issues.assigneeAgentId, args.assigneeAgentIds),
        ne(issues.id, args.excludeIssueId),
      ),
    )
    .orderBy(desc(issues.updatedAt))
    .limit(args.limit);
  return rows.map((row) => ({
    id: row.id,
    identifier: row.identifier ?? null,
    title: row.title,
    assigneeAgentId: row.assigneeAgentId,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function defaultLoadPlanDocument(args: {
  db: Db;
  companyId: string;
  issueId: string;
}): Promise<ColdWakePlanDocument | null> {
  const rows = await args.db
    .select({
      key: issueDocuments.key,
      updatedAt: issueDocuments.updatedAt,
      latestRevisionId: documents.latestRevisionId,
      documentId: documents.id,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
    .where(
      and(
        eq(issueDocuments.companyId, args.companyId),
        eq(issueDocuments.issueId, args.issueId),
        eq(issueDocuments.key, "plan"),
      ),
    )
    .orderBy(desc(issueDocuments.updatedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    key: row.key,
    // `latestRevisionId` is the canonical pointer; fall back to the document
    // id when the column is null (older rows seeded before revisions landed).
    revisionId: row.latestRevisionId ?? row.documentId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function defaultLoadPendingRequestConfirmation(args: {
  db: Db;
  companyId: string;
  issueIds: string[];
}): Promise<ColdWakePendingRequestConfirmation | null> {
  if (args.issueIds.length === 0) return null;
  const rows = await args.db
    .select({
      id: issueThreadInteractions.id,
      payload: issueThreadInteractions.payload,
      createdAt: issueThreadInteractions.createdAt,
    })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, args.companyId),
        inArray(issueThreadInteractions.issueId, args.issueIds),
        eq(issueThreadInteractions.kind, "request_confirmation"),
        eq(issueThreadInteractions.status, "pending"),
      ),
    )
    .orderBy(desc(issueThreadInteractions.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    interactionId: row.id,
    revisionId: extractTargetRevisionId(row.payload),
    createdAt: row.createdAt.toISOString(),
  };
}

function extractTargetRevisionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const target = (payload as Record<string, unknown>).target;
  if (!target || typeof target !== "object") return null;
  const revisionId = (target as Record<string, unknown>).revisionId;
  return typeof revisionId === "string" && revisionId.length > 0 ? revisionId : null;
}

async function defaultLoadRecentRelatedComments(args: {
  db: Db;
  companyId: string;
  outbound: Array<{ id: string; identifier: string | null }>;
  perIssue: number;
  total: number;
  previewLimit: number;
}): Promise<ColdWakeRelatedComment[]> {
  if (args.outbound.length === 0) return [];
  const issueIds = args.outbound.map((item) => item.id);
  const identifierMap = new Map(args.outbound.map((item) => [item.id, item.identifier]));
  const rows = await args.db
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      authorType: issueComments.authorType,
      body: issueComments.body,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, args.companyId),
        inArray(issueComments.issueId, issueIds),
        isNull(issueComments.deletedAt),
      ),
    )
    .orderBy(desc(issueComments.createdAt));

  const perIssueCount = new Map<string, number>();
  const seen = new Set<string>();
  const collected: ColdWakeRelatedComment[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    const taken = perIssueCount.get(row.issueId) ?? 0;
    if (taken >= args.perIssue) continue;
    const body = row.body ?? "";
    const truncated = body.length > args.previewLimit;
    collected.push({
      issueId: row.issueId,
      issueIdentifier: identifierMap.get(row.issueId) ?? null,
      commentId: row.id,
      authorType: row.authorType ?? "agent",
      createdAt: row.createdAt.toISOString(),
      bodyPreview: truncated ? body.slice(0, args.previewLimit) : body,
      bodyTruncated: truncated,
    });
    seen.add(row.id);
    perIssueCount.set(row.issueId, taken + 1);
    if (collected.length >= args.total) break;
  }
  return collected;
}

function defaultSectionRunners(): ColdWakeSectionRunners {
  return {
    detectColdWake,
    getLastSucceededRunFinishedAt,
    readRecentCommits: defaultReadRecentCommits,
    loadClosedReferencedIssues: defaultLoadClosedReferencedIssues,
    loadSiblingInProgressIssues: defaultLoadSiblingInProgressIssues,
    loadPlanDocument: defaultLoadPlanDocument,
    loadPendingRequestConfirmation: defaultLoadPendingRequestConfirmation,
    loadRecentRelatedComments: defaultLoadRecentRelatedComments,
  };
}

function collectOutboundIssues(
  snapshot: ColdWakeContextSnapshot,
): Array<{ id: string; identifier: string | null }> {
  const items = snapshot.relatedWork?.outbound ?? [];
  const out: Array<{ id: string; identifier: string | null }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = item?.issue?.id ?? null;
    if (typeof id !== "string" || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, identifier: item?.issue?.identifier ?? null });
  }
  return out;
}

function collectAssigneeAgentIds(
  snapshot: ColdWakeContextSnapshot,
  selfAgentId: string,
): string[] {
  const chain = snapshot.issueAncestry?.chainOfCommand ?? [];
  const ids = new Set<string>([selfAgentId]);
  for (const id of chain) {
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  return Array.from(ids);
}

function collectIssueAncestryIds(
  snapshot: ColdWakeContextSnapshot,
  selfIssueId: string,
): string[] {
  const ancestors = snapshot.issueAncestry?.ancestorIssueIds ?? [];
  const ids = new Set<string>([selfIssueId]);
  for (const id of ancestors) {
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  return Array.from(ids);
}

function describeSectionError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "unknown error";
  if (typeof err === "string") return err;
  return "unknown error";
}

/** Assemble the cold-wake briefing. Calls `detectColdWake` first and returns
 *  `null` on a warm wake (no briefing). On a cold wake, runs each section in
 *  parallel — each behind its own try/catch so a single failure degrades the
 *  briefing rather than failing the wake. `briefingError` is null on partial
 *  success; only set when *every* section throws.
 *
 *  Step 4: the assembled briefing is passed through `enforceBriefingBudget`
 *  before return, populating `budgetTokens` / `budgetTokenCap` / `truncated`
 *  per parent plan §3.3 and updating `sourcesIncluded` with `:truncated`
 *  markers when a section was evicted. */
export async function buildColdWakeBriefing(
  input: BuildColdWakeBriefingInput,
): Promise<ColdWakeBriefing | null> {
  const runners: ColdWakeSectionRunners = {
    ...defaultSectionRunners(),
    ...(input.__overrides ?? {}),
  };
  const now = input.now ?? new Date();

  // Detection — failure to read the last-succeeded run is treated as "no
  // prior run" (i.e. cold). Detection itself is a pure function and is not
  // wrapped because the briefing shape needs `thresholdHours`.
  let lastRunFinishedAt: Date | null = null;
  try {
    lastRunFinishedAt = await runners.getLastSucceededRunFinishedAt({
      db: input.db,
      companyId: input.companyId,
      agentId: input.agentId,
    });
  } catch {
    lastRunFinishedAt = null;
  }
  const detection = runners.detectColdWake({ lastRunFinishedAt, now });
  if (!detection.isColdWake) return null;

  const referencedPaths = (input.contextSnapshot.referencedIssueIdentifiers ?? []).filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const outboundIssues = collectOutboundIssues(input.contextSnapshot);
  const outboundIds = outboundIssues.map((item) => item.id);
  const assigneeAgentIds = collectAssigneeAgentIds(input.contextSnapshot, input.agentId);
  const ancestryIssueIds = collectIssueAncestryIds(input.contextSnapshot, input.issueId);
  const closedSince = new Date(now.getTime() - CLOSED_ISSUE_LOOKBACK_DAYS * MS_PER_DAY);

  // Section 1 — recent git commits, with the touched-referenced-path flag
  // tagged in-process so this is the only section that talks to the
  // filesystem.
  const gitSection = (async (): Promise<{
    recentCommits: ColdWakeRecentCommit[];
    recentCommitsTruncated: boolean;
  }> => {
    if (!input.workspaceCwd) {
      throw new Error("no_workspace_cwd");
    }
    const raw = await runners.readRecentCommits(input.workspaceCwd, RECENT_COMMITS_MAX);
    const recentCommits = raw.slice(0, RECENT_COMMITS_MAX).map((c) => ({
      sha: c.sha,
      subject: c.subject,
      author: c.author,
      date: c.date,
      touchedReferencedPath:
        referencedPaths.length > 0 &&
        c.files.some((f) => referencedPaths.some((p) => f === p || f.includes(p))),
    }));
    return {
      recentCommits,
      recentCommitsTruncated: raw.length > RECENT_COMMITS_MAX,
    };
  })();

  const closedIssuesSection = runners.loadClosedReferencedIssues({
    db: input.db,
    companyId: input.companyId,
    issueIds: outboundIds,
    since: closedSince,
  });

  const siblingsSection = runners.loadSiblingInProgressIssues({
    db: input.db,
    companyId: input.companyId,
    assigneeAgentIds,
    excludeIssueId: input.issueId,
    limit: SIBLING_LIMIT,
  });

  const planSection = runners.loadPlanDocument({
    db: input.db,
    companyId: input.companyId,
    issueId: input.issueId,
  });

  const interactionSection = runners.loadPendingRequestConfirmation({
    db: input.db,
    companyId: input.companyId,
    issueIds: ancestryIssueIds,
  });

  const commentsSection = runners.loadRecentRelatedComments({
    db: input.db,
    companyId: input.companyId,
    outbound: outboundIssues,
    perIssue: COMMENT_LIMIT_PER_ISSUE,
    total: COMMENT_TOTAL_LIMIT,
    previewLimit: COMMENT_PREVIEW_LIMIT,
  });

  // `Promise.allSettled` lets every section run in parallel and report its
  // own outcome, so one failure does not poison the whole briefing.
  const [
    gitResult,
    closedIssuesResult,
    siblingsResult,
    planResult,
    interactionResult,
    commentsResult,
  ] = await Promise.allSettled([
    gitSection,
    closedIssuesSection,
    siblingsSection,
    planSection,
    interactionSection,
    commentsSection,
  ]);

  const sourcesIncluded: string[] = [];
  const sectionErrors: string[] = [];
  let succeededAny = false;

  let recentCommits: ColdWakeRecentCommit[] = [];
  let recentCommitsTruncated = false;
  if (gitResult.status === "fulfilled") {
    recentCommits = gitResult.value.recentCommits;
    recentCommitsTruncated = gitResult.value.recentCommitsTruncated;
    sourcesIncluded.push("git");
    succeededAny = true;
  } else {
    sectionErrors.push(`git:${describeSectionError(gitResult.reason)}`);
  }

  let recentlyClosedReferencedIssues: ColdWakeClosedIssue[] = [];
  if (closedIssuesResult.status === "fulfilled") {
    recentlyClosedReferencedIssues = closedIssuesResult.value;
    sourcesIncluded.push("closed_issues");
    succeededAny = true;
  } else {
    sectionErrors.push(`closed_issues:${describeSectionError(closedIssuesResult.reason)}`);
  }

  let siblingInProgressIssues: ColdWakeSiblingIssue[] = [];
  if (siblingsResult.status === "fulfilled") {
    siblingInProgressIssues = siblingsResult.value;
    sourcesIncluded.push("siblings");
    succeededAny = true;
  } else {
    sectionErrors.push(`siblings:${describeSectionError(siblingsResult.reason)}`);
  }

  let planDocument: ColdWakePlanDocument | null = null;
  if (planResult.status === "fulfilled") {
    planDocument = planResult.value;
    sourcesIncluded.push("plan");
    succeededAny = true;
  } else {
    sectionErrors.push(`plan:${describeSectionError(planResult.reason)}`);
  }

  let pendingRequestConfirmation: ColdWakePendingRequestConfirmation | null = null;
  if (interactionResult.status === "fulfilled") {
    pendingRequestConfirmation = interactionResult.value;
    sourcesIncluded.push("interaction");
    succeededAny = true;
  } else {
    sectionErrors.push(`interaction:${describeSectionError(interactionResult.reason)}`);
  }

  let recentRelatedComments: ColdWakeRelatedComment[] = [];
  if (commentsResult.status === "fulfilled") {
    recentRelatedComments = commentsResult.value;
    sourcesIncluded.push("comments");
    succeededAny = true;
  } else {
    sectionErrors.push(`comments:${describeSectionError(commentsResult.reason)}`);
  }

  const briefingError: ColdWakeBriefingError | null = succeededAny
    ? null
    : {
        code: "all_sections_failed",
        message:
          sectionErrors.length > 0
            ? sectionErrors.join("; ")
            : "All briefing sections failed",
      };

  const tokenCap = resolveColdWakeBriefingTokenCap();
  const assembled: ColdWakeBriefing = {
    thresholdHours: detection.thresholdHours,
    hoursSinceLastRun: detection.hoursSinceLastRun,
    lastRunFinishedAt: detection.lastRunFinishedAt
      ? detection.lastRunFinishedAt.toISOString()
      : null,
    recentCommits,
    recentCommitsTruncated,
    recentlyClosedReferencedIssues,
    siblingInProgressIssues,
    planDocument,
    pendingRequestConfirmation,
    recentRelatedComments,
    sourcesIncluded,
    budgetTokens: 0,
    budgetTokenCap: tokenCap,
    truncated: false,
    briefingError,
  };
  return enforceBriefingBudget(assembled, { tokenCap, now });
}

// =============================================================================
// Step 4 — token-budget guard + deterministic eviction order.
//
// The guard is a pure function: it does not read the env, the DB, or the
// filesystem. Env resolution lives in `resolveColdWakeBriefingTokenCap`, and
// `buildColdWakeBriefing` calls that resolver to obtain the cap that gets
// passed in here. This keeps `enforceBriefingBudget` trivially testable while
// still picking up operator overrides at the call site.
// =============================================================================

const BRIEFING_SECTIONS_KEEP_TOP_N = 3;

/** Resolve the cold-wake briefing token cap from the supplied env or
 *  `process.env`, falling back to the default when unset, non-numeric, zero,
 *  or negative. Mirrors `resolveHibernationThresholdHours` so operators have
 *  a single mental model for both knobs. */
export function resolveColdWakeBriefingTokenCap(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.PAPERCLIP_COLD_WAKE_BRIEFING_TOKEN_CAP;
  if (typeof raw !== "string" || raw.length === 0) {
    return DEFAULT_COLD_WAKE_BRIEFING_TOKEN_CAP;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_COLD_WAKE_BRIEFING_TOKEN_CAP;
  }
  return parsed;
}

/** Cheap, deterministic token estimator. Serializes the briefing to JSON and
 *  divides the character count by 4 — the well-known rule-of-thumb for
 *  English text token density. This is intentionally approximate; the guard
 *  only needs ordering monotonicity to decide whether to keep evicting.
 *
 *  Pure function: same input → same output. Unit-testable without a real
 *  tokenizer. */
export function estimateBriefingTokens(briefing: ColdWakeBriefing): number {
  const json = JSON.stringify(briefing) ?? "";
  return Math.ceil(json.length / 4);
}

/** Update `sourcesIncluded`, rewriting `"<key>"` as `"<key>:truncated"` for
 *  every section that lost items. Sections that were not present originally
 *  are not added — eviction can only mark a section the assembler already
 *  populated. */
function markSourcesTruncated(
  current: ReadonlyArray<string>,
  truncatedSections: ReadonlySet<string>,
): string[] {
  if (truncatedSections.size === 0) return [...current];
  return current.map((src) => {
    const baseKey = src.split(":")[0] ?? src;
    return truncatedSections.has(baseKey) ? `${baseKey}:truncated` : src;
  });
}

export type EnforceBriefingBudgetOptions = {
  /** Override the resolved cap. Falsy / non-finite / non-positive values
   *  fall back to `DEFAULT_COLD_WAKE_BRIEFING_TOKEN_CAP`. */
  tokenCap?: number;
  /** Reserved for symmetry with the rest of the assembler call shape. The
   *  guard itself does not depend on the clock; accepting `now` keeps the
   *  signature stable if a future eviction policy needs it (e.g., age-based
   *  drop of "recent" entries that have since aged out). */
  now?: Date;
};

/** Enforce the cold-wake briefing token budget. Pure function: same input →
 *  same output, no side effects. Returns a new briefing object with
 *  `budgetTokens`, `budgetTokenCap`, `truncated`, and `sourcesIncluded`
 *  updated; the input briefing is not mutated.
 *
 *  Eviction order (parent plan §3.3, acceptance criterion 5). Drop in this
 *  order until under budget; re-estimate after every drop so we short-circuit
 *  as soon as the briefing falls under cap:
 *
 *  1. Oldest `recentRelatedComments` (sort by `createdAt`, drop oldest).
 *  2. Oldest `recentCommits` (sort by `date`, drop oldest).
 *  3. `siblingInProgressIssues` items beyond top 3 (sort by `updatedAt`
 *     DESC, keep top 3, drop the rest).
 *  4. `recentlyClosedReferencedIssues` items beyond top 3 (sort by
 *     `closedAt` DESC, keep top 3, drop the rest).
 *  5. If still over budget, set `truncated: true` and stop. The staleness
 *     header, `planDocument`, and `pendingRequestConfirmation` are NEVER
 *     mutated, even when the rest of the briefing is empty after eviction. */
export function enforceBriefingBudget(
  briefing: ColdWakeBriefing,
  options: EnforceBriefingBudgetOptions = {},
): ColdWakeBriefing {
  const tokenCap =
    typeof options.tokenCap === "number" &&
    Number.isFinite(options.tokenCap) &&
    options.tokenCap > 0
      ? options.tokenCap
      : DEFAULT_COLD_WAKE_BRIEFING_TOKEN_CAP;

  let working: ColdWakeBriefing = {
    ...briefing,
    budgetTokens: 0,
    budgetTokenCap: tokenCap,
    truncated: false,
  };

  // Short-circuit when already under cap. We still rewrite the budget fields
  // so callers can rely on `budgetTokens` reflecting the actual estimate.
  if (estimateBriefingTokens(working) <= tokenCap) {
    return { ...working, budgetTokens: estimateBriefingTokens(working) };
  }

  const truncatedSections = new Set<string>();

  // Step 1 — drop oldest comments first. Sort DESC so `pop()` removes the
  // oldest item; this preserves the original "newest-first" presentation
  // order for the survivors.
  let comments = [...working.recentRelatedComments].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  while (estimateBriefingTokens(working) > tokenCap && comments.length > 0) {
    comments.pop();
    truncatedSections.add("comments");
    working = { ...working, recentRelatedComments: comments };
  }

  // Step 2 — drop oldest commits next, same DESC-then-pop pattern.
  let commits = [...working.recentCommits].sort((a, b) =>
    b.date.localeCompare(a.date),
  );
  while (estimateBriefingTokens(working) > tokenCap && commits.length > 0) {
    commits.pop();
    truncatedSections.add("git");
    working = { ...working, recentCommits: commits };
  }

  // Step 3 — siblings beyond top-3. Sort DESC by updatedAt and pop the
  // back until we hit the top-3 floor or the budget.
  let siblings = [...working.siblingInProgressIssues].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  while (
    estimateBriefingTokens(working) > tokenCap &&
    siblings.length > BRIEFING_SECTIONS_KEEP_TOP_N
  ) {
    siblings.pop();
    truncatedSections.add("siblings");
    working = { ...working, siblingInProgressIssues: siblings };
  }

  // Step 4 — closed-issue references beyond top-3. Same shape as step 3.
  let closed = [...working.recentlyClosedReferencedIssues].sort((a, b) =>
    b.closedAt.localeCompare(a.closedAt),
  );
  while (
    estimateBriefingTokens(working) > tokenCap &&
    closed.length > BRIEFING_SECTIONS_KEEP_TOP_N
  ) {
    closed.pop();
    truncatedSections.add("closed_issues");
    working = { ...working, recentlyClosedReferencedIssues: closed };
  }

  // Step 5 — still over budget. Per §3.3 we never drop the staleness header
  // or section 4 (plan / interaction); flag truncated and return what we
  // have. The briefing is always returned, never nulled out.
  const overBudgetAfterEvict = estimateBriefingTokens(working) > tokenCap;
  const sourcesIncluded = markSourcesTruncated(working.sourcesIncluded, truncatedSections);
  const truncated = truncatedSections.size > 0 || overBudgetAfterEvict;
  const finalWorking: ColdWakeBriefing = {
    ...working,
    sourcesIncluded,
    truncated,
  };
  return { ...finalWorking, budgetTokens: estimateBriefingTokens(finalWorking) };
}
