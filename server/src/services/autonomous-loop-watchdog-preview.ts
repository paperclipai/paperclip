import { and, asc, eq, gt, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, issueDocuments, issues as issueTable } from "@paperclipai/db";
import { MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND,
  buildAutonomousGoalLoopState,
} from "./autonomous-goal-loop-continuation.js";
import { listMissionControlCompletionDocumentsForIssues } from "./mission-control-gates.js";

const WATCHDOG_PREVIEW_DEFAULT_LIMIT = 100;
const WATCHDOG_PREVIEW_MAX_LIMIT = 100;
const WATCHDOG_PREVIEW_CHILDREN_PER_PARENT_LIMIT = 100;
const WATCHDOG_PREVIEW_CURSOR_PREFIX = "wdog_cursor_";
const WATCHDOG_PREVIEW_CURSOR_VERSION = 1;
const WATCHDOG_PREVIEW_CURSOR_MAX_LENGTH = 2048;
const WATCHDOG_PREVIEW_CURSOR_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WATCHDOG_PREVIEW_OPEN_STATUS_EXCLUSIONS = ["done", "cancelled"] as const;

export type AutonomousGoalLoopWatchdogCursor = {
  version: typeof WATCHDOG_PREVIEW_CURSOR_VERSION;
  decisionMissingSort: 0 | 1;
  decisionUpdatedAt: string | null;
  issueUpdatedAt: string;
  issueId: string;
};

function invalidWatchdogCursor(): never {
  throw new Error("Invalid autonomous loop watchdog cursor");
}

function normalizeCursorTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeRequiredCursorTimestamp(value: unknown): string {
  const normalized = normalizeCursorTimestamp(value);
  if (!normalized) invalidWatchdogCursor();
  return normalized;
}

function normalizeCursorIssueId(value: unknown): string {
  if (typeof value !== "string" || !WATCHDOG_PREVIEW_CURSOR_UUID_PATTERN.test(value)) invalidWatchdogCursor();
  return value;
}

export function encodeAutonomousGoalLoopWatchdogCursor(
  input: Omit<AutonomousGoalLoopWatchdogCursor, "version">,
): string {
  if (input.decisionMissingSort !== 0 && input.decisionMissingSort !== 1) invalidWatchdogCursor();
  const decisionUpdatedAt =
    input.decisionMissingSort === 0 ? normalizeRequiredCursorTimestamp(input.decisionUpdatedAt) : input.decisionUpdatedAt;
  if (input.decisionMissingSort === 1 && input.decisionUpdatedAt !== null) invalidWatchdogCursor();
  const payload: AutonomousGoalLoopWatchdogCursor = {
    version: WATCHDOG_PREVIEW_CURSOR_VERSION,
    decisionMissingSort: input.decisionMissingSort,
    decisionUpdatedAt: input.decisionMissingSort === 0 ? decisionUpdatedAt : null,
    issueUpdatedAt: normalizeRequiredCursorTimestamp(input.issueUpdatedAt),
    issueId: normalizeCursorIssueId(input.issueId),
  };
  return `${WATCHDOG_PREVIEW_CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function parseAutonomousGoalLoopWatchdogCursor(cursor: string): AutonomousGoalLoopWatchdogCursor {
  if (cursor.length > WATCHDOG_PREVIEW_CURSOR_MAX_LENGTH) invalidWatchdogCursor();
  if (!cursor.startsWith(WATCHDOG_PREVIEW_CURSOR_PREFIX)) invalidWatchdogCursor();
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor.slice(WATCHDOG_PREVIEW_CURSOR_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    invalidWatchdogCursor();
  }
  if (!raw || typeof raw !== "object") invalidWatchdogCursor();
  const payload = raw as Record<string, unknown>;
  if (payload.version !== WATCHDOG_PREVIEW_CURSOR_VERSION) invalidWatchdogCursor();
  const decisionMissingSort = payload.decisionMissingSort;
  if (decisionMissingSort !== 0 && decisionMissingSort !== 1) invalidWatchdogCursor();
  const decisionUpdatedAt =
    decisionMissingSort === 0 ? normalizeRequiredCursorTimestamp(payload.decisionUpdatedAt) : null;
  if (decisionMissingSort === 1 && payload.decisionUpdatedAt !== null) invalidWatchdogCursor();
  return {
    version: WATCHDOG_PREVIEW_CURSOR_VERSION,
    decisionMissingSort,
    decisionUpdatedAt,
    issueUpdatedAt: normalizeRequiredCursorTimestamp(payload.issueUpdatedAt),
    issueId: normalizeCursorIssueId(payload.issueId),
  };
}

export function isValidAutonomousGoalLoopWatchdogCursor(cursor: string): boolean {
  try {
    parseAutonomousGoalLoopWatchdogCursor(cursor);
    return true;
  } catch {
    return false;
  }
}

export type AutonomousGoalLoopWatchdogPreviewCandidateKind =
  | "loop_decision_repair"
  | "loop_limit_attention"
  | "loop_manual_review"
  | "loop_operator_attention";

export type AutonomousGoalLoopWatchdogPreviewCandidate = {
  id: string;
  kind: AutonomousGoalLoopWatchdogPreviewCandidateKind;
  severity: "low" | "medium" | "high";
  owner: "operator";
  issueId: string;
  identifier: string | null;
  title: string;
  status: string | null;
  reason: string;
  recoveryAction: string;
  recommendedAction: string;
  userVisible: boolean;
  generatedAt: string;
};

export type AutonomousGoalLoopWatchdogPreview = {
  companyId: string;
  mode: "preview";
  readOnly: true;
  generatedAt: string;
  totalIssuesScanned: number;
  hasMore: boolean;
  nextCursor: string | null;
  candidates: AutonomousGoalLoopWatchdogPreviewCandidate[];
};

type WatchdogPreviewIssue = {
  id: string;
  companyId: string;
  projectId?: string | null;
  goalId?: string | null;
  identifier?: string | null;
  title: string;
  priority: string;
  status?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  requestDepth?: number | null;
  executionPolicy?: unknown;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

type AutonomousGoalLoopStateInput = Parameters<typeof buildAutonomousGoalLoopState>[0];
type WatchdogPreviewDocument = AutonomousGoalLoopStateInput["documents"][number];
type WatchdogPreviewChildIssue = NonNullable<AutonomousGoalLoopStateInput["childIssues"]>[number];

type WatchdogPreviewInputIssue = {
  issue: WatchdogPreviewIssue;
  documents: AutonomousGoalLoopStateInput["documents"];
  childIssues?: AutonomousGoalLoopStateInput["childIssues"];
};

function serializeGeneratedAt(value: string | Date | undefined) {
  if (value instanceof Date) return value.toISOString();
  return value ?? new Date().toISOString();
}

function clampLimit(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return WATCHDOG_PREVIEW_DEFAULT_LIMIT;
  return Math.min(WATCHDOG_PREVIEW_MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function candidateKindFor(recoveryAction: string): AutonomousGoalLoopWatchdogPreviewCandidateKind {
  if (recoveryAction === "repair_loop_decision") return "loop_decision_repair";
  if (recoveryAction === "adjust_loop_limits_or_close_goal") return "loop_limit_attention";
  if (recoveryAction === "manual_review") return "loop_manual_review";
  return "loop_operator_attention";
}

function severityFor(recoveryAction: string): AutonomousGoalLoopWatchdogPreviewCandidate["severity"] {
  if (recoveryAction === "repair_loop_decision") return "high";
  if (recoveryAction === "adjust_loop_limits_or_close_goal") return "medium";
  return "medium";
}

function recommendedActionFor(input: { reason: string; recoveryAction: string }) {
  if (input.recoveryAction === "repair_loop_decision") {
    return "Review and rewrite the ceo-loop-decision document for the current loop iteration before any continuation runs.";
  }
  if (input.recoveryAction === "adjust_loop_limits_or_close_goal") {
    return "Review loop runtime/iteration limits and either close the goal or explicitly adjust the safe limits.";
  }
  if (input.recoveryAction === "manual_review") {
    return "Inspect the loop documents and owner handoff; create a repair issue or ask the CEO to write the missing decision.";
  }
  return `Operator review required for autonomous-loop supervisor reason: ${input.reason}.`;
}

function timestampMs(value: string | Date | null | undefined) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  }
  return Number.MAX_SAFE_INTEGER;
}

function sortTimestampFor(item: WatchdogPreviewInputIssue) {
  const ceoDecisionUpdatedAt = item.documents
    .filter((document) => document.key === MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY)
    .map((document) => timestampMs(document.updatedAt))
    .sort((left, right) => left - right)[0];

  return ceoDecisionUpdatedAt ?? timestampMs(item.issue.updatedAt ?? item.issue.createdAt);
}

function ceoDecisionDocumentLinkJoinPredicate(companyId: string) {
  return and(
    eq(issueDocuments.issueId, issueTable.id),
    eq(issueDocuments.companyId, companyId),
    eq(issueDocuments.key, MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY),
  );
}

function ceoDecisionDocumentJoinPredicate(companyId: string) {
  return and(eq(issueDocuments.documentId, documents.id), eq(documents.companyId, companyId));
}

function ceoDecisionUpdatedAtCursorExpression() {
  return sql<Date | null>`date_trunc('milliseconds', ${documents.updatedAt})`;
}

function issueUpdatedAtCursorExpression() {
  return sql<Date>`date_trunc('milliseconds', ${issueTable.updatedAt})`;
}

function ceoDecisionMissingSort() {
  const decisionUpdatedAt = ceoDecisionUpdatedAtCursorExpression();
  return sql<number>`case when ${decisionUpdatedAt} is null then 1 else 0 end`;
}

function cursorDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function issueTieBreakAfter(updatedAt: Date | null | undefined, issueId: string) {
  const issueUpdatedAt = issueUpdatedAtCursorExpression();
  if (!updatedAt) return gt(issueTable.id, issueId);
  return or(gt(issueUpdatedAt, updatedAt), and(eq(issueUpdatedAt, updatedAt), gt(issueTable.id, issueId))) ?? gt(issueTable.id, issueId);
}

function cursorAfterPredicate(cursor: AutonomousGoalLoopWatchdogCursor) {
  const issueAfterCursor = issueTieBreakAfter(cursorDate(cursor.issueUpdatedAt), cursor.issueId);
  const decisionUpdatedAtExpression = ceoDecisionUpdatedAtCursorExpression();
  if (cursor.decisionMissingSort === 1) {
    return and(isNull(decisionUpdatedAtExpression), issueAfterCursor) ?? issueAfterCursor;
  }

  const decisionUpdatedAt = cursorDate(cursor.decisionUpdatedAt);
  if (!decisionUpdatedAt) invalidWatchdogCursor();
  return (
    or(
      gt(decisionUpdatedAtExpression, decisionUpdatedAt),
      and(eq(decisionUpdatedAtExpression, decisionUpdatedAt), issueAfterCursor),
      isNull(decisionUpdatedAtExpression),
    ) ?? issueAfterCursor
  );
}

type WatchdogIssueRow = WatchdogPreviewIssue & {
  decisionUpdatedAt?: string | Date | null;
  issueUpdatedAtCursor?: string | Date | null;
};

function cursorForIssueRow(issue: WatchdogIssueRow): string {
  const decisionUpdatedAt = normalizeCursorTimestamp(issue.decisionUpdatedAt);
  return encodeAutonomousGoalLoopWatchdogCursor({
    decisionMissingSort: decisionUpdatedAt ? 0 : 1,
    decisionUpdatedAt,
    issueUpdatedAt: normalizeRequiredCursorTimestamp(issue.issueUpdatedAtCursor ?? issue.updatedAt),
    issueId: issue.id,
  });
}

function normalizeExecuteRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

async function listContinuationChildIssuesForParents(
  db: Db,
  companyId: string,
  issueIds: string[],
): Promise<WatchdogPreviewChildIssue[]> {
  if (issueIds.length === 0) return [];

  const idList = sql.join(issueIds.map((issueId) => sql`${issueId}`), sql`, `);
  const rows = await db.execute(sql`
    select
      ranked.id as "id",
      ranked.parent_id as "parentId",
      ranked.identifier as "identifier",
      ranked.title as "title",
      ranked.status as "status",
      ranked.origin_kind as "originKind",
      ranked.origin_id as "originId",
      ranked.origin_fingerprint as "originFingerprint",
      ranked.assignee_agent_id as "assigneeAgentId",
      ranked.assignee_user_id as "assigneeUserId",
      ranked.created_at as "createdAt",
      ranked.updated_at as "updatedAt"
    from (
      select
        child.id,
        child.parent_id,
        child.identifier,
        child.title,
        child.status,
        child.origin_kind,
        child.origin_id,
        child.origin_fingerprint,
        child.assignee_agent_id,
        child.assignee_user_id,
        child.created_at,
        child.updated_at,
        row_number() over (partition by child.parent_id order by child.updated_at desc, child.id desc) as child_rank
      from ${issueTable} child
      where child.company_id = ${companyId}
        and child.parent_id in (${idList})
        and child.origin_kind = ${AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND}
        and child.origin_id = child.parent_id::text
        and child.hidden_at is null
    ) ranked
    where ranked.child_rank <= ${WATCHDOG_PREVIEW_CHILDREN_PER_PARENT_LIMIT}
    order by ranked.parent_id asc, ranked.updated_at desc, ranked.id desc
  `);

  return normalizeExecuteRows<WatchdogPreviewChildIssue>(rows);
}

export function buildAutonomousGoalLoopWatchdogPreview(input: {
  companyId: string;
  issues: WatchdogPreviewInputIssue[];
  generatedAt?: string | Date;
  hasMore?: boolean;
  nextCursor?: string | null;
}): AutonomousGoalLoopWatchdogPreview {
  const generatedAt = serializeGeneratedAt(input.generatedAt);
  const candidates: Array<AutonomousGoalLoopWatchdogPreviewCandidate & { sortTimestamp: number }> = [];

  for (const item of input.issues) {
    const state = buildAutonomousGoalLoopState({
      issue: item.issue,
      documents: item.documents,
      childIssues: item.childIssues ?? [],
      now: generatedAt,
    });
    if (!state.enabled) continue;
    if (!state.supervisor.attentionRequired || state.supervisor.owner !== "operator") continue;
    if (!state.supervisor.reason) continue;

    candidates.push({
      id: `${item.issue.id}:${state.supervisor.recoveryAction}:${state.supervisor.reason}`,
      kind: candidateKindFor(state.supervisor.recoveryAction),
      severity: severityFor(state.supervisor.recoveryAction),
      owner: "operator",
      issueId: item.issue.id,
      identifier: item.issue.identifier ?? null,
      title: item.issue.title,
      status: item.issue.status ?? null,
      reason: state.supervisor.reason,
      recoveryAction: state.supervisor.recoveryAction,
      recommendedAction: recommendedActionFor({
        reason: state.supervisor.reason,
        recoveryAction: state.supervisor.recoveryAction,
      }),
      userVisible: state.supervisor.userVisible,
      generatedAt,
      sortTimestamp: sortTimestampFor(item),
    });
  }

  candidates.sort((left, right) => {
    const severityOrder = { high: 0, medium: 1, low: 2 } as const;
    return (
      severityOrder[left.severity] - severityOrder[right.severity] ||
      left.sortTimestamp - right.sortTimestamp ||
      left.title.localeCompare(right.title)
    );
  });

  return {
    companyId: input.companyId,
    mode: "preview",
    readOnly: true,
    generatedAt,
    totalIssuesScanned: input.issues.length,
    hasMore: input.hasMore ?? false,
    nextCursor: input.nextCursor ?? null,
    candidates: candidates.map(({ sortTimestamp: _sortTimestamp, ...candidate }) => candidate),
  };
}

export async function listAutonomousGoalLoopWatchdogPreview(
  db: Db,
  companyId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<AutonomousGoalLoopWatchdogPreview> {
  const limit = clampLimit(options.limit);
  const generatedAt = new Date().toISOString();

  const issuePredicates = [
    eq(issueTable.companyId, companyId),
    isNull(issueTable.hiddenAt),
    notInArray(issueTable.status, [...WATCHDOG_PREVIEW_OPEN_STATUS_EXCLUSIONS]),
  ];

  if (options.cursor) {
    issuePredicates.push(cursorAfterPredicate(parseAutonomousGoalLoopWatchdogCursor(options.cursor)));
  }

  const decisionUpdatedAtCursor = ceoDecisionUpdatedAtCursorExpression();
  const issueUpdatedAtCursor = issueUpdatedAtCursorExpression();

  const issueRows = await db
    .select({
      id: issueTable.id,
      companyId: issueTable.companyId,
      projectId: issueTable.projectId,
      goalId: issueTable.goalId,
      identifier: issueTable.identifier,
      title: issueTable.title,
      priority: issueTable.priority,
      status: issueTable.status,
      assigneeAgentId: issueTable.assigneeAgentId,
      assigneeUserId: issueTable.assigneeUserId,
      requestDepth: issueTable.requestDepth,
      executionPolicy: issueTable.executionPolicy,
      createdAt: issueTable.createdAt,
      updatedAt: issueTable.updatedAt,
      decisionUpdatedAt: decisionUpdatedAtCursor,
      issueUpdatedAtCursor,
    })
    .from(issueTable)
    .leftJoin(issueDocuments, ceoDecisionDocumentLinkJoinPredicate(companyId))
    .leftJoin(documents, ceoDecisionDocumentJoinPredicate(companyId))
    .where(and(...issuePredicates))
    .orderBy(ceoDecisionMissingSort(), asc(decisionUpdatedAtCursor), asc(issueUpdatedAtCursor), asc(issueTable.id))
    .limit(limit + 1);

  const pageIssueRows = issueRows.slice(0, limit);
  const hasMore = issueRows.length > limit;
  const nextCursor = hasMore ? (pageIssueRows.at(-1) ? cursorForIssueRow(pageIssueRows.at(-1) as WatchdogIssueRow) : null) : null;
  const issueIds = pageIssueRows.map((issue) => issue.id);

  if (issueIds.length === 0) {
    return buildAutonomousGoalLoopWatchdogPreview({ companyId, issues: [], generatedAt, hasMore: false, nextCursor: null });
  }

  const [documentsByIssue, childIssueRows] = await Promise.all([
    listMissionControlCompletionDocumentsForIssues(db, issueIds, {
      companyId,
      documentKeys: [MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY],
    }),
    listContinuationChildIssuesForParents(db, companyId, issueIds),
  ]);

  const childIssuesByParent = new Map<string, WatchdogPreviewChildIssue[]>();
  for (const childIssue of childIssueRows as WatchdogPreviewChildIssue[]) {
    if (!childIssue.parentId || childIssue.originId !== childIssue.parentId) continue;
    const existing = childIssuesByParent.get(childIssue.parentId) ?? [];
    existing.push(childIssue);
    childIssuesByParent.set(childIssue.parentId, existing);
  }

  const issues = pageIssueRows.map((issue) => ({
    issue,
    documents: (documentsByIssue.get(issue.id) ?? []) as WatchdogPreviewDocument[],
    childIssues: childIssuesByParent.get(issue.id) ?? [],
  }));

  return buildAutonomousGoalLoopWatchdogPreview({ companyId, issues, generatedAt, hasMore, nextCursor });
}
