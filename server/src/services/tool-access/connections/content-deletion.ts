import { and, asc, desc, eq, gt, inArray, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import {
  heartbeatRunEvents,
  heartbeatRuns,
  issueThreadInteractions,
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
const RUN_BATCH_SIZE = 20;
const EVENT_BATCH_SIZE = 1000;
const STEP_BUDGET_MS = 10_000;

const SETTLED_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
const UNSETTLED_INVOCATION_STATUSES = ["pending", "authorized", "awaiting_approval", "executing"];
const UNSETTLED_ACTION_REQUEST_STATUSES = ["pending", "approved", "executing"];
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

type Phase = "invocations" | "events" | "appViews" | "invocationRuns" | "eventRuns" | "done";
const PHASES: Phase[] = ["invocations", "events", "appViews", "invocationRuns", "eventRuns", "done"];

type Progress = {
  phase: Phase;
  cursor: { createdAt: string; id: string } | null;
  runCursor: string | null;
  counts: ToolConnectionContentDeletionCounts;
};

type DeletionRow = typeof toolConnectionContentDeletions.$inferSelect;

export type ContentDeletionActor = { actorType: "user" | "agent" | "system"; actorId: string | null };

export function emptyContentDeletionCounts(): ToolConnectionContentDeletionCounts {
  return { toolCalls: 0, approvals: 0, auditEvents: 0, appViews: 0, runs: 0, runsInProgress: 0, itemsInProgress: 0 };
}

function readProgress(row: DeletionRow): Progress {
  const raw = row.progress as Partial<Progress>;
  const counts = { ...emptyContentDeletionCounts(), ...(raw.counts ?? {}) };
  const phase = PHASES.includes(raw.phase as Phase) ? raw.phase as Phase : "invocations";
  return { phase, cursor: raw.cursor ?? null, runCursor: raw.runCursor ?? null, counts };
}

function nextPhase(phase: Phase): Phase {
  return PHASES[Math.min(PHASES.indexOf(phase) + 1, PHASES.length - 1)]!;
}

export function settledRunSql(runId: SQL | typeof toolInvocations.runId): SQL {
  return sql`exists (select 1 from ${heartbeatRuns} r where r.id = ${runId}
    and r.status in (${sql.join(SETTLED_RUN_STATUSES.map((status) => sql`${status}`), sql`, `)})
    and r.finished_at is not null
    and r.cost_accounting_pending = false
    and not exists (select 1 from native_run_finalizations f where f.run_id = r.id
      and f.phase not in ('committed', 'terminal_failure', 'applied')))`;
}

function clearedSummary(column: SQL | typeof toolInvocations.resultSummary, deletedAt: string): SQL {
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

export function createConnectionContentDeletion(db: Db, deps: { runLogStore: () => RunLogStore }) {
  async function storedContent(connection: { id: string; companyId: string }): Promise<ToolConnectionStoredContent> {
    const [stored] = await db
      .select({
        toolCalls: sql<number>`count(*)::int`,
        runs: sql<number>`count(distinct ${toolInvocations.runId}) filter (where ${toolInvocations.runId} is not null)::int`,
        runsInProgress: sql<number>`count(distinct ${toolInvocations.runId}) filter (where ${toolInvocations.runId} is not null and not ${settledRunSql(toolInvocations.runId)})::int`,
      })
      .from(toolInvocations)
      .where(and(
        eq(toolInvocations.companyId, connection.companyId),
        eq(toolInvocations.connectionId, connection.id),
        sql`coalesce(${toolInvocations.resultSummary}->>'contentDeletedAt', ${toolInvocations.argumentsSummary}->>'contentDeletedAt') is null`,
        sql`(${toolInvocations.resultSummary} is not null or ${toolInvocations.argumentsSummary} is not null)`,
      ));
    const [latest] = await db
      .select()
      .from(toolConnectionContentDeletions)
      .where(and(
        eq(toolConnectionContentDeletions.companyId, connection.companyId),
        eq(toolConnectionContentDeletions.connectionId, connection.id),
      ))
      .orderBy(desc(toolConnectionContentDeletions.createdAt))
      .limit(1);
    return {
      stored: { toolCalls: stored?.toolCalls ?? 0, runs: stored?.runs ?? 0, runsInProgress: stored?.runsInProgress ?? 0 },
      deletion: latest ? toDeletion(latest) : null,
    };
  }

  async function request(connection: { id: string; companyId: string }, actor: ContentDeletionActor) {
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(toolConnectionContentDeletions)
        .where(and(
          eq(toolConnectionContentDeletions.companyId, connection.companyId),
          eq(toolConnectionContentDeletions.connectionId, connection.id),
          eq(toolConnectionContentDeletions.status, "pending"),
        ))
        .limit(1);
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
          progress: { phase: "invocations", cursor: null, runCursor: null, counts: emptyContentDeletionCounts() },
        })
        .onConflictDoNothing()
        .returning();
      if (created) return { deletion: toDeletion(created), created: true };
      const [raced] = await tx
        .select()
        .from(toolConnectionContentDeletions)
        .where(and(
          eq(toolConnectionContentDeletions.companyId, connection.companyId),
          eq(toolConnectionContentDeletions.connectionId, connection.id),
          eq(toolConnectionContentDeletions.status, "pending"),
        ))
        .limit(1);
      return { deletion: toDeletion(raced!), created: false };
    });
  }

  async function runSettlement(runIds: string[]) {
    if (runIds.length === 0) return new Set<string>();
    const rows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(inArray(heartbeatRuns.id, runIds), settledRunSql(sql`${heartbeatRuns.id}`)));
    return new Set(rows.map((row) => row.id));
  }

  async function invocationsStep(job: DeletionRow, progress: Progress, deletedAt: string) {
    const cursor = progress.cursor;
    const page = await db
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
    if (page.length === 0) return { done: true };
    const settledRuns = await runSettlement([...new Set(page.flatMap((row) => row.runId ? [row.runId] : []))]);
    const eligible = page.filter((row) => !UNSETTLED_INVOCATION_STATUSES.includes(row.status) && (!row.runId || settledRuns.has(row.runId)));
    progress.counts.itemsInProgress += page.length - eligible.length;
    const ids = eligible.map((row) => row.id);
    if (ids.length > 0) {
      const cleared = await db
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
      const requests = await db
        .update(toolActionRequests)
        .set({
          canonicalArgumentsSummary: clearedSummary(sql`${toolActionRequests.canonicalArgumentsSummary}`, deletedAt) as never,
          previewMarkdown: null,
          signedArguments: null,
        })
        .where(and(
          eq(toolActionRequests.companyId, job.companyId),
          inArray(toolActionRequests.invocationId, ids),
          sql`${toolActionRequests.status} not in (${sql.join(UNSETTLED_ACTION_REQUEST_STATUSES.map((status) => sql`${status}`), sql`, `)})`,
          sql`${toolActionRequests.canonicalArgumentsSummary}->>'contentDeletedAt' is null`,
        ))
        .returning({ id: toolActionRequests.id, interactionId: toolActionRequests.interactionId });
      progress.counts.approvals += requests.length;
      const interactionIds = requests.flatMap((row) => row.interactionId ? [row.interactionId] : []);
      if (interactionIds.length > 0) {
        await db
          .update(issueThreadInteractions)
          .set({
            payload: sql`case when jsonb_typeof(${issueThreadInteractions.payload}->'toolAction') = 'object'
              then jsonb_set(jsonb_set(${issueThreadInteractions.payload} - 'detailsMarkdown', '{toolAction,previewMarkdown}', 'null'::jsonb), '{toolAction,argumentsSummaryJson}', 'null'::jsonb)
              else ${issueThreadInteractions.payload} - 'detailsMarkdown' end` as never,
            result: sql`case when jsonb_typeof(${issueThreadInteractions.result}->'toolAction') = 'object'
              then jsonb_set(${issueThreadInteractions.result}, '{toolAction,resultSummary}', 'null'::jsonb)
              else ${issueThreadInteractions.result} end` as never,
          })
          .where(and(eq(issueThreadInteractions.companyId, job.companyId), inArray(issueThreadInteractions.id, interactionIds)));
      }
    }
    const last = page[page.length - 1]!;
    progress.cursor = { createdAt: last.createdAt.toISOString(), id: last.id };
    return { done: page.length < BATCH_SIZE };
  }

  async function eventsStep(job: DeletionRow, progress: Progress, deletedAt: string) {
    const cursor = progress.cursor;
    const page = await db
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
    if (page.length === 0) return { done: true };
    const settledRuns = await runSettlement([...new Set(page.flatMap((row) => row.runId ? [row.runId] : []))]);
    const ids = page.filter((row) => !row.runId || settledRuns.has(row.runId)).map((row) => row.id);
    progress.counts.itemsInProgress += page.length - ids.length;
    if (ids.length > 0) {
      const cleared = await db
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
    return { done: page.length < BATCH_SIZE };
  }

  async function appViewsStep(job: DeletionRow, progress: Progress) {
    const page = await db
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
    if (page.length === 0) return { done: true };
    const settledRuns = await runSettlement([...new Set(page.flatMap((row) => row.runId ? [row.runId] : []))]);
    const ids = page.filter((row) => !row.runId || settledRuns.has(row.runId)).map((row) => row.id);
    progress.counts.itemsInProgress += page.length - ids.length;
    if (ids.length > 0) {
      const removed = await db
        .delete(toolMcpAppViews)
        .where(and(eq(toolMcpAppViews.companyId, job.companyId), inArray(toolMcpAppViews.id, ids)))
        .returning({ id: toolMcpAppViews.id });
      progress.counts.appViews += removed.length;
    }
    const last = page[page.length - 1]!;
    progress.runCursor = last.id;
    return { done: page.length < BATCH_SIZE };
  }

  async function deleteRunTranscript(companyId: string, runId: string, signal: AbortSignal) {
    let changed = false;
    let afterId = 0;
    for (;;) {
      signal.throwIfAborted();
      const batch = await db
        .select({ id: heartbeatRunEvents.id })
        .from(heartbeatRunEvents)
        .where(and(
          eq(heartbeatRunEvents.companyId, companyId),
          eq(heartbeatRunEvents.runId, runId),
          gt(heartbeatRunEvents.id, afterId),
        ))
        .orderBy(asc(heartbeatRunEvents.id))
        .limit(EVENT_BATCH_SIZE);
      if (batch.length === 0) break;
      const ids = batch.map((row) => row.id);
      const cleared = await db
        .update(heartbeatRunEvents)
        .set({ message: null, payload: null as never })
        .where(and(
          inArray(heartbeatRunEvents.id, ids),
          sql`${heartbeatRunEvents.eventType} not in (${sql.join(STRUCTURAL_EVENT_TYPES.map((type) => sql`${type}`), sql`, `)})`,
          sql`${heartbeatRunEvents.eventType} not like 'native.%'`,
          sql`not (${heartbeatRunEvents.eventType} = 'item.completed' and (${heartbeatRunEvents.payload} -> 'prpEvent' -> 'payload' ->> 'kind') = 'usage')`,
          sql`(${heartbeatRunEvents.message} is not null or ${heartbeatRunEvents.payload} is not null)`,
        ))
        .returning({ id: heartbeatRunEvents.id });
      if (cleared.length > 0) changed = true;
      afterId = ids[ids.length - 1]!;
      if (batch.length < EVENT_BATCH_SIZE) break;
    }
    const excerpts = await db
      .update(heartbeatRuns)
      .set({ stdoutExcerpt: null, stderrExcerpt: null })
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, companyId),
        sql`(${heartbeatRuns.stdoutExcerpt} is not null or ${heartbeatRuns.stderrExcerpt} is not null)`,
      ))
      .returning({ id: heartbeatRuns.id });
    if (excerpts.length > 0) changed = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      const [run] = await db
        .select({ logStore: heartbeatRuns.logStore, logRef: heartbeatRuns.logRef })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
      if (!run?.logStore || !run.logRef) break;
      if (isRunLogStoreType(run.logStore)) {
        const handle: RunLogHandle = { store: run.logStore, logRef: run.logRef };
        await deps.runLogStore().remove!(handle, signal);
      }
      const updated = await db
        .update(heartbeatRuns)
        .set({ logStore: null, logRef: null })
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.logRef, run.logRef)))
        .returning({ id: heartbeatRuns.id });
      changed = true;
      if (updated.length > 0) break;
    }
    return changed;
  }

  async function runsStep(job: DeletionRow, progress: Progress, source: "invocations" | "events", signal: AbortSignal) {
    const table = source === "invocations" ? toolInvocations : toolCallEvents;
    const page = await db
      .selectDistinct({ runId: table.runId })
      .from(table)
      .where(and(
        eq(table.companyId, job.companyId),
        isNotNull(table.runId),
        progress.runCursor ? gt(table.runId, progress.runCursor) : undefined,
        eq(table.connectionId, job.connectionId),
        lte(table.createdAt, job.requestedAt),
      ))
      .orderBy(asc(table.runId))
      .limit(RUN_BATCH_SIZE);
    const runIds = page.flatMap((row) => row.runId ? [row.runId] : []);
    if (runIds.length === 0) return { done: true };
    const settled = await runSettlement(runIds);
    for (const runId of runIds) {
      if (!settled.has(runId)) {
        if (source === "invocations") progress.counts.runsInProgress += 1;
      } else if (await deleteRunTranscript(job.companyId, runId, signal)) {
        progress.counts.runs += 1;
      }
      progress.runCursor = runId;
    }
    return { done: runIds.length < RUN_BATCH_SIZE };
  }

  async function saveProgress(job: DeletionRow, progress: Progress) {
    const [saved] = await db
      .update(toolConnectionContentDeletions)
      .set({ progress: progress as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(and(
        eq(toolConnectionContentDeletions.id, job.id),
        eq(toolConnectionContentDeletions.status, "pending"),
        eq(toolConnectionContentDeletions.updatedAt, job.updatedAt),
      ))
      .returning();
    return saved ?? null;
  }

  async function complete(job: DeletionRow, progress: Progress) {
    const now = new Date();
    return db.transaction(async (tx) => {
      const [done] = await tx
        .update(toolConnectionContentDeletions)
        .set({ status: "completed", progress: progress as unknown as Record<string, unknown>, completedAt: now, updatedAt: now, lastError: null })
        .where(and(
          eq(toolConnectionContentDeletions.id, job.id),
          eq(toolConnectionContentDeletions.status, "pending"),
          eq(toolConnectionContentDeletions.updatedAt, job.updatedAt),
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
        const progress = readProgress(job);
        if (progress.phase === "done") return await complete(job, progress);
        const deletedAt = job.requestedAt.toISOString();
        const result = progress.phase === "invocations" ? await invocationsStep(job, progress, deletedAt)
          : progress.phase === "events" ? await eventsStep(job, progress, deletedAt)
            : progress.phase === "appViews" ? await appViewsStep(job, progress)
              : await runsStep(job, progress, progress.phase === "invocationRuns" ? "invocations" : "events", signal);
        if (result.done) {
          progress.phase = nextPhase(progress.phase);
          progress.cursor = null;
          progress.runCursor = null;
        }
        const saved = await saveProgress(job, progress);
        if (!saved) return null;
        job = saved;
        if (Date.now() - startedAt >= budgetMs) return job;
      }
      return job;
    } catch (error) {
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

  async function pendingJobIds(limit = 10) {
    const rows = await db
      .select({ id: toolConnectionContentDeletions.id })
      .from(toolConnectionContentDeletions)
      .where(eq(toolConnectionContentDeletions.status, "pending"))
      .orderBy(asc(toolConnectionContentDeletions.requestedAt))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async function processPending(signal: AbortSignal) {
    let failure: unknown = null;
    for (const id of await pendingJobIds()) {
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

  return { storedContent, request, process, processPending, nextDeadline };
}

export type ConnectionContentDeletionService = ReturnType<typeof createConnectionContentDeletion>;
