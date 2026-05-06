import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRunEvents,
  issueWorkProducts,
  issues,
  rt2V33DomainEvents,
  rt2V33ExecutionAttempts,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import type {
  CancelRt2Execution,
  ClaimRt2Execution,
  CleanupRt2Executions,
  CompleteRt2Execution,
  DispatchNextRt2Execution,
  DispatchRt2Execution,
  EnqueueRt2Execution,
  FailRt2Execution,
  Rt2DomainEventType,
  Rt2ExecutionSummary,
  Rt2ExecutionTimelineEvent,
  StartRt2Execution,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { rt2DomainEventService } from "./rt2-domain-events.js";
import { rt2TaskEngineService } from "./rt2-task-engine.js";

type ExecutionAttemptRow = typeof rt2V33ExecutionAttempts.$inferSelect;
type ExecutionAttemptPatch = Partial<typeof rt2V33ExecutionAttempts.$inferInsert>;

const terminalRetryableStates = new Set(["failed", "cancelled", "blocked"]);
const runtimeActiveStates = ["dispatched", "claimed", "running"];
const startableStates = ["dispatched", "claimed"];

function normalizeExecutionState(state: string): Rt2ExecutionSummary["state"] {
  return (state === "claimed" ? "dispatched" : state) as Rt2ExecutionSummary["state"];
}

function toExecutionSummary(row: ExecutionAttemptRow): Rt2ExecutionSummary {
  return {
    id: row.id,
    taskIssueId: row.taskIssueId,
    todoIssueId: row.todoIssueId ?? null,
    state: normalizeExecutionState(row.state),
    executorType: row.executorType as "user" | "jarvis" | "runtime" | null,
    executorId: row.executorId ?? null,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    runtimeServiceId: row.runtimeServiceId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    deliverableWorkProductId: row.deliverableWorkProductId ?? null,
    resultWorkProductId: row.resultWorkProductId ?? null,
    retryOfAttemptId: row.retryOfAttemptId ?? null,
    failureReason: row.failureReason ?? null,
    missingDeliverableReason: row.missingDeliverableReason ?? null,
    queuedAt: row.queuedAt,
    claimedAt: row.claimedAt ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    updatedAt: row.updatedAt,
    latestTimelineEvent: null,
  };
}

function domainEventKind(eventType: string): Rt2ExecutionTimelineEvent["kind"] {
  return eventType.includes("stale_cleaned") ? "cleanup" : "lifecycle";
}

function heartbeatEventKind(eventType: string): Rt2ExecutionTimelineEvent["kind"] {
  const normalized = eventType.toLowerCase();
  if (normalized.includes("tool")) return "tool";
  if (normalized.includes("message")) return "message";
  if (normalized.includes("progress") || normalized.includes("output")) return "progress";
  return "message";
}

function newerTimelineEvent(
  current: Rt2ExecutionTimelineEvent | null,
  candidate: Rt2ExecutionTimelineEvent,
): Rt2ExecutionTimelineEvent {
  if (!current) return candidate;
  const currentTime = current.createdAt.getTime();
  const candidateTime = candidate.createdAt.getTime();
  if (candidateTime > currentTime) return candidate;
  if (candidateTime === currentTime && (candidate.seq ?? 0) > (current.seq ?? 0)) return candidate;
  return current;
}

function toDomainTimelineEvent(event: typeof rt2V33DomainEvents.$inferSelect): Rt2ExecutionTimelineEvent {
  return {
    id: event.id,
    source: "rt2_domain_event",
    kind: domainEventKind(event.eventType),
    type: event.eventType,
    message: null,
    seq: null,
    payload: event.payload ?? null,
    createdAt: event.occurredAt,
  };
}

function toHeartbeatTimelineEvent(event: typeof heartbeatRunEvents.$inferSelect): Rt2ExecutionTimelineEvent {
  return {
    id: `heartbeat:${event.id}`,
    source: "heartbeat",
    kind: heartbeatEventKind(event.eventType),
    type: event.eventType,
    message: event.message ?? null,
    seq: event.seq,
    payload: event.payload ?? null,
    createdAt: event.createdAt,
  };
}

export function rt2TaskExecutionService(db: Db) {
  const taskSvc = rt2TaskEngineService(db);
  const domainEvents = rt2DomainEventService(db);

  async function getAttempt(attemptId: string) {
    const attempt = await db
      .select()
      .from(rt2V33ExecutionAttempts)
      .where(eq(rt2V33ExecutionAttempts.id, attemptId))
      .then((rows) => rows[0] ?? null);
    if (!attempt) {
      throw notFound("RT2 execution attempt not found");
    }
    return attempt;
  }

  async function assertTodoBelongsToTask(todoIssueId: string, taskIssueId: string, companyId: string) {
    const todo = await db
      .select({ id: issues.id, parentId: issues.parentId, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, todoIssueId))
      .then((rows) => rows[0] ?? null);

    if (!todo || todo.companyId !== companyId || todo.parentId !== taskIssueId) {
      throw conflict("RT2_EXECUTION_TODO_MUST_BELONG_TO_TASK");
    }
  }

  async function assertWorkProductInScope(
    workProductId: string,
    companyId: string,
    allowedIssueIds: string[],
    errorCode: string,
  ) {
    const workProduct = await db
      .select({
        id: issueWorkProducts.id,
        companyId: issueWorkProducts.companyId,
        issueId: issueWorkProducts.issueId,
      })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, workProductId))
      .then((rows) => rows[0] ?? null);

    if (!workProduct || workProduct.companyId !== companyId || !allowedIssueIds.includes(workProduct.issueId)) {
      throw conflict(errorCode);
    }
  }

  async function assertRuntimeCanAccept(companyId: string, input: DispatchRt2Execution) {
    if (!input.runtimeServiceId) return;

    const runtime = await db
      .select()
      .from(workspaceRuntimeServices)
      .where(and(
        eq(workspaceRuntimeServices.id, input.runtimeServiceId),
        eq(workspaceRuntimeServices.companyId, companyId),
      ))
      .then((rows) => rows[0] ?? null);

    if (!runtime || runtime.status !== "running" || runtime.healthStatus === "unhealthy") {
      throw conflict("RT2_EXECUTION_RUNTIME_NOT_AVAILABLE");
    }

    if (input.runtimeFreshnessSeconds) {
      const staleBefore = new Date(Date.now() - input.runtimeFreshnessSeconds * 1000);
      if (runtime.lastUsedAt < staleBefore) {
        throw conflict("RT2_EXECUTION_RUNTIME_STALE");
      }
    }

    const capacity = input.capacity ?? 1;
    const active = await db
      .select({ id: rt2V33ExecutionAttempts.id })
      .from(rt2V33ExecutionAttempts)
      .where(and(
        eq(rt2V33ExecutionAttempts.runtimeServiceId, input.runtimeServiceId),
        inArray(rt2V33ExecutionAttempts.state, runtimeActiveStates),
      ))
      .limit(capacity);

    if (active.length >= capacity) {
      throw conflict("RT2_EXECUTION_RUNTIME_CAPACITY_EXCEEDED");
    }
  }

  async function updateState(
    attemptId: string,
    expectedState: string | string[],
    patch: ExecutionAttemptPatch,
    conflictCode: string,
  ) {
    const expectedStates = Array.isArray(expectedState) ? expectedState : [expectedState];
    const [updated] = await db
      .update(rt2V33ExecutionAttempts)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(rt2V33ExecutionAttempts.id, attemptId),
          inArray(rt2V33ExecutionAttempts.state, expectedStates),
        ),
      )
      .returning();

    if (!updated) {
      await getAttempt(attemptId);
      throw conflict(conflictCode);
    }

    return toExecutionSummary(updated);
  }

  async function buildTimelineEvents(attempt: ExecutionAttemptRow): Promise<Rt2ExecutionTimelineEvent[]> {
    const [domainRows, heartbeatRows] = await Promise.all([
      db
        .select()
        .from(rt2V33DomainEvents)
        .where(and(
          eq(rt2V33DomainEvents.companyId, attempt.companyId),
          eq(rt2V33DomainEvents.entityType, "execution"),
          eq(rt2V33DomainEvents.entityId, attempt.id),
        ))
        .orderBy(asc(rt2V33DomainEvents.occurredAt), asc(rt2V33DomainEvents.createdAt)),
      attempt.heartbeatRunId
        ? db
          .select()
          .from(heartbeatRunEvents)
          .where(and(
            eq(heartbeatRunEvents.companyId, attempt.companyId),
            eq(heartbeatRunEvents.runId, attempt.heartbeatRunId),
          ))
          .orderBy(asc(heartbeatRunEvents.seq), asc(heartbeatRunEvents.createdAt))
        : Promise.resolve([]),
    ]);

    return [
      ...domainRows.map(toDomainTimelineEvent),
      ...heartbeatRows.map(toHeartbeatTimelineEvent),
    ].sort((left, right) => {
      const timeDelta = left.createdAt.getTime() - right.createdAt.getTime();
      return timeDelta !== 0 ? timeDelta : (left.seq ?? 0) - (right.seq ?? 0);
    });
  }

  async function attachLatestTimelineEvents(entries: Array<{
    row: ExecutionAttemptRow;
    summary: Rt2ExecutionSummary;
  }>) {
    if (entries.length === 0) return;

    const attemptIds = entries.map((entry) => entry.row.id);
    const heartbeatRunIds = entries
      .map((entry) => entry.row.heartbeatRunId)
      .filter((runId): runId is string => Boolean(runId));

    const [domainRows, heartbeatRows] = await Promise.all([
      db
        .select()
        .from(rt2V33DomainEvents)
        .where(and(
          eq(rt2V33DomainEvents.entityType, "execution"),
          inArray(rt2V33DomainEvents.entityId, attemptIds),
        )),
      heartbeatRunIds.length > 0
        ? db
          .select()
          .from(heartbeatRunEvents)
          .where(inArray(heartbeatRunEvents.runId, heartbeatRunIds))
        : Promise.resolve([]),
    ]);

    const summaryByAttemptId = new Map(entries.map((entry) => [entry.row.id, entry.summary]));
    const attemptIdsByRunId = new Map<string, string[]>();
    for (const entry of entries) {
      if (!entry.row.heartbeatRunId) continue;
      const existing = attemptIdsByRunId.get(entry.row.heartbeatRunId) ?? [];
      existing.push(entry.row.id);
      attemptIdsByRunId.set(entry.row.heartbeatRunId, existing);
    }

    for (const event of domainRows) {
      const summary = summaryByAttemptId.get(event.entityId);
      if (!summary) continue;
      summary.latestTimelineEvent = newerTimelineEvent(summary.latestTimelineEvent, toDomainTimelineEvent(event));
    }

    for (const event of heartbeatRows) {
      const attemptIdsForRun = attemptIdsByRunId.get(event.runId) ?? [];
      for (const attemptId of attemptIdsForRun) {
        const summary = summaryByAttemptId.get(attemptId);
        if (!summary) continue;
        summary.latestTimelineEvent = newerTimelineEvent(summary.latestTimelineEvent, toHeartbeatTimelineEvent(event));
      }
    }
  }

  async function latestForIssueIds(issueIds: string[], column: "task" | "todo") {
    if (issueIds.length === 0) {
      return new Map<string, Rt2ExecutionSummary>();
    }

    const field = column === "task" ? rt2V33ExecutionAttempts.taskIssueId : rt2V33ExecutionAttempts.todoIssueId;
    const attempts = await db
      .select()
      .from(rt2V33ExecutionAttempts)
      .where(inArray(field, issueIds))
      .orderBy(desc(rt2V33ExecutionAttempts.updatedAt), desc(rt2V33ExecutionAttempts.createdAt));

    const latest = new Map<string, Rt2ExecutionSummary>();
    const latestEntries: Array<{ row: ExecutionAttemptRow; summary: Rt2ExecutionSummary }> = [];
    for (const attempt of attempts) {
      const key = column === "task" ? attempt.taskIssueId : attempt.todoIssueId;
      if (!key || latest.has(key)) continue;
      const summary = toExecutionSummary(attempt);
      latest.set(key, summary);
      latestEntries.push({ row: attempt, summary });
    }
    await attachLatestTimelineEvents(latestEntries);
    return latest;
  }

  async function appendExecutionEvent(input: {
    attempt: ExecutionAttemptRow;
    eventType: Rt2DomainEventType;
    actorType: "user" | "agent" | "system" | "runtime";
    actorId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }) {
    const task = await taskSvc.getTaskMeta(input.attempt.taskIssueId);
    await domainEvents.appendAndProject({
      companyId: input.attempt.companyId,
      eventType: input.eventType as any,
      actorType: input.actorType,
      actorId: input.actorId,
      entityType: "execution",
      entityId: input.attempt.id,
      idempotencyKey: input.idempotencyKey,
      payload: {
        taskIssueId: input.attempt.taskIssueId,
        todoIssueId: input.attempt.todoIssueId,
        projectId: task.projectId,
        executionAttemptId: input.attempt.id,
        ...input.payload,
      },
    });
  }

  async function dispatch(attemptId: string, input: DispatchRt2Execution) {
    const attempt = await getAttempt(attemptId);
    await assertRuntimeCanAccept(attempt.companyId, input);

    const updated = await updateState(
      attemptId,
      "queued",
      {
        state: "dispatched",
        executorType: input.executorType,
        executorId: input.executorId,
        executionWorkspaceId: input.executionWorkspaceId ?? undefined,
        runtimeServiceId: input.runtimeServiceId ?? undefined,
        heartbeatRunId: input.heartbeatRunId ?? undefined,
        claimedAt: new Date(),
      },
      "RT2_EXECUTION_ALREADY_DISPATCHED",
    );

    if (input.runtimeServiceId) {
      await db
        .update(workspaceRuntimeServices)
        .set({ lastUsedAt: new Date(), updatedAt: new Date() })
        .where(eq(workspaceRuntimeServices.id, input.runtimeServiceId));
    }

    await appendExecutionEvent({
      attempt,
      eventType: "rt2.execution.dispatched",
      actorType: input.executorType === "jarvis" ? "agent" : input.executorType,
      actorId: input.executorId,
      idempotencyKey: `rt2.execution.dispatched:${attemptId}`,
      payload: {
        executorType: input.executorType,
        executorId: input.executorId,
        runtimeServiceId: input.runtimeServiceId ?? null,
        heartbeatRunId: input.heartbeatRunId ?? null,
        capacity: input.capacity ?? null,
      },
    });
    return updated;
  }

  return {
    getAttempt,
    toExecutionSummary,

    latestForTaskIssueIds: (taskIssueIds: string[]) => latestForIssueIds(taskIssueIds, "task"),
    latestForTodoIssueIds: (todoIssueIds: string[]) => latestForIssueIds(todoIssueIds, "todo"),

    enqueue: async (taskIssueId: string, actorUserId: string, input: EnqueueRt2Execution) => {
      const task = await taskSvc.getTaskMeta(taskIssueId);
      const todoIssueId = input.todoIssueId ?? null;
      if (todoIssueId) {
        await assertTodoBelongsToTask(todoIssueId, task.issueId, task.companyId);
      }

      const allowedIssueIds = todoIssueId ? [task.issueId, todoIssueId] : [task.issueId];
      const deliverableWorkProductId = input.deliverableWorkProductId ?? null;
      if (deliverableWorkProductId) {
        await assertWorkProductInScope(
          deliverableWorkProductId,
          task.companyId,
          allowedIssueIds,
          "RT2_EXECUTION_DELIVERABLE_MUST_BELONG_TO_TASK_SCOPE",
        );
      }

      const [attempt] = await db
        .insert(rt2V33ExecutionAttempts)
        .values({
          companyId: task.companyId,
          taskIssueId: task.issueId,
          todoIssueId,
          deliverableWorkProductId,
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          metadata: input.metadata,
          queuedByUserId: actorUserId,
        })
        .returning();

      await appendExecutionEvent({
        attempt,
        eventType: "rt2.execution.enqueued",
        actorType: "user",
        actorId: actorUserId,
        idempotencyKey: `rt2.execution.enqueued:${attempt.id}`,
        payload: {
          deliverableWorkProductId,
        },
      });

      return toExecutionSummary(attempt);
    },

    dispatch,

    dispatchNext: async (companyId: string, input: DispatchNextRt2Execution) => {
      const [nextAttempt] = await db
        .select()
        .from(rt2V33ExecutionAttempts)
        .where(and(
          eq(rt2V33ExecutionAttempts.companyId, companyId),
          eq(rt2V33ExecutionAttempts.state, "queued"),
        ))
        .orderBy(asc(rt2V33ExecutionAttempts.queuedAt), asc(rt2V33ExecutionAttempts.createdAt))
        .limit(1);

      if (!nextAttempt) {
        throw conflict("RT2_EXECUTION_QUEUE_EMPTY");
      }

      return dispatch(nextAttempt.id, input);
    },

    claim: async (attemptId: string, input: ClaimRt2Execution) => dispatch(attemptId, input),

    start: async (attemptId: string, input: StartRt2Execution) => {
      const updated = await updateState(
        attemptId,
        startableStates,
        {
          state: "running",
          runtimeServiceId: input.runtimeServiceId ?? undefined,
          heartbeatRunId: input.heartbeatRunId ?? undefined,
          startedAt: new Date(),
        },
        "RT2_EXECUTION_MUST_BE_DISPATCHED_TO_START",
      );
      const attempt = await getAttempt(attemptId);
      await appendExecutionEvent({
        attempt,
        eventType: "rt2.execution.started",
        actorType: "system",
        actorId: "rt2-execution",
        idempotencyKey: `rt2.execution.started:${attemptId}`,
        payload: {
          runtimeServiceId: input.runtimeServiceId ?? attempt.runtimeServiceId ?? null,
          heartbeatRunId: input.heartbeatRunId ?? attempt.heartbeatRunId ?? null,
        },
      });
      return updated;
    },

    complete: async (attemptId: string, input: CompleteRt2Execution) => {
      const attempt = await getAttempt(attemptId);
      if (input.resultWorkProductId) {
        const allowedIssueIds = attempt.todoIssueId
          ? [attempt.taskIssueId, attempt.todoIssueId]
          : [attempt.taskIssueId];
        await assertWorkProductInScope(
          input.resultWorkProductId,
          attempt.companyId,
          allowedIssueIds,
          "RT2_EXECUTION_RESULT_MUST_BELONG_TO_TASK_SCOPE",
        );
      }

      const updated = await updateState(
        attemptId,
        "running",
        {
          state: "completed",
          resultWorkProductId: input.resultWorkProductId ?? undefined,
          missingDeliverableReason: input.missingDeliverableReason ?? undefined,
          completedAt: new Date(),
        },
        "RT2_EXECUTION_MUST_BE_RUNNING_TO_COMPLETE",
      );
      await appendExecutionEvent({
        attempt,
        eventType: "rt2.execution.completed",
        actorType: "system",
        actorId: "rt2-execution",
        idempotencyKey: `rt2.execution.completed:${attemptId}`,
        payload: {
          resultWorkProductId: input.resultWorkProductId ?? null,
          missingDeliverableReason: input.missingDeliverableReason ?? null,
        },
      });
      return updated;
    },

    fail: async (attemptId: string, input: FailRt2Execution) => {
      const updated = await updateState(
        attemptId,
        runtimeActiveStates,
        {
          state: "failed",
          failureReason: input.failureReason,
          completedAt: new Date(),
        },
        "RT2_EXECUTION_MUST_BE_ACTIVE_TO_FAIL",
      );
      const attempt = await getAttempt(attemptId);
      await appendExecutionEvent({
        attempt,
        eventType: "rt2.execution.failed",
        actorType: "system",
        actorId: "rt2-execution",
        idempotencyKey: `rt2.execution.failed:${attemptId}`,
        payload: {
          failureReason: input.failureReason,
        },
      });
      return updated;
    },

    cancel: async (attemptId: string, input: CancelRt2Execution) => {
      const cancelReason = input.reason ?? "cancelled";
      const updated = await updateState(
        attemptId,
        ["queued", ...runtimeActiveStates],
        {
          state: "cancelled",
          failureReason: cancelReason,
          completedAt: new Date(),
        },
        "RT2_EXECUTION_MUST_BE_QUEUED_OR_ACTIVE_TO_CANCEL",
      );
      const attempt = await getAttempt(attemptId);
      await appendExecutionEvent({
        attempt,
        eventType: "rt2.execution.cancelled",
        actorType: input.cancelledBy ? "user" : "system",
        actorId: input.cancelledBy ?? "rt2-execution",
        idempotencyKey: `rt2.execution.cancelled:${attemptId}`,
        payload: {
          reason: cancelReason,
        },
      });
      return updated;
    },

    cleanupStale: async (companyId: string, input: CleanupRt2Executions) => {
      const staleBefore = input.staleBefore
        ? new Date(input.staleBefore)
        : new Date(Date.now() - 30 * 60 * 1000);
      const reason = input.reason ?? "stale_runtime_cleanup";
      const candidates = await db
        .select()
        .from(rt2V33ExecutionAttempts)
        .where(and(
          eq(rt2V33ExecutionAttempts.companyId, companyId),
          inArray(rt2V33ExecutionAttempts.state, runtimeActiveStates),
          lt(rt2V33ExecutionAttempts.updatedAt, staleBefore),
        ))
        .orderBy(asc(rt2V33ExecutionAttempts.updatedAt), asc(rt2V33ExecutionAttempts.createdAt))
        .limit(input.limit ?? 100);

      const cleaned: Rt2ExecutionSummary[] = [];
      for (const candidate of candidates) {
        const [updated] = await db
          .update(rt2V33ExecutionAttempts)
          .set({
            state: "failed",
            failureReason: reason,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(
            eq(rt2V33ExecutionAttempts.id, candidate.id),
            inArray(rt2V33ExecutionAttempts.state, runtimeActiveStates),
          ))
          .returning();
        if (!updated) continue;

        await appendExecutionEvent({
          attempt: candidate,
          eventType: "rt2.execution.stale_cleaned",
          actorType: "system",
          actorId: "rt2-execution-cleanup",
          idempotencyKey: `rt2.execution.stale_cleaned:${candidate.id}:${staleBefore.toISOString()}`,
          payload: {
            previousState: normalizeExecutionState(candidate.state),
            reason,
            staleBefore: staleBefore.toISOString(),
          },
        });
        cleaned.push(toExecutionSummary(updated));
      }

      return {
        staleBefore,
        cleaned,
      };
    },

    listTimeline: async (attemptId: string) => {
      const attempt = await getAttempt(attemptId);
      return buildTimelineEvents(attempt);
    },

    retry: async (attemptId: string, actorUserId: string) => {
      const attempt = await getAttempt(attemptId);
      if (!terminalRetryableStates.has(attempt.state)) {
        throw conflict("RT2_EXECUTION_RETRY_REQUIRES_FAILED_CANCELLED_OR_BLOCKED");
      }

      const [retryAttempt] = await db
        .insert(rt2V33ExecutionAttempts)
        .values({
          companyId: attempt.companyId,
          taskIssueId: attempt.taskIssueId,
          todoIssueId: attempt.todoIssueId,
          deliverableWorkProductId: attempt.deliverableWorkProductId,
          executionWorkspaceId: attempt.executionWorkspaceId,
          metadata: attempt.metadata ?? undefined,
          queuedByUserId: actorUserId,
          retryOfAttemptId: attempt.id,
        })
        .returning();

      await appendExecutionEvent({
        attempt: retryAttempt,
        eventType: "rt2.execution.retried",
        actorType: "user",
        actorId: actorUserId,
        idempotencyKey: `rt2.execution.retried:${attempt.id}:${retryAttempt.id}`,
        payload: {
          retryOfAttemptId: attempt.id,
        },
      });

      return toExecutionSummary(retryAttempt);
    },
  };
}
