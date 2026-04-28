import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, issues, rt2V33ExecutionAttempts } from "@paperclipai/db";
import type {
  ClaimRt2Execution,
  CompleteRt2Execution,
  EnqueueRt2Execution,
  FailRt2Execution,
  StartRt2Execution,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { rt2DomainEventService } from "./rt2-domain-events.js";
import { rt2TaskEngineService } from "./rt2-task-engine.js";

type ExecutionAttemptRow = typeof rt2V33ExecutionAttempts.$inferSelect;

const terminalRetryableStates = new Set(["failed", "cancelled", "blocked"]);

function toExecutionSummary(row: ExecutionAttemptRow) {
  return {
    id: row.id,
    taskIssueId: row.taskIssueId,
    todoIssueId: row.todoIssueId ?? null,
    state: row.state as "queued" | "claimed" | "running" | "completed" | "failed" | "cancelled" | "blocked",
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

  async function updateState(
    attemptId: string,
    expectedState: string | string[],
    patch: Partial<typeof rt2V33ExecutionAttempts.$inferInsert>,
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

  async function latestForIssueIds(issueIds: string[], column: "task" | "todo") {
    if (issueIds.length === 0) {
      return new Map<string, ReturnType<typeof toExecutionSummary>>();
    }

    const field = column === "task" ? rt2V33ExecutionAttempts.taskIssueId : rt2V33ExecutionAttempts.todoIssueId;
    const attempts = await db
      .select()
      .from(rt2V33ExecutionAttempts)
      .where(inArray(field, issueIds))
      .orderBy(desc(rt2V33ExecutionAttempts.updatedAt), desc(rt2V33ExecutionAttempts.createdAt));

    const latest = new Map<string, ReturnType<typeof toExecutionSummary>>();
    for (const attempt of attempts) {
      const key = column === "task" ? attempt.taskIssueId : attempt.todoIssueId;
      if (!key || latest.has(key)) continue;
      latest.set(key, toExecutionSummary(attempt));
    }
    return latest;
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

      await domainEvents.appendAndProject({
        companyId: task.companyId,
        eventType: "rt2.execution.enqueued",
        actorType: "user",
        actorId: actorUserId,
        entityType: "execution",
        entityId: attempt.id,
        idempotencyKey: `rt2.execution.enqueued:${attempt.id}`,
        payload: {
          taskIssueId: task.issueId,
          todoIssueId,
          projectId: task.projectId,
          executionAttemptId: attempt.id,
          deliverableWorkProductId,
        },
      });

      return toExecutionSummary(attempt);
    },

    claim: async (attemptId: string, input: ClaimRt2Execution) => {
      const updated = await updateState(
        attemptId,
        "queued",
        {
          state: "claimed",
          executorType: input.executorType,
          executorId: input.executorId,
          executionWorkspaceId: input.executionWorkspaceId ?? undefined,
          runtimeServiceId: input.runtimeServiceId ?? undefined,
          heartbeatRunId: input.heartbeatRunId ?? undefined,
          claimedAt: new Date(),
        },
        "RT2_EXECUTION_ALREADY_CLAIMED",
      );
      const attempt = await getAttempt(attemptId);
      const task = await taskSvc.getTaskMeta(attempt.taskIssueId);
      await domainEvents.appendAndProject({
        companyId: attempt.companyId,
        eventType: "rt2.execution.claimed",
        actorType: input.executorType === "jarvis" ? "agent" : input.executorType,
        actorId: input.executorId,
        entityType: "execution",
        entityId: attemptId,
        idempotencyKey: `rt2.execution.claimed:${attemptId}`,
        payload: {
          taskIssueId: attempt.taskIssueId,
          todoIssueId: attempt.todoIssueId,
          projectId: task.projectId,
          executionAttemptId: attemptId,
          executorType: input.executorType,
          executorId: input.executorId,
        },
      });
      return updated;
    },

    start: async (attemptId: string, input: StartRt2Execution) => {
      const updated = await updateState(
        attemptId,
        "claimed",
        {
          state: "running",
          runtimeServiceId: input.runtimeServiceId ?? undefined,
          heartbeatRunId: input.heartbeatRunId ?? undefined,
          startedAt: new Date(),
        },
        "RT2_EXECUTION_MUST_BE_CLAIMED_TO_START",
      );
      const attempt = await getAttempt(attemptId);
      const task = await taskSvc.getTaskMeta(attempt.taskIssueId);
      await domainEvents.appendAndProject({
        companyId: attempt.companyId,
        eventType: "rt2.execution.started",
        actorType: "system",
        actorId: "rt2-execution",
        entityType: "execution",
        entityId: attemptId,
        idempotencyKey: `rt2.execution.started:${attemptId}`,
        payload: {
          taskIssueId: attempt.taskIssueId,
          todoIssueId: attempt.todoIssueId,
          projectId: task.projectId,
          executionAttemptId: attemptId,
          runtimeServiceId: input.runtimeServiceId ?? null,
          heartbeatRunId: input.heartbeatRunId ?? null,
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
      const task = await taskSvc.getTaskMeta(attempt.taskIssueId);
      await domainEvents.appendAndProject({
        companyId: attempt.companyId,
        eventType: "rt2.execution.completed",
        actorType: "system",
        actorId: "rt2-execution",
        entityType: "execution",
        entityId: attemptId,
        idempotencyKey: `rt2.execution.completed:${attemptId}`,
        payload: {
          taskIssueId: attempt.taskIssueId,
          todoIssueId: attempt.todoIssueId,
          projectId: task.projectId,
          executionAttemptId: attemptId,
          resultWorkProductId: input.resultWorkProductId ?? null,
          missingDeliverableReason: input.missingDeliverableReason ?? null,
        },
      });
      return updated;
    },

    fail: async (attemptId: string, input: FailRt2Execution) => {
      const updated = await updateState(
        attemptId,
        ["claimed", "running"],
        {
          state: "failed",
          failureReason: input.failureReason,
          completedAt: new Date(),
        },
        "RT2_EXECUTION_MUST_BE_ACTIVE_TO_FAIL",
      );
      const attempt = await getAttempt(attemptId);
      const task = await taskSvc.getTaskMeta(attempt.taskIssueId);
      await domainEvents.appendAndProject({
        companyId: attempt.companyId,
        eventType: "rt2.execution.failed",
        actorType: "system",
        actorId: "rt2-execution",
        entityType: "execution",
        entityId: attemptId,
        idempotencyKey: `rt2.execution.failed:${attemptId}`,
        payload: {
          taskIssueId: attempt.taskIssueId,
          todoIssueId: attempt.todoIssueId,
          projectId: task.projectId,
          executionAttemptId: attemptId,
          failureReason: input.failureReason,
        },
      });
      return updated;
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

      const task = await taskSvc.getTaskMeta(attempt.taskIssueId);
      await domainEvents.appendAndProject({
        companyId: attempt.companyId,
        eventType: "rt2.execution.retried",
        actorType: "user",
        actorId: actorUserId,
        entityType: "execution",
        entityId: retryAttempt.id,
        idempotencyKey: `rt2.execution.retried:${attempt.id}:${retryAttempt.id}`,
        payload: {
          taskIssueId: attempt.taskIssueId,
          todoIssueId: attempt.todoIssueId,
          projectId: task.projectId,
          executionAttemptId: retryAttempt.id,
          retryOfAttemptId: attempt.id,
        },
      });

      return toExecutionSummary(retryAttempt);
    },
  };
}
