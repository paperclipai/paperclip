import { and, asc, desc, eq, gt, inArray, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  issueThreadInteractions,
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
import { logActivity } from "../../activity-log.js";

const BATCH_SIZE = 200;
const EVENT_BATCH_SIZE = 1000;
const STEP_BUDGET_MS = 10_000;

const SETTLED_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
const UNSETTLED_INVOCATION_STATUSES = ["pending", "authorized", "awaiting_approval", "executing"];
const UNSETTLED_ACTION_REQUEST_STATUSES = ["pending", "approved", "executing"];
const UNSETTLED_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"];
const RESULT_TEXT_KEYS = ["summary", "result", "message"];
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

type Phase = "invocations" | "events" | "auditEvents" | "appViews" | "invocationRuns" | "eventRuns" | "deliveryRuns" | "done";
const PHASES: Phase[] = ["invocations", "events", "auditEvents", "appViews", "invocationRuns", "eventRuns", "deliveryRuns", "done"];
const DELIVERY_BATCH_SIZE = 50;

type RunInProgress = { id: string; eventAfterId: number; changed: boolean; stage?: "events" | "log" };

type Progress = {
  phase: Phase;
  cursor: { createdAt: string; id: string } | null;
  runCursor: string | null;
  currentRun: RunInProgress | null;
  pendingRuns: string[];
  counts: ToolConnectionContentDeletionCounts;
};

type DeletionRow = typeof toolConnectionContentDeletions.$inferSelect;

export type ContentDeletionActor = { actorType: "user" | "agent" | "system"; actorId: string | null };

class ProgressConflict extends Error {}

export function emptyContentDeletionCounts(): ToolConnectionContentDeletionCounts {
  return { toolCalls: 0, approvals: 0, auditEvents: 0, appViews: 0, runs: 0, runsInProgress: 0, itemsInProgress: 0 };
}

function readProgress(row: DeletionRow): Progress {
  const raw = row.progress as Partial<Progress>;
  const counts = { ...emptyContentDeletionCounts(), ...(raw.counts ?? {}) };
  const phase = PHASES.includes(raw.phase as Phase) ? raw.phase as Phase : "invocations";
  return { phase, cursor: raw.cursor ?? null, runCursor: raw.runCursor ?? null, currentRun: raw.currentRun ?? null, pendingRuns: raw.pendingRuns ?? [], counts };
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

function clearedSummary(column: SQL, deletedAt: string): SQL {
  return sql`case when ${column} is null then null
    else ${column} || jsonb_build_object('summary', '', 'contentDeletedAt', ${deletedAt}::text) end`;
}

export function withoutActionResults(value: unknown, actionRequestIds: ReadonlySet<string>): { value: unknown; changed: boolean } {
  let changed = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) next[key] = walk(entry);
    if (typeof record.actionRequestId === "string" && actionRequestIds.has(record.actionRequestId)
      && typeof record.resultSummary === "string" && record.resultSummary !== "") {
      next.resultSummary = "";
      changed = true;
    }
    return next;
  };
  const result = walk(value);
  return { value: changed ? result : value, changed };
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

export function createConnectionContentDeletion(db: Db, deps: { runLogStore: () => RunLogStore }) {
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
        runs: sql<number>`count(distinct ${heartbeatRuns.id})::int`,
        runsInProgress: sql<number>`count(distinct ${heartbeatRuns.id}) filter (where not ${settledRunSql(sql`${heartbeatRuns.id}`)})::int`,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, connection.companyId),
        sql`${heartbeatRuns.id} in (select ${toolInvocations.runId} from ${toolInvocations} where ${scope} and ${toolInvocations.runId} is not null)`,
        sql`(${heartbeatRuns.logRef} is not null or ${heartbeatRuns.stdoutExcerpt} is not null or ${heartbeatRuns.stderrExcerpt} is not null)`,
      ));
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
          progress: { phase: "invocations", cursor: null, runCursor: null, currentRun: null, pendingRuns: [], counts: emptyContentDeletionCounts() },
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

  async function clearDeliveredResults(tx: Db, job: DeletionRow, progress: Progress, requests: Array<{ id: string; issueId: string | null }>) {
    const issueIds = [...new Set(requests.flatMap((row) => row.issueId ? [row.issueId] : []))];
    if (issueIds.length === 0) return;
    const ids = new Set(requests.map((row) => row.id));
    const runs = await tx
      .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, job.companyId),
        inArray(heartbeatRuns.issueId, issueIds),
        sql`${heartbeatRuns.contextSnapshot}::text like '%"actionRequestId"%'`,
      ));
    const settled = await settledRunIds(tx, runs.map((row) => row.id));
    for (const run of runs) {
      const cleaned = withoutActionResults(run.contextSnapshot, ids);
      if (!cleaned.changed) continue;
      if (!settled.has(run.id)) {
        progress.counts.itemsInProgress += 1;
        continue;
      }
      await tx.update(heartbeatRuns).set({ contextSnapshot: cleaned.value as Record<string, unknown> }).where(eq(heartbeatRuns.id, run.id));
    }
    const wakes = await tx
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, job.companyId),
        inArray(sql<string>`${agentWakeupRequests.payload}->>'issueId'`, issueIds),
        sql`${agentWakeupRequests.payload}::text like '%"actionRequestId"%'`,
      ));
    for (const wake of wakes) {
      const cleaned = withoutActionResults(wake.payload, ids);
      if (!cleaned.changed) continue;
      if (UNSETTLED_WAKE_STATUSES.includes(wake.status)) {
        progress.counts.itemsInProgress += 1;
        continue;
      }
      await tx.update(agentWakeupRequests).set({ payload: cleaned.value as Record<string, unknown> }).where(eq(agentWakeupRequests.id, wake.id));
    }
  }

  async function invocationsStep(tx: Db, job: DeletionRow, progress: Progress, deletedAt: string) {
    const cursor = progress.cursor;
    const page = await tx
      .select({ id: toolInvocations.id, createdAt: toolInvocations.createdAt, runId: toolInvocations.runId, status: toolInvocations.status })
      .from(toolInvocations)
      .where(and(
        eq(toolInvocations.companyId, job.companyId),
        lte(toolInvocations.createdAt, job.requestedAt),
        cursor ? sql`(${toolInvocations.createdAt}, ${toolInvocations.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
        eq(toolInvocations.connectionId, job.connectionId),
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
          eq(toolInvocations.companyId, job.companyId),
          inArray(toolInvocations.id, ids),
          sql`coalesce(${toolInvocations.resultSummary}->>'contentDeletedAt', ${toolInvocations.argumentsSummary}->>'contentDeletedAt') is null`,
          sql`(${toolInvocations.resultSummary} is not null or ${toolInvocations.argumentsSummary} is not null or ${toolInvocations.progress} is not null)`,
        ))
        .returning({ id: toolInvocations.id });
      progress.counts.toolCalls += cleared.length;
      const requests = await tx
        .select({ id: toolActionRequests.id, interactionId: toolActionRequests.interactionId, issueId: toolActionRequests.issueId, status: toolActionRequests.status })
        .from(toolActionRequests)
        .where(and(eq(toolActionRequests.companyId, job.companyId), inArray(toolActionRequests.invocationId, ids)));
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
            eq(toolActionRequests.companyId, job.companyId),
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
              eq(issueThreadInteractions.companyId, job.companyId),
              inArray(issueThreadInteractions.id, interactionIds),
              sql`(${issueThreadInteractions.payload} ? 'detailsMarkdown'
                or ${issueThreadInteractions.payload}->'toolAction'->>'previewMarkdown' is not null
                or ${issueThreadInteractions.payload}->'toolAction'->>'argumentsSummaryJson' is not null
                or ${issueThreadInteractions.result}->'toolAction'->>'resultSummary' is not null)`,
            ));
        }
        await clearDeliveredResults(tx, job, progress, settledRequests);
      }
    }
    const last = page[page.length - 1]!;
    progress.cursor = { createdAt: last.createdAt.toISOString(), id: last.id };
    return page.length < BATCH_SIZE;
  }

  async function eventsStep(tx: Db, job: DeletionRow, progress: Progress, deletedAt: string) {
    const cursor = progress.cursor;
    const page = await tx
      .select({ id: toolCallEvents.id, createdAt: toolCallEvents.createdAt, runId: toolCallEvents.runId })
      .from(toolCallEvents)
      .where(and(
        eq(toolCallEvents.companyId, job.companyId),
        lte(toolCallEvents.createdAt, job.requestedAt),
        cursor ? sql`(${toolCallEvents.createdAt}, ${toolCallEvents.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
        eq(toolCallEvents.connectionId, job.connectionId),
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
          eq(toolCallEvents.companyId, job.companyId),
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

  async function auditEventsStep(tx: Db, job: DeletionRow, progress: Progress, deletedAt: string) {
    const cursor = progress.cursor;
    const page = await tx
      .select({ id: toolAccessAuditEvents.id, createdAt: toolAccessAuditEvents.createdAt, runId: sql<string | null>`${toolAccessAuditEvents.details}->>'runId'` })
      .from(toolAccessAuditEvents)
      .where(and(
        eq(toolAccessAuditEvents.companyId, job.companyId),
        lte(toolAccessAuditEvents.createdAt, job.requestedAt),
        cursor ? sql`(${toolAccessAuditEvents.createdAt}, ${toolAccessAuditEvents.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
        eq(toolAccessAuditEvents.connectionId, job.connectionId),
      ))
      .orderBy(asc(toolAccessAuditEvents.createdAt), asc(toolAccessAuditEvents.id))
      .limit(BATCH_SIZE);
    if (page.length === 0) return true;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const runIds = [...new Set(page.flatMap((row) => row.runId && uuid.test(row.runId) ? [row.runId] : []))];
    const settledRuns = await settledRunIds(tx, runIds);
    const ids = page.filter((row) => !row.runId || !uuid.test(row.runId) || settledRuns.has(row.runId)).map((row) => row.id);
    progress.counts.itemsInProgress += page.length - ids.length;
    if (ids.length > 0) {
      const cleared = await tx
        .update(toolAccessAuditEvents)
        .set({
          details: sql`jsonb_set(${toolAccessAuditEvents.details}, '{argumentsSummary}',
            ${toolAccessAuditEvents.details}->'argumentsSummary' || jsonb_build_object('summary', '', 'contentDeletedAt', ${deletedAt}::text))` as never,
        })
        .where(and(
          eq(toolAccessAuditEvents.companyId, job.companyId),
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

  async function appViewsStep(tx: Db, job: DeletionRow, progress: Progress) {
    const page = await tx
      .select({ id: toolMcpAppViews.id, runId: toolMcpAppViews.runId })
      .from(toolMcpAppViews)
      .where(and(
        eq(toolMcpAppViews.connectionId, job.connectionId),
        eq(toolMcpAppViews.companyId, job.companyId),
        lte(toolMcpAppViews.createdAt, job.requestedAt),
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
        .where(and(eq(toolMcpAppViews.companyId, job.companyId), inArray(toolMcpAppViews.id, ids)))
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
        sql`${heartbeatRunEvents.eventType} not in (${listSql(STRUCTURAL_EVENT_TYPES)})`,
        sql`${heartbeatRunEvents.eventType} not like 'native.%'`,
        sql`not (${heartbeatRunEvents.eventType} = 'item.completed' and (${heartbeatRunEvents.payload} -> 'prpEvent' -> 'payload' ->> 'kind') = 'usage')`,
        sql`(${heartbeatRunEvents.message} is not null or ${heartbeatRunEvents.payload} is not null)`,
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

  async function finishRun(tx: Db, companyId: string, run: RunInProgress) {
    const cleared = await tx
      .update(heartbeatRuns)
      .set({
        stdoutExcerpt: null,
        stderrExcerpt: null,
        resultJson: sql`case when ${heartbeatRuns.resultJson} is null then null
          else ${heartbeatRuns.resultJson} - array[${listSql(RESULT_TEXT_KEYS)}]::text[] end` as never,
      })
      .where(and(
        eq(heartbeatRuns.id, run.id),
        eq(heartbeatRuns.companyId, companyId),
        sql`(${heartbeatRuns.stdoutExcerpt} is not null or ${heartbeatRuns.stderrExcerpt} is not null
          or ${heartbeatRuns.resultJson} ?| array[${listSql(RESULT_TEXT_KEYS)}]::text[])`,
      ))
      .returning({ id: heartbeatRuns.id });
    if (cleared.length > 0) run.changed = true;
  }

  async function nextRun(tx: Db, job: DeletionRow, progress: Progress, source: "invocations" | "events") {
    const table = source === "invocations" ? toolInvocations : toolCallEvents;
    const [row] = await tx
      .select({ runId: table.runId })
      .from(table)
      .where(and(
        eq(table.companyId, job.companyId),
        isNotNull(table.runId),
        progress.runCursor ? gt(table.runId, progress.runCursor) : undefined,
        eq(table.connectionId, job.connectionId),
        lte(table.createdAt, job.requestedAt),
      ))
      .orderBy(asc(table.runId))
      .limit(1);
    return row?.runId ?? null;
  }

  async function nextDeliveryRuns(tx: Db, job: DeletionRow, progress: Progress) {
    const requests = await tx
      .select({ id: toolActionRequests.id, issueId: toolActionRequests.issueId })
      .from(toolActionRequests)
      .innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
      .where(and(
        eq(toolActionRequests.companyId, job.companyId),
        eq(toolInvocations.companyId, job.companyId),
        eq(toolInvocations.connectionId, job.connectionId),
        lte(toolInvocations.createdAt, job.requestedAt),
        progress.cursor ? gt(toolActionRequests.id, progress.cursor.id) : undefined,
      ))
      .orderBy(asc(toolActionRequests.id))
      .limit(DELIVERY_BATCH_SIZE);
    if (requests.length === 0) return null;
    progress.cursor = { createdAt: new Date(0).toISOString(), id: requests[requests.length - 1]!.id };
    const issueIds = [...new Set(requests.flatMap((row) => row.issueId ? [row.issueId] : []))];
    if (issueIds.length === 0) return [];
    const runs = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, job.companyId),
        inArray(heartbeatRuns.issueId, issueIds),
        sql`${heartbeatRuns.contextSnapshot}->'toolActionRequestIds' ?| array[${listSql(requests.map((row) => row.id))}]::text[]`,
      ));
    return runs.map((row) => row.id);
  }

  async function runsStep(tx: Db, job: DeletionRow, progress: Progress) {
    const delivery = progress.phase === "deliveryRuns";
    if (!progress.currentRun) {
      let runId = progress.pendingRuns.shift() ?? null;
      if (!runId && delivery) {
        const found = await nextDeliveryRuns(tx, job, progress);
        if (found === null) return true;
        progress.pendingRuns = found;
        return false;
      }
      if (!runId) runId = await nextRun(tx, job, progress, progress.phase === "invocationRuns" ? "invocations" : "events");
      if (!runId) return true;
      if (!(await settledRunIds(tx, [runId])).has(runId)) {
        if (progress.phase !== "eventRuns") progress.counts.runsInProgress += 1;
        if (!delivery) progress.runCursor = runId;
        return false;
      }
      progress.currentRun = { id: runId, eventAfterId: 0, changed: false, stage: "events" };
      return false;
    }
    const run = progress.currentRun;
    if (run.stage === "log") {
      if (run.changed) progress.counts.runs += 1;
      if (!delivery) progress.runCursor = run.id;
      progress.currentRun = null;
      return false;
    }
    if (!(await runEventPage(tx, job.companyId, run))) return false;
    await finishRun(tx, job.companyId, run);
    run.stage = "log";
    return false;
  }

  async function step(job: DeletionRow, signal: AbortSignal) {
    const progress = readProgress(job);
    const deletedAt = job.requestedAt.toISOString();
    if (progress.currentRun?.stage === "log" && await removeRunLog(job.companyId, progress.currentRun.id, signal)) {
      progress.currentRun.changed = true;
    }
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const done = progress.phase === "invocations" ? await invocationsStep(tx, job, progress, deletedAt)
        : progress.phase === "events" ? await eventsStep(tx, job, progress, deletedAt)
          : progress.phase === "auditEvents" ? await auditEventsStep(tx, job, progress, deletedAt)
            : progress.phase === "appViews" ? await appViewsStep(tx, job, progress)
              : await runsStep(tx, job, progress);
      if (done) {
        progress.phase = nextPhase(progress.phase);
        progress.cursor = null;
        progress.runCursor = null;
        progress.currentRun = null;
        progress.pendingRuns = [];
      }
      const [saved] = await tx
        .update(toolConnectionContentDeletions)
        .set({ progress: progress as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(and(
          eq(toolConnectionContentDeletions.id, job.id),
          eq(toolConnectionContentDeletions.status, "pending"),
          eq(toolConnectionContentDeletions.updatedAt, job.updatedAt),
        ))
        .returning();
      if (!saved) throw new ProgressConflict();
      return saved;
    });
  }

  async function complete(job: DeletionRow) {
    const progress = readProgress(job);
    const now = new Date();
    return db.transaction(async (tx) => {
      const [done] = await tx
        .update(toolConnectionContentDeletions)
        .set({ status: "completed", completedAt: now, updatedAt: now, lastError: null })
        .where(and(
          eq(toolConnectionContentDeletions.id, job.id),
          eq(toolConnectionContentDeletions.status, "pending"),
          eq(toolConnectionContentDeletions.updatedAt, job.updatedAt),
          sql`${toolConnectionContentDeletions.progress}->>'phase' = 'done'`,
        ))
        .returning();
      if (!done) return null;
      await logActivity(tx as unknown as Db, {
        companyId: job.companyId,
        actorType: job.requestedByActorType === "agent" ? "agent" : job.requestedByActorType === "user" ? "user" : "system",
        actorId: job.requestedByActorId ?? "tool-connection-content-deletion",
        action: "tool_connection.content_deleted",
        entityType: "tool_connection",
        entityId: job.connectionId,
        details: { ...progress.counts },
      });
      return done;
    });
  }

  async function process(jobId: string, signal: AbortSignal, budgetMs = STEP_BUDGET_MS) {
    const startedAt = Date.now();
    let [job] = await db.select().from(toolConnectionContentDeletions).where(eq(toolConnectionContentDeletions.id, jobId));
    if (!job || job.status !== "pending") return job ?? null;
    try {
      while (!signal.aborted) {
        if (readProgress(job).phase === "done") return await complete(job);
        job = await step(job, signal);
        if (Date.now() - startedAt >= budgetMs) return job;
      }
      return job;
    } catch (error) {
      if (error instanceof ProgressConflict) return null;
      await db
        .update(toolConnectionContentDeletions)
        .set({
          attempts: sql`${toolConnectionContentDeletions.attempts} + 1`,
          lastError: error instanceof Error ? error.message.slice(0, 500) : "content deletion failed",
          updatedAt: new Date(),
        })
        .where(and(eq(toolConnectionContentDeletions.id, job.id), eq(toolConnectionContentDeletions.status, "pending")));
      throw error;
    }
  }

  async function processPending(signal: AbortSignal) {
    const rows = await db
      .select({ id: toolConnectionContentDeletions.id })
      .from(toolConnectionContentDeletions)
      .where(eq(toolConnectionContentDeletions.status, "pending"))
      .orderBy(asc(toolConnectionContentDeletions.updatedAt))
      .limit(10);
    let failure: unknown = null;
    for (const { id } of rows) {
      if (signal.aborted) break;
      try {
        await process(id, signal);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  async function nextDeadline() {
    const [row] = await db
      .select({ id: toolConnectionContentDeletions.id })
      .from(toolConnectionContentDeletions)
      .where(eq(toolConnectionContentDeletions.status, "pending"))
      .limit(1);
    return row ? Date.now() : null;
  }

  return { storedContent, latestDeletion, request, process, processPending, nextDeadline };
}

export type ConnectionContentDeletionService = ReturnType<typeof createConnectionContentDeletion>;
