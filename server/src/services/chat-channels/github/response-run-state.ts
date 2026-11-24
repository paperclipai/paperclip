import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { chatMessageLinks, heartbeatRuns, runIdentityContexts, type Db } from "@paperclipai/db";
import type { HttpError } from "../../../errors.js";
import { chatRunSourceMessageId, chatRunSourceMessageIds } from "../run-origin.js";

/** Run statuses after which a run publishes nothing more for its request. */
export const FINISHED_RUN_STATUSES = ["succeeded", "failed", "interrupted", "timed_out", "cancelled"] as const;
/** `status in (...)` for FINISHED_RUN_STATUSES, for raw SQL over a run alias. */
export const finishedRunStatusSql = (status: SQL) =>
  sql`${status} in (${sql.raw(FINISHED_RUN_STATUSES.map(value => `'${value}'`).join(", "))})`;

export const responseRunColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  responsibleUserId: heartbeatRuns.responsibleUserId,
  activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
  nativeIssueId: heartbeatRuns.nativeIssueId,
  issueId: heartbeatRuns.issueId,
  status: heartbeatRuns.status,
  updatedAt: heartbeatRuns.updatedAt,
  // Terminal execution can precede native presentation commit. Until its
  // durable decision exists, missing output is undecided rather than failure.
  nativePresentationPending: sql<boolean>`coalesce(
    ${heartbeatRuns.status} = 'succeeded'
    and ${heartbeatRuns.runtimeMode} = 'native'
    and (${heartbeatRuns.nativePhase} is distinct from 'committed'
      or ${heartbeatRuns.resultJson}->'presentationDecision'->>'schema' is distinct from 'paperclip.run_presentation_decision.v1'
      or coalesce(${heartbeatRuns.resultJson}->'presentationDecision'->>'commentAction', '') not in ('none', 'create', 'reuse')),
    false
  )`,
  // Project only the server-committed no-publication decision, never the
  // potentially large native result or model-authored summary.
  passiveResponseWait: sql<boolean>`coalesce(
    ${heartbeatRuns.status} = 'succeeded'
    and ${heartbeatRuns.runtimeMode} = 'native'
    and ${heartbeatRuns.nativePhase} = 'committed'
    and ${heartbeatRuns.resultJson}->>'finalizationPhase' = 'committed'
    and ${heartbeatRuns.resultJson}->>'finalizationReasonCode' in
      ('external_chat_response_waiting', 'preserved_result_status_unproven')
    and ${heartbeatRuns.resultJson}->'nativeResult'->>'schema' = 'paperclip.run_result.v1'
    and ${heartbeatRuns.resultJson}->'nativeResult'->>'reportedWorkDisposition' = 'yielded'
    and ${heartbeatRuns.resultJson}->'nativeResult'->'continuation'->>'kind' = 'response_wake'
    and ${heartbeatRuns.resultJson}->'presentationDecision'->>'schema' = 'paperclip.run_presentation_decision.v1'
    and ${heartbeatRuns.resultJson}->'presentationDecision'->>'chosenSource' = 'none'
    and ${heartbeatRuns.resultJson}->'presentationDecision'->>'commentAction' = 'none'
    and ${heartbeatRuns.resultJson}->'presentationDecision'->'reasonCodes' @> '["yielded_control_plane_wait"]'::jsonb,
    false
  )`,
  contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
    'issueId', ${heartbeatRuns.contextSnapshot}->'issueId',
    'taskId', ${heartbeatRuns.contextSnapshot}->'taskId',
    'wakeCommentId', ${heartbeatRuns.contextSnapshot}->'wakeCommentId',
    'wakeCommentIds', ${heartbeatRuns.contextSnapshot}->'wakeCommentIds'
  )`,
};

export type GitHubResponseRunInput = {
  companyId: string; endpointId: string; agentId: string; issueId: string | null;
  deliveryId: string; sourceMessageId: string | null;
};
type RunRow = Omit<Awaited<ReturnType<typeof readRunRows>>[number], "ordinal">;
type ResponseRun = Omit<RunRow, "wokeForRequest" | "requestRunId">;
export type GitHubResponseRunState = { latestRun: ResponseRun | undefined; ownsLatestRequest: boolean;
  /** The latest finished run that woke for this request, which can differ from the latest run. */
  finishedRequestRun: ResponseRun | null };
/** The state of one request of a batch, or the 403 that its single read throws. */
export type GitHubResponseRunRead = GitHubResponseRunState | { forbidden: HttpError };

/** A value of the run reads: a literal of one request in a single read, or a
 * column of the request row in a batch read. */
type Value = string | SQL;
type Of = Record<"companyId" | "endpointId" | "agentId" | "issueId" | "deliveryId", Value>;

/** The assigned agent's latest run bound to the issue, where a run's issue is
 * coalesce(native_issue_id, context_snapshot->>'issueId'). The two precedence
 * branches are disjoint and each uses an issue index. */
const latestRunId = (of: Of) => sql`(select latest.id from (
    (select r.id, r.created_at from ${heartbeatRuns} r
      where r.company_id = ${of.companyId}::uuid and r.native_issue_id = ${of.issueId}::uuid and r.agent_id = ${of.agentId}::uuid
      order by r.created_at desc, r.id desc limit 1)
    union all
    (select r.id, r.created_at from ${heartbeatRuns} r
      where r.company_id = ${of.companyId}::uuid and r.native_issue_id is null
        and r.context_snapshot->>'issueId' = ${of.issueId}::text and r.agent_id = ${of.agentId}::uuid
      order by r.created_at desc, r.id desc limit 1)
  ) latest order by latest.created_at desc, latest.id desc limit 1)`;
/** Whether one of the request's inbound comments matches `match`. */
const requestLink = (of: Of, match: (commentId: SQL) => SQL) => sql<boolean>`exists (select 1 from ${chatMessageLinks} l
  where l.company_id = ${of.companyId}::uuid and l.endpoint_id = ${of.endpointId}::uuid
    and l.delivery_id = ${of.deliveryId}::uuid and l.direction = 'inbound' and (${match(sql`l.comment_id`)}))`;
/** Whether a run with this context snapshot woke for the comment. */
const wokeFor = (snapshot: SQL, commentId: SQL) => sql`${commentId}::text = ${snapshot}->>'wakeCommentId'
  or coalesce(${snapshot}->'wakeCommentIds', '[]'::jsonb) ? ${commentId}::text`;
/** Whether the run woke for one of the request's inbound comments. */
const wokeForRequest = (of: Of) => requestLink(of, commentId => wokeFor(sql`${heartbeatRuns.contextSnapshot}`, commentId));

/** The request's own run when it has finished: the latest run that woke for
 * the request, by a wake comment or by an accepted identity context for the
 * request's comment. Null while that run is still queued or running. A newer
 * run woken by another request can follow it within seconds, so the task's
 * latest run alone cannot say how this request ended. */
/** Whether the run aliased `run` is bound to the issue: its native issue, else
 * its context snapshot's issue. Index-friendly form of
 * coalesce(native_issue_id, context_snapshot->>'issueId'). */
export const runBoundToIssue = (run: SQL, issueId: Value) => sql`(${run}.native_issue_id = ${issueId}::uuid
  or (${run}.native_issue_id is null and ${run}.context_snapshot->>'issueId' = ${issueId}::text))`;
/** Whether the run aliased `run` woke for the comment: by a wake comment, or by
 * an accepted identity context for that comment. */
export const runWokeForComment = (run: SQL, commentId: SQL) => sql`(${wokeFor(sql`${run}.context_snapshot`, commentId)}
  or exists (select 1 from ${runIdentityContexts} c where c.id = ${run}.active_identity_context_id
    and c.run_id = ${run}.id and c.company_id = ${run}.company_id and c.status = 'accepted' and c.message_id = ${commentId}))`;

const finishedRequestRunId = (of: Of) => sql<string | null>`(select case
    when ${finishedRunStatusSql(sql`q.status`)} then q.id end
  from ${heartbeatRuns} q
  where q.company_id = ${of.companyId}::uuid and q.agent_id = ${of.agentId}::uuid
    and ${runBoundToIssue(sql`q`, of.issueId)}
    and ${requestLink(of, commentId => runWokeForComment(sql`q`, commentId))}
  order by q.created_at desc, q.id desc limit 1)`;

const request = sql.identifier("github_response_request");
const column = (name: string) => sql`${request}.${sql.identifier(name)}`;
const columns: Array<[keyof Of, string]> = [["companyId", "company_id"], ["endpointId", "endpoint_id"],
  ["agentId", "agent_id"], ["issueId", "issue_id"], ["deliveryId", "delivery_id"]];

/** The latest run of each request, in one statement. For each request row the
 * lateral subquery is the single read with the request columns in place of
 * the literals. */
async function readRunRows(db: Db, inputs: Array<GitHubResponseRunInput & { issueId: string }>) {
  const of = Object.fromEntries(columns.map(([key, name]) => [key, column(name)])) as Of;
  return db.select({ ordinal: sql<number>`${column("ordinal")}`.mapWith(Number), ...responseRunColumns,
    wokeForRequest: wokeForRequest(of), requestRunId: finishedRequestRunId(of) })
    .from(sql`unnest(${sql.join(columns.map(([key]) => sql`${sql.param(inputs.map(input => input[key]))}::uuid[]`), sql`, `)})
      with ordinality as ${request}(${sql.join([...columns.map(([, name]) => sql.identifier(name)), sql.identifier("ordinal")], sql`, `)})
      cross join lateral (select ${latestRunId(of)} as id) latest_request_run`)
    .innerJoin(heartbeatRuns, and(sql`${heartbeatRuns.id} = latest_request_run.id`,
      sql`${heartbeatRuns.companyId} = ${column("company_id")}`));
}

function ownership(input: GitHubResponseRunInput, row: RunRow | undefined, originMessageId: string | null,
  finished: Map<string, ResponseRun>): GitHubResponseRunState {
  if (!row) return { latestRun: undefined, ownsLatestRequest: false, finishedRequestRun: null };
  const { wokeForRequest: requestRunIsLatest, requestRunId, ...latestRun } = row;
  const ownsLatestRequest = requestRunIsLatest ||
    (!!input.sourceMessageId && originMessageId === input.sourceMessageId);
  return { latestRun, ownsLatestRequest,
    finishedRequestRun: !requestRunId ? null : requestRunId === latestRun.id ? latestRun : finished.get(requestRunId) ?? null };
}

/** The response columns of the earlier finished runs of the rows, in one statement. */
async function readFinishedRuns(db: Db, rows: RunRow[]) {
  const ids = [...new Set(rows.flatMap(row => row.requestRunId && row.requestRunId !== row.id ? [row.requestRunId] : []))];
  const found = new Map<string, ResponseRun>();
  if (!ids.length) return found;
  for (const run of await db.select(responseRunColumns).from(heartbeatRuns).where(inArray(heartbeatRuns.id, ids))) found.set(run.id, run);
  return found;
}

/** Shared request ownership and presentation state for delivery and recovery. */
export async function readGitHubResponseRun(db: Db, input: GitHubResponseRunInput): Promise<GitHubResponseRunState> {
  const { issueId } = input;
  if (!issueId) return { latestRun: undefined, ownsLatestRequest: false, finishedRequestRun: null };
  const of = { ...input, issueId };
  const [row] = await db.select({ ...responseRunColumns, wokeForRequest: wokeForRequest(of),
    requestRunId: finishedRequestRunId(of) }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), sql`${heartbeatRuns.id} = ${latestRunId(of)}`));
  const originMessageId = row?.activeIdentityContextId ? await chatRunSourceMessageId(db, row,
    { allowLegacyWakeComment: true, provider: "github" }) : null;
  return ownership(input, row, originMessageId, await readFinishedRuns(db, row ? [row] : []));
}

/** `readGitHubResponseRun` for a page of requests: one latest-run read for the
 * whole page, then one batched provenance check of its distinct runs, which
 * reuses the single check's reads. Each request gets, by position, the state a
 * separate call returns or the 403 that call throws. */
export async function readGitHubResponseRuns(db: Db, inputs: GitHubResponseRunInput[]): Promise<GitHubResponseRunRead[]> {
  const bound = inputs.flatMap((input, index) => input.issueId ? [{ index, input: { ...input, issueId: input.issueId } }] : []);
  const found = new Map<number, RunRow>();
  if (bound.length) {
    for (const { ordinal, ...row } of await readRunRows(db, bound.map(entry => entry.input))) found.set(bound[ordinal - 1]!.index, row);
  }
  const runs = [...new Map([...found.values()].filter(row => row.activeIdentityContextId).map(row => [row.id, row])).values()];
  const checked = await chatRunSourceMessageIds(db, runs, { allowLegacyWakeComment: true, provider: "github" });
  const finished = await readFinishedRuns(db, [...found.values()]);
  const origins = new Map(runs.map((run, index) => [run.id, checked[index]!]));
  return inputs.map((input, index) => {
    const row = found.get(index);
    const origin = row ? origins.get(row.id) : undefined;
    if (origin && "forbidden" in origin) return { forbidden: origin.forbidden };
    return ownership(input, row, origin?.messageId ?? null, finished);
  });
}
