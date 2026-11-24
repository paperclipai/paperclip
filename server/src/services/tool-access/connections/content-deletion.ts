import { and, asc, desc, eq, gt, inArray, lte, sql, type SQL } from "drizzle-orm";
import {
  agentWakeupRequests,
  assets,
  heartbeatRunEvents,
  heartbeatRuns,
  issueConnectionContentDeletions,
  issueThreadInteractions,
  runnerApiResponseReservations,
  toolAccessAuditEvents,
  toolActionRequests,
  toolCallEvents,
  toolConnectionContentDeletions,
  toolInvocations,
  toolMcpAppViews,
  type Db,
} from "@paperclipai/db";
import type {
  ToolConnectionContentDeletion,
  ToolConnectionContentDeletionCounts,
  ToolConnectionStoredContent,
} from "@paperclipai/shared";
import { isRunLogStoreType, type RunLogHandle, type RunLogStore } from "../../run-log-store.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import { logActivity, type LogActivityInput } from "../../activity-log.js";
import { getStorageService } from "../../../storage/index.js";
import type { StorageService } from "../../../storage/types.js";
import { createStoredObjectDeletion } from "./stored-object-deletion.js";
import { RESULT_TEXT_KEYS, withoutActionResults, withoutResultText } from "./content-cleaning.js";

const BATCH_SIZE = 200;
const EVENT_BATCH_SIZE = 1000;
const STEP_BUDGET_MS = 10_000;

const SETTLED_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
const UNSETTLED_INVOCATION_STATUSES = ["pending", "authorized", "awaiting_approval", "executing"];
const UNSETTLED_ACTION_REQUEST_STATUSES = ["pending", "approved", "executing"];
const UNSETTLED_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"];
const STRUCTURAL_EVENT_TYPES = [
  "lifecycle",
  "run.terminal",
  "run.presentation.resolved",
  "adapter.invoke",
  "usage.reported",
  "context.compacted",
  "session.started",
  "session.resumed",
  "turn.started",
  "turn.accepted",
  "harness.ready",
];

type Phase = "invocations" | "events" | "auditEvents" | "appViews" | "deliveredResults" | "runs" | "done";
const PHASES: Phase[] = ["invocations", "events", "auditEvents", "appViews", "deliveredResults", "runs", "done"];
const RUN_BATCH_SIZE = 50;
const DELIVERY_BATCH_SIZE = 50;
const ISSUE_WAIT_MS = 60_000;
const ISSUE_WAIT_MAX_MS = 5 * 60_000;
const ISSUE_WAIT_LIMIT_MS = 24 * 60 * 60_000;

type RunInProgress = { id: string; eventAfterId: number; changed: boolean; stage?: "events" | "log" };

type Progress = {
  phase: Phase;
  waiting: boolean;
  cursor: { createdAt: string; id: string } | null;
  runCursor: string | null;
  currentRun: RunInProgress | null;
  pendingRuns: string[];
  counts: ToolConnectionContentDeletionCounts;
};

type DeletionRow = typeof toolConnectionContentDeletions.$inferSelect;
type IssueDeletionRow = typeof issueConnectionContentDeletions.$inferSelect;
type JobRow = Pick<DeletionRow, "id" | "companyId" | "status" | "progress" | "updatedAt" | "requestedAt" | "requestedByActorType" | "requestedByActorId">;
type JobActivity = Pick<LogActivityInput, "action" | "entityType" | "entityId" | "details">;

type JobStore<Row extends JobRow> = {
  load(id: string): Promise<Row | undefined>;
  scope(row: Row): Scope;
  waitMs(row: Row, open: number): number | null;
  save(tx: Db, row: Row, progress: Progress, waitMs: number | null): Promise<Row | undefined>;
  finish(tx: Db, row: Row, now: Date): Promise<Row | undefined>;
  activity(row: Row, counts: ToolConnectionContentDeletionCounts): JobActivity | null;
  fail(row: Row, message: string): Promise<void>;
};

type Scope = {
  companyId: string;
  cutoff: Date | null;
  connectionId: string | null;
  issueId: string | null;
  runIds: string[];
  invocationIds: string[];
  eventIds: string[];
  createdAfter: Date | null;
};

function connectionScope(connection: { id: string; companyId: string }, cutoff: Date): Scope {
  return { companyId: connection.companyId, cutoff, connectionId: connection.id, issueId: null, runIds: [], invocationIds: [], eventIds: [], createdAfter: null };
}

export function uuidList(values: string[]): SQL {
  return values.length > 0 ? sql`array[${sql.join(values.map((value) => sql`${value}::uuid`), sql`, `)}]` : sql`array[]::uuid[]`;
}

function textList(values: string[]): SQL {
  return values.length > 0 ? sql`array[${listSql(values)}]::text[]` : sql`array[]::text[]`;
}

function cutoffSql(column: SQL | typeof toolInvocations.createdAt, scope: Scope) {
  return scope.cutoff ? sql`${column} <= ${scope.cutoff.toISOString()}::timestamptz` : undefined;
}

function callsInScopeSql(scope: Scope, columns: { connectionId: SQL; runId: SQL; invocationId: SQL }): SQL {
  if (scope.connectionId) return sql`${columns.connectionId} = ${scope.connectionId}`;
  return sql`(${columns.runId} = any(${uuidList(scope.runIds)}) or ${columns.invocationId} = any(${uuidList(scope.invocationIds)}))`;
}

function invocationsInScopeSql(scope: Scope) {
  return callsInScopeSql(scope, { connectionId: sql`${toolInvocations.connectionId}`, runId: sql`${toolInvocations.runId}`, invocationId: sql`${toolInvocations.id}` });
}

function wakeCarriesResultsSql(requestIds: SQL): SQL {
  return sql`(${agentWakeupRequests.payload}->'toolActionRequestIds' ?| ${requestIds}
    or ${agentWakeupRequests.payload}->'_paperclipWakeContext'->'toolActionRequestIds' ?| ${requestIds})`;
}

function savedResultSql(runId: SQL): SQL {
  return sql`exists (select 1 from ${runnerApiResponseReservations} capture
    where capture.run_id = ${runId} and capture.asset_id is not null
      and not exists (select 1 from issue_attachments link where link.asset_id = capture.asset_id)
      and not exists (select 1 from case_attachments link where link.asset_id = capture.asset_id)
      and not exists (select 1 from company_logos link where link.asset_id = capture.asset_id))`;
}

export type ContentDeletionActor = { actorType: "user" | "agent" | "system"; actorId: string | null };

class ProgressConflict extends Error {}

export function emptyContentDeletionCounts(): ToolConnectionContentDeletionCounts {
  return { toolCalls: 0, approvals: 0, auditEvents: 0, appViews: 0, runs: 0, runsInProgress: 0, itemsInProgress: 0 };
}

function readProgress(row: { progress: unknown }): Progress {
  const raw = row.progress as Partial<Progress>;
  const counts = { ...emptyContentDeletionCounts(), ...(raw.counts ?? {}) };
  const phase = PHASES.includes(raw.phase as Phase) ? raw.phase as Phase : "invocations";
  return { phase, waiting: phase === "done" && raw.waiting === true, cursor: raw.cursor ?? null, runCursor: raw.runCursor ?? null,
    currentRun: raw.currentRun ?? null, pendingRuns: raw.pendingRuns ?? [], counts };
}

function nextPhase(phase: Phase): Phase {
  return PHASES[Math.min(PHASES.indexOf(phase) + 1, PHASES.length - 1)]!;
}

function listSql(values: string[]): SQL {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

export function settledRunSql(runId: SQL | typeof toolInvocations.runId): SQL {
  return sql`exists (select 1 from ${heartbeatRuns} r where r.id = ${runId}
    and r.status in (${listSql(SETTLED_RUN_STATUSES)})
    and r.finished_at is not null
    and r.cost_accounting_pending = false
    and not exists (select 1 from native_run_finalizations f where f.run_id = r.id
      and f.phase not in ('committed', 'terminal_failure', 'applied')))`;
}

function runsCallingConnectionSql(scope: Scope & { connectionId: string; cutoff: Date }): SQL {
  const calls = sql`${toolInvocations.companyId} = ${scope.companyId} and ${toolInvocations.connectionId} = ${scope.connectionId}
    and ${toolInvocations.createdAt} <= ${scope.cutoff.toISOString()}::timestamptz`;
  return sql`(${heartbeatRuns.id} in (select ${toolInvocations.runId} from ${toolInvocations} where ${calls} and ${toolInvocations.runId} is not null)
      or ${heartbeatRuns.id} in (select ${toolCallEvents.runId} from ${toolCallEvents} where ${toolCallEvents.companyId} = ${scope.companyId}
        and ${toolCallEvents.connectionId} = ${scope.connectionId} and ${toolCallEvents.createdAt} <= ${scope.cutoff.toISOString()}::timestamptz
        and ${toolCallEvents.runId} is not null)
      or (${heartbeatRuns.issueId} in (select ${toolActionRequests.issueId} from ${toolActionRequests}
            join ${toolInvocations} on ${toolInvocations.id} = ${toolActionRequests.invocationId} where ${calls})
        and ${heartbeatRuns.contextSnapshot}->'toolActionRequestIds' ?| array(select ${toolActionRequests.id}::text from ${toolActionRequests}
            join ${toolInvocations} on ${toolInvocations.id} = ${toolActionRequests.invocationId} where ${calls})))`;
}

export function runUsedToolsSql(companyId: string): SQL {
  return sql`(exists (select 1 from ${toolInvocations} where ${toolInvocations.companyId} = ${companyId} and ${toolInvocations.runId} = ${heartbeatRuns.id})
    or exists (select 1 from ${toolCallEvents} where ${toolCallEvents.companyId} = ${companyId} and ${toolCallEvents.runId} = ${heartbeatRuns.id})
    or coalesce(${heartbeatRuns.contextSnapshot} ? 'toolActionRequestIds', false))`;
}

export function runsWithStoredContentSql(scope: Scope): SQL {
  const resultText = sql.join(RESULT_TEXT_KEYS.map((key) =>
    sql.raw(`jsonb_path_exists(coalesce("heartbeat_runs"."result_json", '{}'::jsonb), 'lax $.**.${key} ? (@.type() == "string" && @ != "")')`)), sql` or `);
  const inScope = scope.connectionId && scope.cutoff
    ? runsCallingConnectionSql({ ...scope, connectionId: scope.connectionId, cutoff: scope.cutoff })
    : sql`${heartbeatRuns.id} = any(${uuidList(scope.runIds)}) and ${runUsedToolsSql(scope.companyId)}`;
  return sql`${heartbeatRuns.companyId} = ${scope.companyId}
    and ${inScope}
    and (${savedResultSql(sql`${heartbeatRuns.id}`)} or ${heartbeatRuns.logRef} is not null or ${heartbeatRuns.logStore} is not null
      or ${heartbeatRuns.stdoutExcerpt} is not null or ${heartbeatRuns.stderrExcerpt} is not null
      or ${resultText}
      or exists (select 1 from ${heartbeatRunEvents} where ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId}
        and ${heartbeatRunEvents.runId} = ${heartbeatRuns.id} and ${contentEventSql()}))`;
}

function contentEventSql(): SQL {
  return sql`${heartbeatRunEvents.eventType} not in (${listSql(STRUCTURAL_EVENT_TYPES)})
    and ${heartbeatRunEvents.eventType} not like 'native.%'
    and not (${heartbeatRunEvents.eventType} = 'item.completed' and (${heartbeatRunEvents.payload} -> 'prpEvent' -> 'payload' ->> 'kind') = 'usage')
    and (${heartbeatRunEvents.message} is not null or ${heartbeatRunEvents.payload} is not null)`;
}

function clearedSummary(column: SQL, deletedAt: string): SQL {
  return sql`case when ${column} is null then null
    else ${column} || jsonb_build_object('summary', '', 'contentDeletedAt', ${deletedAt}::text) end`;
}

function toDeletion(row: DeletionRow): ToolConnectionContentDeletion {
  return {
    id: row.id,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    retrying: row.status === "pending" && row.lastError !== null,
    counts: readProgress(row).counts,
  };
}

export function initialContentDeletionProgress(): Progress {
  return { phase: "invocations", waiting: false, cursor: null, runCursor: null, currentRun: null, pendingRuns: [], counts: emptyContentDeletionCounts() };
}

export function createConnectionContentDeletion(db: Db, deps: {
  runLogStore: () => RunLogStore;
  storage?: () => StorageService;
  objectRetryMs?: number;
}) {
  const storage = deps.storage ?? (() => getStorageService());
  const storedObjects = createStoredObjectDeletion(db, { runLogStore: deps.runLogStore, storage, retryMs: deps.objectRetryMs });

  async function latestDeletion(connection: { id: string; companyId: string }) {
    const [latest] = await db
      .select()
      .from(toolConnectionContentDeletions)
      .where(and(
        eq(toolConnectionContentDeletions.companyId, connection.companyId),
        eq(toolConnectionContentDeletions.connectionId, connection.id),
      ))
      .orderBy(desc(toolConnectionContentDeletions.createdAt))
      .limit(1);
    return latest ? toDeletion(latest) : null;
  }

  async function storedContent(connection: { id: string; companyId: string }): Promise<ToolConnectionStoredContent> {
    const scope = and(eq(toolInvocations.companyId, connection.companyId), eq(toolInvocations.connectionId, connection.id));
    const [calls] = await db
      .select({ toolCalls: sql<number>`count(*)::int` })
      .from(toolInvocations)
      .where(and(
        scope,
        sql`coalesce(${toolInvocations.resultSummary}->>'contentDeletedAt', ${toolInvocations.argumentsSummary}->>'contentDeletedAt') is null`,
        sql`(${toolInvocations.resultSummary} is not null or ${toolInvocations.argumentsSummary} is not null)`,
      ));
    const [approvals] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(toolActionRequests)
      .innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
      .where(and(
        scope,
        eq(toolActionRequests.companyId, connection.companyId),
        sql`(${toolActionRequests.canonicalArgumentsSummary}->>'contentDeletedAt' is null or ${toolActionRequests.previewMarkdown} is not null)`,
      ));
    const [views] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(toolMcpAppViews)
      .where(and(eq(toolMcpAppViews.connectionId, connection.id), eq(toolMcpAppViews.companyId, connection.companyId)));
    const [runs] = await db
      .select({
        runs: sql<number>`count(*)::int`,
        runsInProgress: sql<number>`count(*) filter (where not ${settledRunSql(sql`${heartbeatRuns.id}`)})::int`,
      })
      .from(heartbeatRuns)
      .where(runsWithStoredContentSql(connectionScope(connection, new Date())));
    return {
      stored: {
        toolCalls: calls?.toolCalls ?? 0,
        approvals: approvals?.count ?? 0,
        appViews: views?.count ?? 0,
        runs: runs?.runs ?? 0,
        runsInProgress: runs?.runsInProgress ?? 0,
      },
      deletion: await latestDeletion(connection),
    };
  }

  async function request(connection: { id: string; companyId: string }, actor: ContentDeletionActor) {
    return db.transaction(async (tx) => {
      const pendingFor = () => tx
        .select()
        .from(toolConnectionContentDeletions)
        .where(and(
          eq(toolConnectionContentDeletions.companyId, connection.companyId),
          eq(toolConnectionContentDeletions.connectionId, connection.id),
          eq(toolConnectionContentDeletions.status, "pending"),
        ))
        .limit(1);
      const [existing] = await pendingFor();
      if (existing) return { deletion: toDeletion(existing), created: false };
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.toolConnectionContentDeletion);
      const now = new Date();
      const [created] = await tx
        .insert(toolConnectionContentDeletions)
        .values({
          requestedAt: now,
          createdAt: now,
          updatedAt: now,
          companyId: connection.companyId,
          connectionId: connection.id,
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          progress: initialContentDeletionProgress() as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing()
        .returning();
      if (created) return { deletion: toDeletion(created), created: true };
      const [raced] = await pendingFor();
      return { deletion: toDeletion(raced!), created: false };
    });
  }

  async function settledRunIds(tx: Db, runIds: string[]) {
    if (runIds.length === 0) return new Set<string>();
    const rows = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(inArray(heartbeatRuns.id, runIds), settledRunSql(sql`${heartbeatRuns.id}`)));
    return new Set(rows.map((row) => row.id));
  }

  async function openRunIds(tx: Db, runIds: string[]) {
    if (runIds.length === 0) return new Set<string>();
    const rows = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(inArray(heartbeatRuns.id, runIds), sql`not ${settledRunSql(sql`${heartbeatRuns.id}`)}`));
    return new Set(rows.map((row) => row.id));
  }

  async function clearDeliveredResults(tx: Db, scope: Scope, progress: Progress, requests: Array<{ id: string; issueId: string | null }>) {
    const issueIds = scope.issueId ? [scope.issueId] : [...new Set(requests.flatMap((row) => row.issueId ? [row.issueId] : []))];
    if (issueIds.length === 0) return [];
    const ids = new Set(requests.map((row) => row.id));
    const idList = sql`array[${listSql([...ids])}]::text[]`;
    const runs = await tx
      .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, scope.companyId),
        scope.issueId ? sql`${heartbeatRuns.id} = any(${uuidList(scope.runIds)})` : inArray(heartbeatRuns.issueId, issueIds),
        sql`${heartbeatRuns.contextSnapshot}->'toolActionRequestIds' ?| ${idList}`,
      ))
      .for("update");
    const settled = await settledRunIds(tx, runs.map((row) => row.id));
    for (const run of runs) {
      if (!settled.has(run.id)) {
        progress.counts.itemsInProgress += 1;
        continue;
      }
      const cleaned = withoutActionResults(run.contextSnapshot, ids);
      if (cleaned.changed) {
        await tx.update(heartbeatRuns).set({ contextSnapshot: cleaned.value as Record<string, unknown> }).where(eq(heartbeatRuns.id, run.id));
      }
    }
    const wakes = await tx
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, scope.companyId),
        inArray(sql<string>`${agentWakeupRequests.payload}->>'issueId'`, issueIds),
        wakeCarriesResultsSql(idList),
      ))
      .for("update");
    for (const wake of wakes) {
      const cleaned = withoutActionResults(wake.payload, ids);
      if (!cleaned.changed) continue;
      if (UNSETTLED_WAKE_STATUSES.includes(wake.status)) {
        progress.counts.itemsInProgress += 1;
        continue;
      }
      await tx.update(agentWakeupRequests).set({ payload: cleaned.value as Record<string, unknown> }).where(eq(agentWakeupRequests.id, wake.id));
    }
    return runs.filter((row) => settled.has(row.id)).map((row) => row.id);
  }

  async function invocationsStep(tx: Db, scope: Scope, progress: Progress, deletedAt: string) {
    const cursor = progress.cursor;
    const page = await tx
      .select({ id: toolInvocations.id, createdAt: toolInvocations.createdAt, runId: toolInvocations.runId, status: toolInvocations.status })
      .from(toolInvocations)
      .where(and(
        eq(toolInvocations.companyId, scope.companyId),
        cutoffSql(sql`${toolInvocations.createdAt}`, scope),
        cursor ? sql`(${toolInvocations.createdAt}, ${toolInvocations.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
        invocationsInScopeSql(scope),
      ))
      .orderBy(asc(toolInvocations.createdAt), asc(toolInvocations.id))
      .limit(BATCH_SIZE);
    if (page.length === 0) return true;
    const settledRuns = await settledRunIds(tx, [...new Set(page.flatMap((row) => row.runId ? [row.runId] : []))]);
    const eligible = page.filter((row) => !UNSETTLED_INVOCATION_STATUSES.includes(row.status) && (!row.runId || settledRuns.has(row.runId)));
    progress.counts.itemsInProgress += page.length - eligible.length;
    const ids = eligible.map((row) => row.id);
    if (ids.length > 0) {
      const cleared = await tx
        .update(toolInvocations)
        .set({
          argumentsSummary: clearedSummary(sql`${toolInvocations.argumentsSummary}`, deletedAt) as never,
          resultSummary: clearedSummary(sql`${toolInvocations.resultSummary}`, deletedAt) as never,
          progress: null,
        })
        .where(and(
          eq(toolInvocations.companyId, scope.companyId),
          inArray(toolInvocations.id, ids),
          sql`coalesce(${toolInvocations.resultSummary}->>'contentDeletedAt', ${toolInvocations.argumentsSummary}->>'contentDeletedAt') is null`,
          sql`(${toolInvocations.resultSummary} is not null or ${toolInvocations.argumentsSummary} is not null or ${toolInvocations.progress} is not null)`,
        ))
        .returning({ id: toolInvocations.id });
      progress.counts.toolCalls += cleared.length;
      const requests = await tx
        .select({ id: toolActionRequests.id, interactionId: toolActionRequests.interactionId, issueId: toolActionRequests.issueId, status: toolActionRequests.status })
        .from(toolActionRequests)
        .where(and(eq(toolActionRequests.companyId, scope.companyId), inArray(toolActionRequests.invocationId, ids)));
      const settledRequests = requests.filter((row) => !UNSETTLED_ACTION_REQUEST_STATUSES.includes(row.status));
      progress.counts.itemsInProgress += requests.length - settledRequests.length;
      if (settledRequests.length > 0) {
        const requestIds = settledRequests.map((row) => row.id);
        const clearedRequests = await tx
          .update(toolActionRequests)
          .set({
            canonicalArgumentsSummary: clearedSummary(sql`${toolActionRequests.canonicalArgumentsSummary}`, deletedAt) as never,
            previewMarkdown: null,
            signedArguments: null,
          })
          .where(and(
            eq(toolActionRequests.companyId, scope.companyId),
            inArray(toolActionRequests.id, requestIds),
            sql`(${toolActionRequests.canonicalArgumentsSummary}->>'contentDeletedAt' is null or ${toolActionRequests.previewMarkdown} is not null or ${toolActionRequests.signedArguments} is not null)`,
          ))
          .returning({ id: toolActionRequests.id });
        progress.counts.approvals += clearedRequests.length;
        const interactionIds = settledRequests.flatMap((row) => row.interactionId ? [row.interactionId] : []);
        if (interactionIds.length > 0) {
          await tx
            .update(issueThreadInteractions)
            .set({
              payload: sql`case when jsonb_typeof(${issueThreadInteractions.payload}->'toolAction') = 'object'
                then jsonb_set(jsonb_set(${issueThreadInteractions.payload} - 'detailsMarkdown', '{toolAction,previewMarkdown}', 'null'::jsonb), '{toolAction,argumentsSummaryJson}', 'null'::jsonb)
                else ${issueThreadInteractions.payload} - 'detailsMarkdown' end` as never,
              result: sql`case when jsonb_typeof(${issueThreadInteractions.result}->'toolAction') = 'object'
                then jsonb_set(${issueThreadInteractions.result}, '{toolAction,resultSummary}', 'null'::jsonb)
                else ${issueThreadInteractions.result} end` as never,
            })
            .where(and(
              eq(issueThreadInteractions.companyId, scope.companyId),
              inArray(issueThreadInteractions.id, interactionIds),
              sql`(${issueThreadInteractions.payload} ? 'detailsMarkdown'
                or ${issueThreadInteractions.payload}->'toolAction'->>'previewMarkdown' is not null
                or ${issueThreadInteractions.payload}->'toolAction'->>'argumentsSummaryJson' is not null
                or ${issueThreadInteractions.result}->'toolAction'->>'resultSummary' is not null)`,
            ));
        }
      }
    }
    const last = page[page.length - 1]!;
    progress.cursor = { createdAt: last.createdAt.toISOString(), id: last.id };
    return page.length < BATCH_SIZE;
  }

  async function eventsStep(tx: Db, scope: Scope, progress: Progress, deletedAt: string) {
    const cursor = progress.cursor;
    const page = await tx
      .select({ id: toolCallEvents.id, createdAt: toolCallEvents.createdAt, runId: toolCallEvents.runId })
      .from(toolCallEvents)
      .where(and(
        eq(toolCallEvents.companyId, scope.companyId),
        cutoffSql(sql`${toolCallEvents.createdAt}`, scope),
        cursor ? sql`(${toolCallEvents.createdAt}, ${toolCallEvents.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
        scope.connectionId
          ? callsInScopeSql(scope, { connectionId: sql`${toolCallEvents.connectionId}`, runId: sql`${toolCallEvents.runId}`, invocationId: sql`${toolCallEvents.invocationId}` })
          : sql`(${callsInScopeSql(scope, { connectionId: sql`${toolCallEvents.connectionId}`, runId: sql`${toolCallEvents.runId}`, invocationId: sql`${toolCallEvents.invocationId}` })}
            or ${toolCallEvents.id} = any(${uuidList(scope.eventIds)}))`,
      ))
      .orderBy(asc(toolCallEvents.createdAt), asc(toolCallEvents.id))
      .limit(BATCH_SIZE);
    if (page.length === 0) return true;
    const settledRuns = await settledRunIds(tx, [...new Set(page.flatMap((row) => row.runId ? [row.runId] : []))]);
    const ids = page.filter((row) => !row.runId || settledRuns.has(row.runId)).map((row) => row.id);
    progress.counts.itemsInProgress += page.length - ids.length;
    if (ids.length > 0) {
      const cleared = await tx
        .update(toolCallEvents)
        .set({
          argumentsSummary: clearedSummary(sql`${toolCallEvents.argumentsSummary}`, deletedAt) as never,
          requestSummary: clearedSummary(sql`${toolCallEvents.requestSummary}`, deletedAt) as never,
          resultSummary: clearedSummary(sql`${toolCallEvents.resultSummary}`, deletedAt) as never,
        })
        .where(and(
          eq(toolCallEvents.companyId, scope.companyId),
          inArray(toolCallEvents.id, ids),
          sql`coalesce(${toolCallEvents.resultSummary}->>'contentDeletedAt', ${toolCallEvents.requestSummary}->>'contentDeletedAt', ${toolCallEvents.argumentsSummary}->>'contentDeletedAt') is null`,
          sql`(${toolCallEvents.resultSummary} is not null or ${toolCallEvents.requestSummary} is not null or ${toolCallEvents.argumentsSummary} is not null)`,
        ))
        .returning({ id: toolCallEvents.id });
      progress.counts.auditEvents += cleared.length;
    }
    const last = page[page.length - 1]!;
    progress.cursor = { createdAt: last.createdAt.toISOString(), id: last.id };
    return page.length < BATCH_SIZE;
  }

  async function auditEventsStep(tx: Db, scope: Scope, progress: Progress, deletedAt: string) {
    const cursor = progress.cursor;
    const page = await tx
      .select({ id: toolAccessAuditEvents.id, createdAt: toolAccessAuditEvents.createdAt, runId: sql<string | null>`${toolAccessAuditEvents.details}->>'runId'` })
      .from(toolAccessAuditEvents)
      .where(and(
        eq(toolAccessAuditEvents.companyId, scope.companyId),
        cutoffSql(sql`${toolAccessAuditEvents.createdAt}`, scope),
        scope.createdAfter ? sql`${toolAccessAuditEvents.createdAt} >= ${scope.createdAfter.toISOString()}::timestamptz` : undefined,
        cursor ? sql`(${toolAccessAuditEvents.createdAt}, ${toolAccessAuditEvents.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
        scope.connectionId
          ? eq(toolAccessAuditEvents.connectionId, scope.connectionId)
          : sql`(${toolAccessAuditEvents.details}->>'runId' = any(${textList(scope.runIds)})
            or ${toolAccessAuditEvents.details}->>'invocationId' = any(${textList(scope.invocationIds)})
            or ${toolAccessAuditEvents.details}->>'issueId' = ${scope.issueId})`,
      ))
      .orderBy(asc(toolAccessAuditEvents.createdAt), asc(toolAccessAuditEvents.id))
      .limit(BATCH_SIZE);
    if (page.length === 0) return true;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const runIds = [...new Set(page.flatMap((row) => row.runId && uuid.test(row.runId) ? [row.runId] : []))];
    const openRuns = await openRunIds(tx, runIds);
    const ids = page.filter((row) => !row.runId || !uuid.test(row.runId) || !openRuns.has(row.runId)).map((row) => row.id);
    progress.counts.itemsInProgress += page.length - ids.length;
    if (ids.length > 0) {
      const cleared = await tx
        .update(toolAccessAuditEvents)
        .set({
          details: sql`jsonb_set(${toolAccessAuditEvents.details}, '{argumentsSummary}',
            ${toolAccessAuditEvents.details}->'argumentsSummary' || jsonb_build_object('summary', '', 'contentDeletedAt', ${deletedAt}::text))` as never,
        })
        .where(and(
          eq(toolAccessAuditEvents.companyId, scope.companyId),
          inArray(toolAccessAuditEvents.id, ids),
          sql`jsonb_typeof(${toolAccessAuditEvents.details}->'argumentsSummary') = 'object'`,
          sql`${toolAccessAuditEvents.details}->'argumentsSummary'->>'contentDeletedAt' is null`,
        ))
        .returning({ id: toolAccessAuditEvents.id });
      progress.counts.auditEvents += cleared.length;
    }
    const last = page[page.length - 1]!;
    progress.cursor = { createdAt: last.createdAt.toISOString(), id: last.id };
    return page.length < BATCH_SIZE;
  }

  async function appViewsStep(tx: Db, scope: Scope, progress: Progress) {
    const page = await tx
      .select({ id: toolMcpAppViews.id, runId: toolMcpAppViews.runId })
      .from(toolMcpAppViews)
      .where(and(
        callsInScopeSql(scope, { connectionId: sql`${toolMcpAppViews.connectionId}`, runId: sql`${toolMcpAppViews.runId}`, invocationId: sql`${toolMcpAppViews.invocationId}` }),
        eq(toolMcpAppViews.companyId, scope.companyId),
        cutoffSql(sql`${toolMcpAppViews.createdAt}`, scope),
        progress.runCursor ? gt(toolMcpAppViews.id, progress.runCursor) : undefined,
      ))
      .orderBy(asc(toolMcpAppViews.id))
      .limit(BATCH_SIZE);
    if (page.length === 0) return true;
    const settledRuns = await settledRunIds(tx, [...new Set(page.flatMap((row) => row.runId ? [row.runId] : []))]);
    const ids = page.filter((row) => !row.runId || settledRuns.has(row.runId)).map((row) => row.id);
    progress.counts.itemsInProgress += page.length - ids.length;
    if (ids.length > 0) {
      const removed = await tx
        .delete(toolMcpAppViews)
        .where(and(eq(toolMcpAppViews.companyId, scope.companyId), inArray(toolMcpAppViews.id, ids)))
        .returning({ id: toolMcpAppViews.id });
      progress.counts.appViews += removed.length;
    }
    progress.runCursor = page[page.length - 1]!.id;
    return page.length < BATCH_SIZE;
  }

  async function runEventPage(tx: Db, companyId: string, run: RunInProgress) {
    const batch = await tx
      .select({ id: heartbeatRunEvents.id })
      .from(heartbeatRunEvents)
      .where(and(
        eq(heartbeatRunEvents.companyId, companyId),
        eq(heartbeatRunEvents.runId, run.id),
        gt(heartbeatRunEvents.id, run.eventAfterId),
      ))
      .orderBy(asc(heartbeatRunEvents.id))
      .limit(EVENT_BATCH_SIZE);
    if (batch.length === 0) return true;
    const ids = batch.map((row) => row.id);
    const cleared = await tx
      .update(heartbeatRunEvents)
      .set({ message: null, payload: null as never })
      .where(and(
        inArray(heartbeatRunEvents.id, ids),
        contentEventSql(),
      ))
      .returning({ id: heartbeatRunEvents.id });
    if (cleared.length > 0) run.changed = true;
    run.eventAfterId = ids[ids.length - 1]!;
    return batch.length < EVENT_BATCH_SIZE;
  }

  async function removeRunLog(companyId: string, runId: string, signal: AbortSignal) {
    let removedAny = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const [run] = await db
        .select({ logStore: heartbeatRuns.logStore, logRef: heartbeatRuns.logRef })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
      if (!run?.logRef && !run?.logStore) return removedAny;
      if (!run.logRef || !isRunLogStoreType(run.logStore)) throw new Error("run_log_store_unrecognised");
      const handle: RunLogHandle = { store: run.logStore, logRef: run.logRef };
      const store = deps.runLogStore();
      if (!store.remove) throw new Error("run_log_removal_unavailable");
      await store.remove(handle, signal);
      const updated = await db
        .update(heartbeatRuns)
        .set({ logStore: null, logRef: null })
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.logStore, run.logStore), eq(heartbeatRuns.logRef, run.logRef)))
        .returning({ id: heartbeatRuns.id });
      removedAny = true;
      if (updated.length > 0) return true;
    }
    throw new Error("run_log_reference_changed");
  }

  async function removeSavedResults(companyId: string, runId: string, signal: AbortSignal) {
    const saved = await db
      .select({ id: assets.id, objectKey: assets.objectKey })
      .from(assets)
      .where(and(
        eq(assets.companyId, companyId),
        sql`${assets.id} in (select capture.asset_id from ${runnerApiResponseReservations} capture
          where capture.company_id = ${companyId} and capture.run_id = ${runId} and capture.asset_id is not null)`,
        sql`not exists (select 1 from issue_attachments link where link.asset_id = ${assets.id})`,
        sql`not exists (select 1 from case_attachments link where link.asset_id = ${assets.id})`,
        sql`not exists (select 1 from company_logos link where link.asset_id = ${assets.id})`,
      ));
    for (const asset of saved) {
      await storage().deleteObject(companyId, asset.objectKey, { signal, allVersions: true });
      await db.delete(assets).where(and(eq(assets.id, asset.id), eq(assets.companyId, companyId)));
    }
    return saved.length > 0;
  }

  async function finishRun(tx: Db, companyId: string, run: RunInProgress) {
    const [row] = await tx
      .select({ stdoutExcerpt: heartbeatRuns.stdoutExcerpt, stderrExcerpt: heartbeatRuns.stderrExcerpt, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, companyId)))
      .for("update");
    if (!row) return;
    const result = withoutResultText(row.resultJson);
    if (row.stdoutExcerpt === null && row.stderrExcerpt === null && !result.changed) return;
    await tx
      .update(heartbeatRuns)
      .set({ stdoutExcerpt: null, stderrExcerpt: null, resultJson: result.value as Record<string, unknown> | null })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, companyId)));
    run.changed = true;
  }

  async function deliveredResultsStep(tx: Db, scope: Scope, progress: Progress) {
    const requests = await tx
      .select({ id: toolActionRequests.id, issueId: toolActionRequests.issueId })
      .from(toolActionRequests)
      .innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
      .where(and(
        eq(toolActionRequests.companyId, scope.companyId),
        eq(toolInvocations.companyId, scope.companyId),
        invocationsInScopeSql(scope),
        cutoffSql(sql`${toolInvocations.createdAt}`, scope),
        progress.runCursor ? gt(toolActionRequests.id, progress.runCursor) : undefined,
      ))
      .orderBy(asc(toolActionRequests.id))
      .limit(DELIVERY_BATCH_SIZE);
    if (requests.length === 0) return true;
    progress.runCursor = requests[requests.length - 1]!.id;
    await clearDeliveredResults(tx, scope, progress, requests);
    return requests.length < DELIVERY_BATCH_SIZE;
  }

  async function runsStep(tx: Db, scope: Scope, progress: Progress) {
    if (!progress.currentRun) {
      let runId = progress.pendingRuns.shift() ?? null;
      if (!runId) {
        const rows = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(and(
            progress.runCursor ? gt(heartbeatRuns.id, progress.runCursor) : undefined,
            runsWithStoredContentSql(scope),
          ))
          .orderBy(asc(heartbeatRuns.id))
          .limit(RUN_BATCH_SIZE);
        if (rows.length === 0) return true;
        progress.pendingRuns = rows.map((row) => row.id);
        progress.runCursor = rows[rows.length - 1]!.id;
        return false;
      }
      if (!(await settledRunIds(tx, [runId])).has(runId)) {
        progress.counts.runsInProgress += 1;
        return false;
      }
      progress.currentRun = { id: runId, eventAfterId: 0, changed: false, stage: "events" };
      return false;
    }
    const run = progress.currentRun;
    if (run.stage === "log") {
      if (run.changed) progress.counts.runs += 1;
      progress.currentRun = null;
      return false;
    }
    if (!(await runEventPage(tx, scope.companyId, run))) return false;
    await finishRun(tx, scope.companyId, run);
    run.stage = "log";
    return false;
  }

  const connectionJobs: JobStore<DeletionRow> = {
    load: async (id) => (await db.select().from(toolConnectionContentDeletions).where(eq(toolConnectionContentDeletions.id, id)))[0],
    scope: (row) => connectionScope({ id: row.connectionId, companyId: row.companyId }, row.requestedAt),
    waitMs: () => null,
    save: async (tx, row, progress) => (await tx
      .update(toolConnectionContentDeletions)
      .set({ progress: progress as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(and(
        eq(toolConnectionContentDeletions.id, row.id),
        eq(toolConnectionContentDeletions.status, "pending"),
        eq(toolConnectionContentDeletions.updatedAt, row.updatedAt),
      ))
      .returning())[0],
    finish: async (tx, row, now) => (await tx
      .update(toolConnectionContentDeletions)
      .set({ status: "completed", completedAt: now, updatedAt: now, lastError: null })
      .where(and(
        eq(toolConnectionContentDeletions.id, row.id),
        eq(toolConnectionContentDeletions.status, "pending"),
        eq(toolConnectionContentDeletions.updatedAt, row.updatedAt),
        sql`${toolConnectionContentDeletions.progress}->>'phase' = 'done' and coalesce(${toolConnectionContentDeletions.progress}->>'waiting', 'false') <> 'true'`,
      ))
      .returning())[0],
    activity: (row, counts) => ({ action: "tool_connection.content_deleted", entityType: "tool_connection", entityId: row.connectionId, details: { ...counts } }),
    fail: async (row, message) => {
      await db
        .update(toolConnectionContentDeletions)
        .set({ attempts: sql`${toolConnectionContentDeletions.attempts} + 1`, lastError: message, updatedAt: new Date() })
        .where(and(eq(toolConnectionContentDeletions.id, row.id), eq(toolConnectionContentDeletions.status, "pending")));
    },
  };

  const issueJobs: JobStore<IssueDeletionRow> = {
    load: async (id) => (await db.select().from(issueConnectionContentDeletions).where(eq(issueConnectionContentDeletions.id, id)))[0],
    scope: (row) => ({ companyId: row.companyId, cutoff: null, connectionId: null, issueId: row.issueId,
      runIds: row.scope.runIds ?? [], invocationIds: row.scope.invocationIds ?? [], eventIds: row.scope.eventIds ?? [],
      createdAfter: row.scope.createdAfter ? new Date(row.scope.createdAfter) : null }),
    waitMs: (row, open) => {
      const waitedMs = Date.now() - row.requestedAt.getTime();
      if (waitedMs >= ISSUE_WAIT_LIMIT_MS || open === 0) return null;
      return Math.min(Math.max(ISSUE_WAIT_MS, waitedMs / 10), ISSUE_WAIT_MAX_MS);
    },
    save: async (tx, row, progress, waitMs) => (await tx
      .update(issueConnectionContentDeletions)
      .set({
        progress: progress as unknown as Record<string, unknown>,
        updatedAt: new Date(),
        ...(waitMs === null ? {} : { notBefore: new Date(Date.now() + waitMs) }),
      })
      .where(and(
        eq(issueConnectionContentDeletions.id, row.id),
        eq(issueConnectionContentDeletions.status, "pending"),
        eq(issueConnectionContentDeletions.updatedAt, row.updatedAt),
      ))
      .returning())[0],
    finish: async (tx, row, now) => (await tx
      .update(issueConnectionContentDeletions)
      .set({ status: "completed", completedAt: now, updatedAt: now, lastError: null })
      .where(and(
        eq(issueConnectionContentDeletions.id, row.id),
        eq(issueConnectionContentDeletions.status, "pending"),
        eq(issueConnectionContentDeletions.updatedAt, row.updatedAt),
        sql`${issueConnectionContentDeletions.progress}->>'phase' = 'done' and coalesce(${issueConnectionContentDeletions.progress}->>'waiting', 'false') <> 'true'`,
      ))
      .returning())[0],
    activity: (row, counts) => {
      const deleted = counts.toolCalls + counts.approvals + counts.auditEvents + counts.appViews + counts.runs;
      const open = counts.itemsInProgress + counts.runsInProgress;
      if (deleted === 0 && open === 0) return null;
      return { action: open > 0 ? "issue.connection_content_deletion_incomplete" : "issue.connection_content_deleted",
        entityType: "issue", entityId: row.issueId, details: { ...counts } };
    },
    fail: async (row, message) => {
      await db
        .update(issueConnectionContentDeletions)
        .set({ attempts: sql`${issueConnectionContentDeletions.attempts} + 1`, lastError: message, updatedAt: new Date() })
        .where(and(eq(issueConnectionContentDeletions.id, row.id), eq(issueConnectionContentDeletions.status, "pending")));
    },
  };

  async function countOpenWork(tx: Db, scope: Scope) {
    const requestIds = sql`array(select ${toolActionRequests.id}::text from ${toolActionRequests}
      join ${toolInvocations} on ${toolInvocations.id} = ${toolActionRequests.invocationId}
      where ${toolActionRequests.companyId} = ${scope.companyId} and ${invocationsInScopeSql(scope)})`;
    const [open] = await tx.execute<{ count: number }>(sql`select (
      (select count(*) from ${heartbeatRuns} where ${heartbeatRuns.companyId} = ${scope.companyId}
        and ${heartbeatRuns.id} = any(${uuidList(scope.runIds)}) and not ${settledRunSql(sql`${heartbeatRuns.id}`)})
      + (select count(*) from ${toolInvocations} where ${toolInvocations.companyId} = ${scope.companyId}
        and ${invocationsInScopeSql(scope)} and ${toolInvocations.status} in (${listSql(UNSETTLED_INVOCATION_STATUSES)}))
      + (select count(*) from ${toolActionRequests} join ${toolInvocations} on ${toolInvocations.id} = ${toolActionRequests.invocationId}
        where ${toolActionRequests.companyId} = ${scope.companyId} and ${invocationsInScopeSql(scope)}
          and ${toolActionRequests.status} in (${listSql(UNSETTLED_ACTION_REQUEST_STATUSES)}))
      + (select count(*) from ${agentWakeupRequests} where ${agentWakeupRequests.companyId} = ${scope.companyId}
        and ${agentWakeupRequests.payload}->>'issueId' = ${scope.issueId}::text
        and ${agentWakeupRequests.status} in (${listSql(UNSETTLED_WAKE_STATUSES)})
        and ${wakeCarriesResultsSql(requestIds)})
    )::int as count`);
    return Number(open?.count ?? 0);
  }

  async function countOpenRunsWithoutTools(tx: Db, scope: Scope) {
    if (scope.runIds.length === 0) return 0;
    const [open] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, scope.companyId),
        sql`${heartbeatRuns.id} = any(${uuidList(scope.runIds)})`,
        sql`not ${runUsedToolsSql(scope.companyId)}`,
        sql`not ${settledRunSql(sql`${heartbeatRuns.id}`)}`,
      ));
    return open?.count ?? 0;
  }

  async function step<Row extends JobRow>(store: JobStore<Row>, job: Row, signal: AbortSignal) {
    const scope = store.scope(job);
    const progress = readProgress(job);
    const deletedAt = job.requestedAt.toISOString();
    if (progress.currentRun?.stage === "log") {
      const removedLog = await removeRunLog(scope.companyId, progress.currentRun.id, signal);
      const removedResults = await removeSavedResults(scope.companyId, progress.currentRun.id, signal);
      if (removedLog || removedResults) progress.currentRun.changed = true;
    }
    if (progress.waiting) {
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const waitMs = store.waitMs(job, await countOpenWork(tx, scope));
        if (waitMs === null) {
          Object.assign(progress, { ...initialContentDeletionProgress(), counts: { ...progress.counts, itemsInProgress: 0, runsInProgress: 0 } });
        }
        const saved = await store.save(tx, job, progress, waitMs);
        if (!saved) throw new ProgressConflict();
        return { row: saved, waiting: waitMs !== null };
      });
    }
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const done = progress.phase === "invocations" ? await invocationsStep(tx, scope, progress, deletedAt)
        : progress.phase === "events" ? await eventsStep(tx, scope, progress, deletedAt)
          : progress.phase === "auditEvents" ? await auditEventsStep(tx, scope, progress, deletedAt)
            : progress.phase === "appViews" ? await appViewsStep(tx, scope, progress)
              : progress.phase === "deliveredResults" ? await deliveredResultsStep(tx, scope, progress)
                : await runsStep(tx, scope, progress);
      if (done) {
        progress.phase = nextPhase(progress.phase);
        progress.cursor = null;
        progress.runCursor = null;
        progress.currentRun = null;
        progress.pendingRuns = [];
        if (progress.phase === "done" && scope.issueId) progress.counts.runsInProgress += await countOpenRunsWithoutTools(tx, scope);
      }
      const waitMs = progress.phase === "done" ? store.waitMs(job, progress.counts.itemsInProgress + progress.counts.runsInProgress) : null;
      progress.waiting = waitMs !== null;
      const saved = await store.save(tx, job, progress, waitMs);
      if (!saved) throw new ProgressConflict();
      return { row: saved, waiting: waitMs !== null };
    });
  }

  async function complete<Row extends JobRow>(store: JobStore<Row>, job: Row) {
    const counts = readProgress(job).counts;
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const done = await store.finish(tx, job, new Date());
      if (!done) return null;
      const activity = store.activity(job, counts);
      if (activity) {
        await logActivity(tx, {
          companyId: job.companyId,
          actorType: job.requestedByActorType === "agent" ? "agent" : job.requestedByActorType === "user" ? "user" : "system",
          actorId: job.requestedByActorId ?? "tool-connection-content-deletion",
          ...activity,
        });
      }
      return done;
    });
  }

  async function runJob<Row extends JobRow>(store: JobStore<Row>, jobId: string, signal: AbortSignal, budgetMs = STEP_BUDGET_MS) {
    const startedAt = Date.now();
    const loaded = await store.load(jobId);
    if (!loaded || loaded.status !== "pending") return loaded ?? null;
    let job: Row = loaded;
    try {
      while (!signal.aborted) {
        const current = readProgress(job);
        if (current.phase === "done" && !current.waiting) return await complete(store, job);
        const next: { row: Row; waiting: boolean } = await step(store, job, signal);
        job = next.row;
        if (next.waiting || Date.now() - startedAt >= budgetMs) return job;
      }
      return job;
    } catch (error) {
      if (error instanceof ProgressConflict) return null;
      await store.fail(job, error instanceof Error ? error.message.slice(0, 500) : "content deletion failed");
      throw error;
    }
  }

  async function process(jobId: string, signal: AbortSignal, budgetMs = STEP_BUDGET_MS) {
    return runJob(connectionJobs, jobId, signal, budgetMs);
  }

  async function processIssueDeletion(jobId: string, signal: AbortSignal, budgetMs = STEP_BUDGET_MS) {
    return runJob(issueJobs, jobId, signal, budgetMs);
  }

  async function processPending(signal: AbortSignal) {
    let failure: unknown = null;
    const connectionPending = await db
      .select({ id: toolConnectionContentDeletions.id })
      .from(toolConnectionContentDeletions)
      .where(eq(toolConnectionContentDeletions.status, "pending"))
      .orderBy(asc(toolConnectionContentDeletions.updatedAt))
      .limit(10);
    for (const { id } of connectionPending) {
      if (signal.aborted) break;
      await process(id, signal).catch((error: unknown) => { failure ??= error; });
    }
    const issuePending = await db
      .select({ id: issueConnectionContentDeletions.id })
      .from(issueConnectionContentDeletions)
      .where(and(eq(issueConnectionContentDeletions.status, "pending"), lte(issueConnectionContentDeletions.notBefore, new Date())))
      .orderBy(asc(issueConnectionContentDeletions.notBefore))
      .limit(10);
    for (const { id } of issuePending) {
      if (signal.aborted) break;
      await processIssueDeletion(id, signal).catch((error: unknown) => { failure ??= error; });
    }
    if (!signal.aborted) await storedObjects.drain(signal).catch((error: unknown) => { failure ??= error; });
    if (failure) throw failure;
  }

  async function nextDeadline() {
    const [connectionJob] = await db
      .select({ id: toolConnectionContentDeletions.id })
      .from(toolConnectionContentDeletions)
      .where(eq(toolConnectionContentDeletions.status, "pending"))
      .limit(1);
    if (connectionJob) return Date.now();
    const [issueJob] = await db
      .select({ at: sql<Date | null>`min(${issueConnectionContentDeletions.notBefore})`.mapWith(issueConnectionContentDeletions.notBefore) })
      .from(issueConnectionContentDeletions)
      .where(eq(issueConnectionContentDeletions.status, "pending"));
    const due = [issueJob?.at?.getTime() ?? null, await storedObjects.nextDeadline()].flatMap((at) => at === null ? [] : [at]);
    return due.length > 0 ? Math.max(Date.now(), Math.min(...due)) : null;
  }

  return { storedContent, latestDeletion, request, process, processIssueDeletion, processPending, nextDeadline };
}

export type ConnectionContentDeletionService = ReturnType<typeof createConnectionContentDeletion>;
