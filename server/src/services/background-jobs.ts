import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  backgroundJobCostEvents,
  backgroundJobEvents,
  backgroundJobRuns,
  backgroundJobs,
} from "@paperclipai/db";
import type {
  BackgroundJob,
  BackgroundJobCostEvent,
  BackgroundJobEvent,
  BackgroundJobRun,
} from "@paperclipai/shared";
import {
  completeBackgroundJobRunSchema,
  createBackgroundJobEventSchema,
  createBackgroundJobRunSchema,
  createBackgroundJobSchema,
  listBackgroundJobRunsQuerySchema,
  listBackgroundJobsQuerySchema,
  updateBackgroundJobRunProgressSchema,
  type CompleteBackgroundJobRun,
  type CreateBackgroundJob,
  type CreateBackgroundJobEvent,
  type CreateBackgroundJobRun,
  type ListBackgroundJobRunsQuery,
  type ListBackgroundJobsQuery,
  type UpdateBackgroundJobRunProgress,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

export interface BackgroundJobActor {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
}

type JobRow = typeof backgroundJobs.$inferSelect;
type RunRow = typeof backgroundJobRuns.$inferSelect;
type EventRow = typeof backgroundJobEvents.$inferSelect;
type CostEventRow = typeof backgroundJobCostEvents.$inferSelect;

function mapJob(row: JobRow): BackgroundJob {
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    jobType: row.jobType,
    displayName: row.displayName,
    description: row.description ?? null,
    backendKind: row.backendKind,
    status: row.status,
    config: row.config ?? {},
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    sourceIssueId: row.sourceIssueId ?? null,
    sourceProjectId: row.sourceProjectId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRun(row: RunRow): BackgroundJobRun {
  return {
    id: row.id,
    companyId: row.companyId,
    jobId: row.jobId ?? null,
    jobKey: row.jobKey,
    jobType: row.jobType,
    trigger: row.trigger,
    status: row.status,
    requestedByActorType: row.requestedByActorType as BackgroundJobRun["requestedByActorType"],
    requestedByActorId: row.requestedByActorId,
    requestedByAgentId: row.requestedByAgentId ?? null,
    requestedByUserId: row.requestedByUserId ?? null,
    sourceIssueId: row.sourceIssueId ?? null,
    sourceProjectId: row.sourceProjectId ?? null,
    sourceAgentId: row.sourceAgentId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    totalItems: row.totalItems ?? null,
    processedItems: row.processedItems,
    succeededItems: row.succeededItems,
    failedItems: row.failedItems,
    skippedItems: row.skippedItems,
    progressPercent: row.progressPercent ?? null,
    currentItem: row.currentItem ?? null,
    cancellationRequestedAt: row.cancellationRequestedAt ?? null,
    cancelledAt: row.cancelledAt ?? null,
    error: row.error ?? null,
    result:
      typeof row.result === "object" && row.result !== null && !Array.isArray(row.result)
        ? (row.result as Record<string, unknown>)
        : null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    durationMs: row.durationMs ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapEvent(row: EventRow): BackgroundJobEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    runId: row.runId,
    eventType: row.eventType,
    level: row.level,
    message: row.message ?? null,
    progressPercent: row.progressPercent ?? null,
    totalItems: row.totalItems ?? null,
    processedItems: row.processedItems ?? null,
    succeededItems: row.succeededItems ?? null,
    failedItems: row.failedItems ?? null,
    skippedItems: row.skippedItems ?? null,
    currentItem: row.currentItem ?? null,
    details:
      typeof row.details === "object" && row.details !== null && !Array.isArray(row.details)
        ? (row.details as Record<string, unknown>)
        : null,
    createdAt: row.createdAt,
  };
}

function mapCostEvent(row: CostEventRow): BackgroundJobCostEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    runId: row.runId,
    costEventId: row.costEventId,
    createdAt: row.createdAt,
  };
}

function calculateProgressPercent(processedItems: number, totalItems: number | null | undefined) {
  if (!totalItems || totalItems <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((processedItems / totalItems) * 100)));
}

export function backgroundJobService(db: Db) {
  async function getRunRow(runId: string): Promise<RunRow> {
    const run = await db
      .select()
      .from(backgroundJobRuns)
      .where(eq(backgroundJobRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) throw notFound("Background job run not found");
    return run;
  }

  return {
    createOrUpdateJob: async (
      companyId: string,
      data: CreateBackgroundJob,
      actor: BackgroundJobActor,
    ): Promise<BackgroundJob> => {
      const parsed = createBackgroundJobSchema.parse(data);
      const existing = await db
        .select()
        .from(backgroundJobs)
        .where(and(eq(backgroundJobs.companyId, companyId), eq(backgroundJobs.key, parsed.key)))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        const [row] = await db
          .update(backgroundJobs)
          .set({
            jobType: parsed.jobType,
            displayName: parsed.displayName,
            description: parsed.description ?? null,
            backendKind: parsed.backendKind,
            status: parsed.status,
            config: parsed.config,
            sourceIssueId: parsed.sourceIssueId ?? null,
            sourceProjectId: parsed.sourceProjectId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(backgroundJobs.id, existing.id))
          .returning();
        return mapJob(row);
      }

      const [row] = await db
        .insert(backgroundJobs)
        .values({
          companyId,
          key: parsed.key,
          jobType: parsed.jobType,
          displayName: parsed.displayName,
          description: parsed.description ?? null,
          backendKind: parsed.backendKind,
          status: parsed.status,
          config: parsed.config,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          sourceIssueId: parsed.sourceIssueId ?? null,
          sourceProjectId: parsed.sourceProjectId ?? null,
        })
        .returning();
      return mapJob(row);
    },

    listJobs: async (companyId: string, query: ListBackgroundJobsQuery): Promise<BackgroundJob[]> => {
      const parsed = listBackgroundJobsQuerySchema.parse(query);
      const conditions = [eq(backgroundJobs.companyId, companyId)];
      if (parsed.jobType) conditions.push(eq(backgroundJobs.jobType, parsed.jobType));
      if (parsed.status) conditions.push(eq(backgroundJobs.status, parsed.status));
      const rows = await db
        .select()
        .from(backgroundJobs)
        .where(and(...conditions))
        .orderBy(desc(backgroundJobs.createdAt))
        .limit(parsed.limit);
      return rows.map(mapJob);
    },

    getJob: async (companyId: string, jobId: string): Promise<BackgroundJob> => {
      const row = await db
        .select()
        .from(backgroundJobs)
        .where(and(eq(backgroundJobs.companyId, companyId), eq(backgroundJobs.id, jobId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Background job not found");
      return mapJob(row);
    },

    createRun: async (
      companyId: string,
      data: CreateBackgroundJobRun,
      actor: BackgroundJobActor,
    ): Promise<BackgroundJobRun> => {
      const parsed = createBackgroundJobRunSchema.parse(data);
      let job: JobRow | null = null;
      if (parsed.jobId) {
        job = await db
          .select()
          .from(backgroundJobs)
          .where(and(eq(backgroundJobs.companyId, companyId), eq(backgroundJobs.id, parsed.jobId)))
          .then((rows) => rows[0] ?? null);
        if (!job) throw notFound("Background job not found");
      }
      if (job?.status === "archived") throw conflict("Archived background jobs cannot be run");
      if (job?.status === "paused") throw conflict("Paused background jobs cannot be run");

      const jobKey = job?.key ?? parsed.jobKey;
      const jobType = job?.jobType ?? parsed.jobType;
      if (!jobKey || !jobType) {
        throw unprocessable("Background job run requires job key and type");
      }

      const [row] = await db
        .insert(backgroundJobRuns)
        .values({
          companyId,
          jobId: job?.id ?? null,
          jobKey,
          jobType,
          trigger: parsed.trigger,
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          requestedByAgentId: actor.agentId ?? null,
          requestedByUserId: actor.userId ?? null,
          sourceIssueId: parsed.sourceIssueId ?? job?.sourceIssueId ?? null,
          sourceProjectId: parsed.sourceProjectId ?? job?.sourceProjectId ?? null,
          sourceAgentId: parsed.sourceAgentId ?? null,
          heartbeatRunId: parsed.heartbeatRunId ?? null,
          totalItems: parsed.totalItems ?? null,
          progressPercent: calculateProgressPercent(0, parsed.totalItems ?? null),
        })
        .returning();
      await db.insert(backgroundJobEvents).values({
        companyId,
        runId: row.id,
        eventType: "queued",
        level: "info",
        message: "Job run queued",
        totalItems: parsed.totalItems ?? null,
        processedItems: 0,
        progressPercent: calculateProgressPercent(0, parsed.totalItems ?? null),
      });
      return mapRun(row);
    },

    startRun: async (runId: string): Promise<BackgroundJobRun> => {
      const current = await getRunRow(runId);
      if (current.status !== "queued") throw conflict("Only queued background job runs can be started");
      const now = new Date();
      const [row] = await db
        .update(backgroundJobRuns)
        .set({ status: "running", startedAt: now, updatedAt: now })
        .where(eq(backgroundJobRuns.id, runId))
        .returning();
      await db.insert(backgroundJobEvents).values({
        companyId: row.companyId,
        runId,
        eventType: "started",
        level: "info",
        message: "Job run started",
        totalItems: row.totalItems ?? null,
        processedItems: row.processedItems,
        progressPercent: row.progressPercent ?? null,
      });
      return mapRun(row);
    },

    updateRunProgress: async (
      runId: string,
      data: UpdateBackgroundJobRunProgress,
    ): Promise<BackgroundJobRun> => {
      const parsed = updateBackgroundJobRunProgressSchema.parse(data);
      const current = await getRunRow(runId);
      if (current.status !== "running") throw conflict("Only running background job runs can report progress");
      const nextProcessed = parsed.processedItems ?? current.processedItems;
      const nextTotal = parsed.totalItems === undefined ? current.totalItems : parsed.totalItems;
      const progressPercent =
        parsed.progressPercent === undefined
          ? calculateProgressPercent(nextProcessed, nextTotal)
          : parsed.progressPercent;
      const [row] = await db
        .update(backgroundJobRuns)
        .set({
          totalItems: nextTotal ?? null,
          processedItems: nextProcessed,
          succeededItems: parsed.succeededItems ?? current.succeededItems,
          failedItems: parsed.failedItems ?? current.failedItems,
          skippedItems: parsed.skippedItems ?? current.skippedItems,
          progressPercent,
          currentItem: parsed.currentItem === undefined ? current.currentItem : parsed.currentItem,
          updatedAt: new Date(),
        })
        .where(eq(backgroundJobRuns.id, runId))
        .returning();
      await db.insert(backgroundJobEvents).values({
        companyId: row.companyId,
        runId,
        eventType: "progress",
        level: "info",
        message: row.currentItem,
        progressPercent: row.progressPercent ?? null,
        totalItems: row.totalItems ?? null,
        processedItems: row.processedItems,
        succeededItems: row.succeededItems,
        failedItems: row.failedItems,
        skippedItems: row.skippedItems,
        currentItem: row.currentItem ?? null,
      });
      return mapRun(row);
    },

    appendEvent: async (runId: string, data: CreateBackgroundJobEvent): Promise<BackgroundJobEvent> => {
      const run = await getRunRow(runId);
      const parsed = createBackgroundJobEventSchema.parse(data);
      const [row] = await db
        .insert(backgroundJobEvents)
        .values({
          companyId: run.companyId,
          runId,
          eventType: parsed.eventType,
          level: parsed.level,
          message: parsed.message ?? null,
          progressPercent: parsed.progressPercent ?? null,
          totalItems: parsed.totalItems ?? null,
          processedItems: parsed.processedItems ?? null,
          succeededItems: parsed.succeededItems ?? null,
          failedItems: parsed.failedItems ?? null,
          skippedItems: parsed.skippedItems ?? null,
          currentItem: parsed.currentItem ?? null,
          details: parsed.details ?? null,
        })
        .returning();
      return mapEvent(row);
    },

    completeRun: async (runId: string, data: CompleteBackgroundJobRun): Promise<BackgroundJobRun> => {
      const parsed = completeBackgroundJobRunSchema.parse(data);
      const current = await getRunRow(runId);
      if (!["queued", "running"].includes(current.status)) {
        throw conflict("Background job run is already terminal");
      }
      const finishedAt = new Date();
      const durationMs = current.startedAt ? finishedAt.getTime() - current.startedAt.getTime() : null;
      const [row] = await db
        .update(backgroundJobRuns)
        .set({
          status: parsed.status,
          error: parsed.error ?? null,
          result: parsed.result ?? null,
          progressPercent: parsed.status === "succeeded" ? 100 : current.progressPercent,
          cancelledAt: parsed.status === "cancelled" ? finishedAt : current.cancelledAt,
          finishedAt,
          durationMs,
          updatedAt: finishedAt,
        })
        .where(eq(backgroundJobRuns.id, runId))
        .returning();
      await db.insert(backgroundJobEvents).values({
        companyId: row.companyId,
        runId,
        eventType: parsed.status === "succeeded" ? "completed" : parsed.status,
        level: parsed.status === "failed" ? "error" : "info",
        message: parsed.error ?? `Job run ${parsed.status}`,
        progressPercent: row.progressPercent ?? null,
        totalItems: row.totalItems ?? null,
        processedItems: row.processedItems,
        succeededItems: row.succeededItems,
        failedItems: row.failedItems,
        skippedItems: row.skippedItems,
        details: parsed.result ?? null,
      });
      return mapRun(row);
    },

    requestCancelRun: async (companyId: string, runId: string): Promise<BackgroundJobRun> => {
      const current = await getRunRow(runId);
      if (current.companyId !== companyId) throw notFound("Background job run not found");
      if (!["queued", "running"].includes(current.status)) return mapRun(current);
      const now = new Date();
      const [row] = await db
        .update(backgroundJobRuns)
        .set({ cancellationRequestedAt: now, updatedAt: now })
        .where(eq(backgroundJobRuns.id, runId))
        .returning();
      await db.insert(backgroundJobEvents).values({
        companyId,
        runId,
        eventType: "log",
        level: "warn",
        message: "Cancellation requested",
      });
      return mapRun(row);
    },

    isCancellationRequested: async (runId: string): Promise<boolean> => {
      const run = await getRunRow(runId);
      return Boolean(run.cancellationRequestedAt);
    },

    linkCostEvent: async (companyId: string, runId: string, costEventId: string): Promise<BackgroundJobCostEvent> => {
      const run = await getRunRow(runId);
      if (run.companyId !== companyId) throw notFound("Background job run not found");
      const [row] = await db
        .insert(backgroundJobCostEvents)
        .values({ companyId, runId, costEventId })
        .onConflictDoNothing()
        .returning();
      return row ? mapCostEvent(row) : {
        id: "",
        companyId,
        runId,
        costEventId,
        createdAt: new Date(),
      };
    },

    listRuns: async (companyId: string, query: ListBackgroundJobRunsQuery): Promise<BackgroundJobRun[]> => {
      const parsed = listBackgroundJobRunsQuerySchema.parse(query);
      const conditions = [eq(backgroundJobRuns.companyId, companyId)];
      if (parsed.jobId) conditions.push(eq(backgroundJobRuns.jobId, parsed.jobId));
      if (parsed.jobType) conditions.push(eq(backgroundJobRuns.jobType, parsed.jobType));
      if (parsed.status) conditions.push(eq(backgroundJobRuns.status, parsed.status));
      if (parsed.sourceIssueId) conditions.push(eq(backgroundJobRuns.sourceIssueId, parsed.sourceIssueId));
      if (parsed.sourceProjectId) conditions.push(eq(backgroundJobRuns.sourceProjectId, parsed.sourceProjectId));
      const rows = await db
        .select()
        .from(backgroundJobRuns)
        .where(and(...conditions))
        .orderBy(desc(backgroundJobRuns.createdAt))
        .limit(parsed.limit);
      return rows.map(mapRun);
    },

    getRun: async (companyId: string, runId: string): Promise<BackgroundJobRun> => {
      const row = await getRunRow(runId);
      if (row.companyId !== companyId) throw notFound("Background job run not found");
      return mapRun(row);
    },

    listRunEvents: async (companyId: string, runId: string, limit = 200): Promise<BackgroundJobEvent[]> => {
      const run = await getRunRow(runId);
      if (run.companyId !== companyId) throw notFound("Background job run not found");
      const rows = await db
        .select()
        .from(backgroundJobEvents)
        .where(eq(backgroundJobEvents.runId, runId))
        .orderBy(desc(backgroundJobEvents.createdAt))
        .limit(Math.min(Math.max(limit, 1), 500));
      return rows.reverse().map(mapEvent);
    },
  };
}

export type BackgroundJobService = ReturnType<typeof backgroundJobService>;
