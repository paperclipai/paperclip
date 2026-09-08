import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, heartbeatRuns, issues } from "@paperclipai/db";
import {
  RUN_RECALL_DEFAULT_LIMIT,
  RUN_RECALL_MAX_LIMIT,
  RUN_RECALL_MAX_QUERY_LENGTH,
  RUN_RECALL_MAX_TOKENS,
  RUN_RECALL_SNIPPET_MAX_CHARS,
  type RunRecallActivityMatch,
  type RunRecallResponse,
  type RunRecallRunMatch,
  type RunRecallRunMatchedField,
} from "@paperclipai/shared";

// Run-recall search, borrowed from the DeepSeek Harness `session-query`
// family: one read-only recall surface over past heartbeat runs plus the
// activity log. Tokenized case-insensitive match, AND across tokens,
// bounded reads, company scoped. No schema change.

const MIN_TOKEN_LENGTH = 2;
const SOURCE_FIELD_CHARS = 2000;

export function tokenizeRunRecallQuery(query: string): string[] {
  const normalized = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return [];
  const tokens: string[] = [];
  for (const raw of normalized.split(" ")) {
    const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (token.length < MIN_TOKEN_LENGTH) continue;
    if (!tokens.includes(token)) tokens.push(token);
    if (tokens.length >= RUN_RECALL_MAX_TOKENS) break;
  }
  return tokens;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** AND across tokens of OR-ILIKE across fields. Caller LIKE patterns are escaped: no user wildcards. */
function matchAllTokens(tokens: string[], fields: SQLWrapper[]): SQL | undefined {
  if (tokens.length === 0 || fields.length === 0) return undefined;
  return and(
    ...tokens.map((token) => {
      const pattern = `%${escapeLikePattern(token)}%`;
      return sql`(${sql.join(
        fields.map((field) => sql`${field} ILIKE ${pattern} ESCAPE '\\'`),
        sql` OR `,
      )})`;
    }),
  );
}

export function buildRecallSnippet(text: string, tokens: string[]): string {
  const max = RUN_RECALL_SNIPPET_MAX_CHARS;
  if (text.length <= max) return text;
  const lowered = text.toLowerCase();
  let hit = -1;
  for (const token of tokens) {
    const index = lowered.indexOf(token);
    if (index >= 0 && (hit < 0 || index < hit)) hit = index;
  }
  if (hit < 0) return `${text.slice(0, max)}…`;
  const start = Math.max(0, hit - Math.floor(max / 3));
  const slice = text.slice(start, start + max);
  const prefix = start > 0 ? "…" : "";
  const suffix = start + max < text.length ? "…" : "";
  return `${prefix}${slice}${suffix}`;
}

type RunRecallRunRow = {
  id: string;
  status: string;
  agentId: string;
  agentName: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  error: string | null;
  errorCode: string | null;
  resultSummary: string | null;
  resultResult: string | null;
  resultMessage: string | null;
  resultError: string | null;
};

const RUN_MATCH_SOURCES: Array<{
  field: RunRecallRunMatchedField;
  pick: (row: RunRecallRunRow) => string | null;
}> = [
  { field: "error", pick: (row) => row.error },
  { field: "resultSummary", pick: (row) => row.resultSummary ?? row.resultResult ?? row.resultMessage ?? row.resultError },
  { field: "errorCode", pick: (row) => row.errorCode },
];

function toRunMatch(row: RunRecallRunRow, tokens: string[]): RunRecallRunMatch | null {
  for (const source of RUN_MATCH_SOURCES) {
    const text = source.pick(row);
    if (!text) continue;
    const lowered = text.toLowerCase();
    if (tokens.some((token) => lowered.includes(token))) {
      return {
        runId: row.id,
        status: row.status,
        agentId: row.agentId,
        agentName: row.agentName,
        issueId: row.issueId,
        issueIdentifier: row.issueIdentifier,
        issueTitle: row.issueTitle,
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        matchedField: source.field,
        snippet: buildRecallSnippet(text, tokens),
      };
    }
  }
  return null;
}

export interface SearchRunRecallInput {
  companyId: string;
  query: string;
  agentId?: string | null;
  status?: string | null;
  limit?: number | null;
}

export function resolveRunRecallLimit(limit: number | null | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return RUN_RECALL_DEFAULT_LIMIT;
  return Math.max(1, Math.min(RUN_RECALL_MAX_LIMIT, Math.floor(limit)));
}

export async function searchRunRecall(db: Db, input: SearchRunRecallInput): Promise<RunRecallResponse> {
  const query = input.query.trim().replace(/\s+/g, " ").slice(0, RUN_RECALL_MAX_QUERY_LENGTH);
  const tokens = tokenizeRunRecallQuery(query);
  const limit = resolveRunRecallLimit(input.limit);
  if (tokens.length === 0) {
    return { query, runs: [], activity: [] };
  }

  const runTextFields: SQLWrapper[] = [
    heartbeatRuns.error,
    heartbeatRuns.errorCode,
    sql`${heartbeatRuns.resultJson} ->> 'summary'`,
    sql`${heartbeatRuns.resultJson} ->> 'result'`,
    sql`${heartbeatRuns.resultJson} ->> 'message'`,
    sql`${heartbeatRuns.resultJson} ->> 'error'`,
    issues.identifier,
    issues.title,
  ];
  const runConditions = [
    eq(heartbeatRuns.companyId, input.companyId),
    ...(input.agentId ? [eq(heartbeatRuns.agentId, input.agentId)] : []),
    ...(input.status ? [eq(heartbeatRuns.status, input.status)] : []),
  ];
  const runTextMatch = matchAllTokens(tokens, runTextFields);
  if (runTextMatch) runConditions.push(runTextMatch);

  const runRows = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
      issueIdentifier: issues.identifier,
      issueTitle: issues.title,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
      error: sql<string | null>`left(${heartbeatRuns.error}, ${SOURCE_FIELD_CHARS})`.as("error"),
      errorCode: heartbeatRuns.errorCode,
      resultSummary: sql<string | null>`left(${heartbeatRuns.resultJson} ->> 'summary', ${SOURCE_FIELD_CHARS})`.as("resultSummary"),
      resultResult: sql<string | null>`left(${heartbeatRuns.resultJson} ->> 'result', ${SOURCE_FIELD_CHARS})`.as("resultResult"),
      resultMessage: sql<string | null>`left(${heartbeatRuns.resultJson} ->> 'message', ${SOURCE_FIELD_CHARS})`.as("resultMessage"),
      resultError: sql<string | null>`left(${heartbeatRuns.resultJson} ->> 'error', ${SOURCE_FIELD_CHARS})`.as("resultError"),
    })
    .from(heartbeatRuns)
    .leftJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, input.companyId)))
    .leftJoin(
      issues,
      and(
        sql`${issues.id}::text = ${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
        eq(issues.companyId, input.companyId),
      ),
    )
    .where(and(...runConditions))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(limit);

  const runs: RunRecallRunMatch[] = [];
  for (const row of runRows) {
    const match = toRunMatch(row, tokens);
    if (match) runs.push(match);
  }

  const activityTextFields: SQLWrapper[] = [
    activityLog.action,
    activityLog.entityType,
    activityLog.entityId,
    activityLog.actorId,
  ];
  const activityConditions = [
    eq(activityLog.companyId, input.companyId),
    ...(input.agentId ? [eq(activityLog.agentId, input.agentId)] : []),
  ];
  const activityTextMatch = matchAllTokens(tokens, activityTextFields);
  if (activityTextMatch) activityConditions.push(activityTextMatch);

  const activityRows = await db
    .select({
      id: activityLog.id,
      action: activityLog.action,
      entityType: activityLog.entityType,
      entityId: activityLog.entityId,
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
      agentId: activityLog.agentId,
      runId: activityLog.runId,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(and(...activityConditions))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);

  const activity: RunRecallActivityMatch[] = activityRows.map((row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actorType: row.actorType,
    actorId: row.actorId,
    agentId: row.agentId,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
  }));

  return { query, runs, activity };
}
