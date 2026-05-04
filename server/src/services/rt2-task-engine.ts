import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyMemberships,
  heartbeatRunEvents,
  issueWorkProducts,
  rt2V33ExecutionAttempts,
  rt2V33DomainEvents,
  issues,
  rt2V33TaskParticipants,
  rt2V33TaskProfiles,
} from "@paperclipai/db";
import type {
  AssignRt2Participant,
  CreateRt2Task,
  CreateRt2Todo,
  EndRt2Participant,
  Rt2ExecutionSummary,
  Rt2ExecutionTimelineEvent,
  UpdateRt2TaskCapacity,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound } from "../errors.js";
import { issueService } from "./issues.js";
import { rt2DomainEventService } from "./rt2-domain-events.js";
import { workProductService } from "./work-products.js";

type TaskMeta = {
  issueId: string;
  companyId: string;
  projectId: string;
  goalId: string | null;
  taskMode: "solo" | "collab";
  capacity: number;
  status: string;
};

type ParticipantRow = typeof rt2V33TaskParticipants.$inferSelect;
type WorkProductRow = typeof issueWorkProducts.$inferSelect;
type CompanyMembershipRow = typeof companyMemberships.$inferSelect;
type ExecutionAttemptRow = typeof rt2V33ExecutionAttempts.$inferSelect;

function readRt2Metadata(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isRt2Deliverable(row: WorkProductRow) {
  return readRt2Metadata(row.metadata)?.rt2Deliverable === true;
}

export function rt2TaskEngineService(db: Db) {
  const issuesSvc = issueService(db);
  const workProducts = workProductService(db);
  const domainEvents = rt2DomainEventService(db);

  async function getTaskMeta(taskIssueId: string): Promise<TaskMeta> {
    const row = await db
      .select({
        issueId: rt2V33TaskProfiles.issueId,
        companyId: rt2V33TaskProfiles.companyId,
        projectId: rt2V33TaskProfiles.projectId,
        goalId: rt2V33TaskProfiles.goalId,
        taskMode: rt2V33TaskProfiles.taskMode,
        capacity: rt2V33TaskProfiles.capacity,
        status: issues.status,
      })
      .from(rt2V33TaskProfiles)
      .innerJoin(issues, eq(rt2V33TaskProfiles.issueId, issues.id))
      .where(eq(rt2V33TaskProfiles.issueId, taskIssueId))
      .then((rows) => rows[0] ?? null);

    if (!row) {
      throw notFound("RT2 task not found");
    }

    return {
      issueId: row.issueId,
      companyId: row.companyId,
      projectId: row.projectId,
      goalId: row.goalId ?? null,
      taskMode: row.taskMode as "solo" | "collab",
      capacity: row.capacity,
      status: row.status,
    };
  }

  async function createDeliverables(
    tx: Db,
    issueId: string,
    companyId: string,
    projectId: string,
    owner: "task" | "todo",
    deliverables: CreateRt2Task["deliverables"] | CreateRt2Todo["deliverables"],
  ) {
    const txWorkProducts = workProductService(tx);
    const created: WorkProductRow[] = [];
    for (const deliverable of deliverables) {
      const workProduct = await txWorkProducts.createForIssue(issueId, companyId, {
        projectId,
        type: deliverable.type,
        provider: "paperclip",
        title: deliverable.title,
        status: "draft",
        reviewState: "none",
        isPrimary: false,
        healthStatus: "unknown",
        summary: deliverable.summary ?? null,
        metadata: {
          rt2Deliverable: true,
          rt2State: "defined",
          rt2Type: deliverable.type,
          rt2Owner: owner,
          rt2Required: true,
          rt2BasePrice: deliverable.basePrice,
        },
      });
      created.push(workProduct as WorkProductRow);
    }
    return created;
  }

  async function endParticipantInTx(
    tx: Db,
    input: {
      taskIssueId: string;
      userId: string;
      reason: EndRt2Participant["reason"];
      endedByUserId: string;
    },
  ) {
    const existing = await tx
      .select()
      .from(rt2V33TaskParticipants)
      .where(
        and(
          eq(rt2V33TaskParticipants.taskIssueId, input.taskIssueId),
          eq(rt2V33TaskParticipants.userId, input.userId),
          eq(rt2V33TaskParticipants.state, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!existing) {
      throw notFound("RT2 participant not found");
    }

    await tx
      .update(rt2V33TaskParticipants)
      .set({
        state: "ended",
        endedReason: input.reason,
        endedByUserId: input.endedByUserId,
        endedAt: new Date(),
      })
      .where(eq(rt2V33TaskParticipants.id, existing.id));

    await tx
      .update(issues)
      .set({
        assigneeUserId: null,
        status: "todo",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(issues.parentId, input.taskIssueId),
          eq(issues.assigneeUserId, input.userId),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
  }

  function buildParticipantSummary(row: ParticipantRow) {
    return {
      id: row.id,
      taskIssueId: row.taskIssueId,
      userId: row.userId,
      state: row.state as "active" | "ended",
      endedReason: row.endedReason as "manager_removed" | "self_left" | "capacity_reduced" | null,
      joinedAt: row.joinedAt,
      endedAt: row.endedAt ?? null,
    };
  }

  function buildDeliverableSummary(row: WorkProductRow) {
    const metadata = readRt2Metadata(row.metadata);
    return {
      workProductId: row.id,
      issueId: row.issueId,
      title: row.title,
      type: (metadata?.rt2Type as "document" | "artifact" | undefined) ?? "document",
      state: (metadata?.rt2State as "defined" | "submitted" | undefined) ?? "defined",
      basePrice: typeof metadata?.rt2BasePrice === "number" ? metadata.rt2BasePrice : null,
      summary: row.summary ?? null,
      isRequired: metadata?.rt2Required !== false,
    };
  }

  function buildAssignableUserSummary(row: CompanyMembershipRow) {
    return {
      userId: row.principalId,
      membershipRole: row.membershipRole ?? null,
    };
  }

  function normalizeExecutionState(state: string): Rt2ExecutionSummary["state"] {
    return (state === "claimed" ? "dispatched" : state) as Rt2ExecutionSummary["state"];
  }

  function buildExecutionSummary(row: ExecutionAttemptRow): Rt2ExecutionSummary {
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

  async function latestExecutionByIssueId(rows: ExecutionAttemptRow[], owner: "task" | "todo") {
    const latest = new Map<string, Rt2ExecutionSummary>();
    const entries: Array<{ row: ExecutionAttemptRow; summary: Rt2ExecutionSummary }> = [];
    for (const row of rows) {
      const key = owner === "task" ? row.taskIssueId : row.todoIssueId;
      if (!key || latest.has(key)) continue;
      const summary = buildExecutionSummary(row);
      latest.set(key, summary);
      entries.push({ row, summary });
    }
    await attachLatestTimelineEvents(entries);
    return latest;
  }

  async function addParticipant(
    task: TaskMeta,
    actorUserId: string,
    participantUserId: string,
  ) {
    const [activeParticipants, membership] = await Promise.all([
      db
        .select()
        .from(rt2V33TaskParticipants)
        .where(
          and(
            eq(rt2V33TaskParticipants.taskIssueId, task.issueId),
            eq(rt2V33TaskParticipants.state, "active"),
          ),
        ),
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, task.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, participantUserId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null),
    ]);

    if (!membership) {
      throw conflict("RT2_PARTICIPANT_MUST_BE_ACTIVE_COMPANY_MEMBER");
    }

    if (activeParticipants.some((participant) => participant.userId === participantUserId)) {
      throw conflict("RT2_PARTICIPANT_ALREADY_ACTIVE");
    }

    if (activeParticipants.length >= task.capacity) {
      throw conflict("RT2_TASK_CAPACITY_REACHED");
    }

    const [participant] = await db
      .insert(rt2V33TaskParticipants)
      .values({
        companyId: task.companyId,
        taskIssueId: task.issueId,
        userId: participantUserId,
        state: "active",
        joinedByUserId: actorUserId,
      })
      .returning();

    const participantMutation = actorUserId === participantUserId ? "joined" : "assigned";
    await domainEvents.appendAndProject({
      companyId: task.companyId,
      eventType: participantMutation === "joined" ? "rt2.participant.joined" : "rt2.participant.assigned",
      actorType: "user",
      actorId: actorUserId,
      entityType: "participant",
      entityId: participant.id,
      idempotencyKey: `rt2.participant.${participantMutation}:${participant.id}`,
      payload: {
        taskIssueId: task.issueId,
        projectId: task.projectId,
        participantUserId,
      },
    });

    return participant;
  }

  return {
    getTaskMeta,

    listByProject: async (companyId: string, projectId: string) => {
      const taskRows = await db
        .select({
          issueId: issues.id,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          updatedAt: issues.updatedAt,
          profileProjectId: rt2V33TaskProfiles.projectId,
          profileGoalId: rt2V33TaskProfiles.goalId,
          profileTaskMode: rt2V33TaskProfiles.taskMode,
          profileCapacity: rt2V33TaskProfiles.capacity,
        })
        .from(rt2V33TaskProfiles)
        .innerJoin(issues, eq(rt2V33TaskProfiles.issueId, issues.id))
        .where(
          and(
            eq(rt2V33TaskProfiles.companyId, companyId),
            eq(rt2V33TaskProfiles.projectId, projectId),
          ),
        )
        .orderBy(desc(issues.updatedAt));

      if (taskRows.length === 0) {
        return [];
      }

      const taskIssueIds = taskRows.map((row) => row.issueId);
      const [activeParticipants, todoRows, deliverableRows, executionRows] = await Promise.all([
        db
          .select()
          .from(rt2V33TaskParticipants)
          .where(
            and(
              inArray(rt2V33TaskParticipants.taskIssueId, taskIssueIds),
              eq(rt2V33TaskParticipants.state, "active"),
            ),
          ),
        db
          .select({
            parentId: issues.parentId,
            status: issues.status,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              inArray(issues.parentId, taskIssueIds),
            ),
          ),
        db
          .select()
          .from(issueWorkProducts)
          .where(inArray(issueWorkProducts.issueId, taskIssueIds)),
        db
          .select()
          .from(rt2V33ExecutionAttempts)
          .where(inArray(rt2V33ExecutionAttempts.taskIssueId, taskIssueIds))
          .orderBy(desc(rt2V33ExecutionAttempts.updatedAt), desc(rt2V33ExecutionAttempts.createdAt)),
      ]);

      const activeParticipantCountByTask = new Map<string, number>();
      for (const participant of activeParticipants) {
        activeParticipantCountByTask.set(
          participant.taskIssueId,
          (activeParticipantCountByTask.get(participant.taskIssueId) ?? 0) + 1,
        );
      }

      const todoCountByTask = new Map<string, number>();
      const todoInProgressCountByTask = new Map<string, number>();
      for (const todo of todoRows) {
        if (!todo.parentId) continue;
        todoCountByTask.set(todo.parentId, (todoCountByTask.get(todo.parentId) ?? 0) + 1);
        if (todo.status === "in_progress") {
          todoInProgressCountByTask.set(
            todo.parentId,
            (todoInProgressCountByTask.get(todo.parentId) ?? 0) + 1,
          );
        }
      }

      const deliverableCountByTask = new Map<string, number>();
      for (const deliverable of deliverableRows) {
        if (!isRt2Deliverable(deliverable)) continue;
        deliverableCountByTask.set(
          deliverable.issueId,
          (deliverableCountByTask.get(deliverable.issueId) ?? 0) + 1,
        );
      }

      const latestTaskExecutionByIssueId = await latestExecutionByIssueId(executionRows, "task");

      return taskRows.map((row) => ({
        issueId: row.issueId,
        projectId: row.profileProjectId,
        goalId: row.profileGoalId ?? null,
        title: row.title,
        description: row.description ?? null,
        status: row.status as "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled",
        taskMode: row.profileTaskMode as "solo" | "collab",
        capacity: row.profileCapacity,
        activeParticipantCount: activeParticipantCountByTask.get(row.issueId) ?? 0,
        deliverableCount: deliverableCountByTask.get(row.issueId) ?? 0,
        todoCount: todoCountByTask.get(row.issueId) ?? 0,
        todoInProgressCount: todoInProgressCountByTask.get(row.issueId) ?? 0,
        execution: latestTaskExecutionByIssueId.get(row.issueId) ?? null,
      }));
    },

    getDetail: async (taskIssueId: string) => {
      const task = await getTaskMeta(taskIssueId);
      const taskIssue = await issuesSvc.getById(taskIssueId);
      if (!taskIssue) {
        throw notFound("RT2 task not found");
      }

      const [participants, todos] = await Promise.all([
        db
          .select()
          .from(rt2V33TaskParticipants)
          .where(eq(rt2V33TaskParticipants.taskIssueId, taskIssueId))
          .orderBy(asc(rt2V33TaskParticipants.joinedAt)),
        db
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, task.companyId),
              eq(issues.parentId, taskIssueId),
            ),
          )
          .orderBy(asc(issues.createdAt)),
      ]);

      const deliverableIssueIds = [taskIssueId, ...todos.map((todo) => todo.id)];
      const [deliverableRows, executionRows] = await Promise.all([
        db
          .select()
          .from(issueWorkProducts)
          .where(inArray(issueWorkProducts.issueId, deliverableIssueIds)),
        db
          .select()
          .from(rt2V33ExecutionAttempts)
          .where(inArray(rt2V33ExecutionAttempts.taskIssueId, [taskIssueId]))
          .orderBy(desc(rt2V33ExecutionAttempts.updatedAt), desc(rt2V33ExecutionAttempts.createdAt)),
      ]);

      const taskDeliverables = deliverableRows
        .filter((row) => row.issueId === taskIssueId && isRt2Deliverable(row))
        .map(buildDeliverableSummary);

      const todoDeliverablesByIssueId = new Map<string, WorkProductRow[]>();
      for (const deliverable of deliverableRows) {
        if (deliverable.issueId === taskIssueId || !isRt2Deliverable(deliverable)) continue;
        const bucket = todoDeliverablesByIssueId.get(deliverable.issueId) ?? [];
        bucket.push(deliverable);
        todoDeliverablesByIssueId.set(deliverable.issueId, bucket);
      }

      const latestTaskExecutionByIssueId = await latestExecutionByIssueId(executionRows, "task");
      const latestTodoExecutionByIssueId = await latestExecutionByIssueId(executionRows, "todo");

      return {
        issueId: taskIssue.id,
        projectId: task.projectId,
        goalId: task.goalId,
        title: taskIssue.title,
        description: taskIssue.description ?? null,
        status: taskIssue.status as "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled",
        taskMode: task.taskMode,
        capacity: task.capacity,
        activeParticipantCount: participants.filter((participant) => participant.state === "active").length,
        deliverableCount: taskDeliverables.length,
        todoCount: todos.length,
        todoInProgressCount: todos.filter((todo) => todo.status === "in_progress").length,
        execution: latestTaskExecutionByIssueId.get(taskIssueId) ?? null,
        participants: participants.map(buildParticipantSummary),
        deliverables: taskDeliverables,
        todos: todos.map((todo) => {
          const todoDeliverables = todoDeliverablesByIssueId.get(todo.id) ?? [];
          return {
            issueId: todo.id,
            parentTaskIssueId: taskIssueId,
            title: todo.title,
            status: todo.status as "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled",
            assigneeUserId: todo.assigneeUserId ?? null,
            deliverableCount: todoDeliverables.length,
            submittedDeliverableCount: todoDeliverables.filter((deliverable) => {
              return readRt2Metadata(deliverable.metadata)?.rt2State === "submitted";
            }).length,
            execution: latestTodoExecutionByIssueId.get(todo.id) ?? null,
          };
        }),
      };
    },

    createTask: async (companyId: string, actorUserId: string, input: CreateRt2Task) => {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const txIssues = issueService(txDb);

        const issue = await txIssues.create(companyId, {
          projectId: input.projectId,
          goalId: input.goalId ?? null,
          title: input.title,
          description: input.description ?? null,
          status: "todo",
          priority: input.priority,
          createdByUserId: actorUserId,
        });

        await tx.insert(rt2V33TaskProfiles).values({
          issueId: issue.id,
          companyId,
          projectId: input.projectId,
          goalId: input.goalId ?? null,
          taskMode: input.taskMode,
          capacity: input.capacity,
        });

        const deliverables = await createDeliverables(txDb, issue.id, companyId, input.projectId, "task", input.deliverables);
        const txEvents = rt2DomainEventService(txDb);
        await txEvents.appendAndProject({
          companyId,
          eventType: "rt2.task.created",
          actorType: "user",
          actorId: actorUserId,
          entityType: "task",
          entityId: issue.id,
          idempotencyKey: `rt2.task.created:${issue.id}`,
          payload: {
            taskIssueId: issue.id,
            projectId: input.projectId,
            goalId: input.goalId ?? null,
            title: input.title,
            taskMode: input.taskMode,
            capacity: input.capacity,
            deliverableWorkProductIds: deliverables.map((deliverable) => deliverable.id),
          },
        });

        for (const deliverable of deliverables) {
          await txEvents.appendAndProject({
            companyId,
            eventType: "rt2.deliverable.defined",
            actorType: "user",
            actorId: actorUserId,
            entityType: "deliverable",
            entityId: deliverable.id,
            idempotencyKey: `rt2.deliverable.defined:${deliverable.id}`,
            payload: {
              taskIssueId: issue.id,
              projectId: input.projectId,
              deliverableWorkProductId: deliverable.id,
              title: deliverable.title,
              type: deliverable.type,
            },
          });
        }

        return issue;
      });
    },

    joinTask: async (taskIssueId: string, actorUserId: string) => {
      const task = await getTaskMeta(taskIssueId);
      return addParticipant(task, actorUserId, actorUserId);
    },

    assignParticipant: async (
      taskIssueId: string,
      actorUserId: string,
      input: AssignRt2Participant,
    ) => {
      const task = await getTaskMeta(taskIssueId);
      return addParticipant(task, actorUserId, input.userId);
    },

    listAssignableUsers: async (taskIssueId: string) => {
      const task = await getTaskMeta(taskIssueId);
      const [memberships, activeParticipants] = await Promise.all([
        db
          .select()
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, task.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
            ),
          )
          .orderBy(asc(companyMemberships.createdAt)),
        db
          .select({ userId: rt2V33TaskParticipants.userId })
          .from(rt2V33TaskParticipants)
          .where(
            and(
              eq(rt2V33TaskParticipants.taskIssueId, taskIssueId),
              eq(rt2V33TaskParticipants.state, "active"),
            ),
          ),
      ]);

      const activeUserIds = new Set(activeParticipants.map((participant) => participant.userId));
      return memberships
        .filter((membership) => !activeUserIds.has(membership.principalId))
        .map(buildAssignableUserSummary);
    },

    createTodo: async (taskIssueId: string, actorUserId: string, input: CreateRt2Todo) => {
      if (input.taskIssueId !== taskIssueId) {
        throw badRequest("RT2_TODO_TASK_MISMATCH");
      }

      const task = await getTaskMeta(taskIssueId);
      const activeParticipant = await db
        .select({ id: rt2V33TaskParticipants.id })
        .from(rt2V33TaskParticipants)
        .where(
          and(
            eq(rt2V33TaskParticipants.taskIssueId, taskIssueId),
            eq(rt2V33TaskParticipants.userId, input.assigneeUserId),
            eq(rt2V33TaskParticipants.state, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!activeParticipant) {
        throw conflict("RT2_TODO_ASSIGNEE_MUST_BE_ACTIVE_PARTICIPANT");
      }

      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const txIssues = issueService(txDb);

        const todo = await txIssues.create(task.companyId, {
          projectId: task.projectId,
          goalId: task.goalId,
          parentId: taskIssueId,
          title: input.title,
          description: input.description ?? null,
          status: "todo",
          priority: "medium",
          assigneeUserId: input.assigneeUserId,
          createdByUserId: actorUserId,
        });

        const deliverables = await createDeliverables(txDb, todo.id, task.companyId, task.projectId, "todo", input.deliverables);
        const txEvents = rt2DomainEventService(txDb);
        await txEvents.appendAndProject({
          companyId: task.companyId,
          eventType: "rt2.todo.created",
          actorType: "user",
          actorId: actorUserId,
          entityType: "todo",
          entityId: todo.id,
          idempotencyKey: `rt2.todo.created:${todo.id}`,
          payload: {
            taskIssueId,
            todoIssueId: todo.id,
            projectId: task.projectId,
            assigneeUserId: input.assigneeUserId,
            deliverableWorkProductIds: deliverables.map((deliverable) => deliverable.id),
          },
        });

        for (const deliverable of deliverables) {
          await txEvents.appendAndProject({
            companyId: task.companyId,
            eventType: "rt2.deliverable.defined",
            actorType: "user",
            actorId: actorUserId,
            entityType: "deliverable",
            entityId: deliverable.id,
            idempotencyKey: `rt2.deliverable.defined:${deliverable.id}`,
            payload: {
              taskIssueId,
              todoIssueId: todo.id,
              projectId: task.projectId,
              deliverableWorkProductId: deliverable.id,
              title: deliverable.title,
              type: deliverable.type,
            },
          });
        }

        return todo;
      });
    },

    updateCapacity: async (
      taskIssueId: string,
      actorUserId: string,
      input: UpdateRt2TaskCapacity,
    ) => {
      const task = await getTaskMeta(taskIssueId);
      const activeParticipants = await db
        .select()
        .from(rt2V33TaskParticipants)
        .where(
          and(
            eq(rt2V33TaskParticipants.taskIssueId, taskIssueId),
            eq(rt2V33TaskParticipants.state, "active"),
          ),
        );

      const activeUserIds = new Set(activeParticipants.map((participant) => participant.userId));
      const endedUserIds = [...new Set(input.endedUserIds)];
      const invalidEndedUserId = endedUserIds.find((userId) => !activeUserIds.has(userId));
      const remainingActiveCount = activeParticipants.length - endedUserIds.length;

      if (invalidEndedUserId || remainingActiveCount > input.capacity) {
        throw conflict("RT2_CAPACITY_REQUIRES_EXPLICIT_REMOVALS");
      }

      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx
          .update(rt2V33TaskProfiles)
          .set({
            capacity: input.capacity,
            updatedAt: new Date(),
          })
          .where(eq(rt2V33TaskProfiles.issueId, taskIssueId));

        for (const userId of endedUserIds) {
          await endParticipantInTx(txDb, {
            taskIssueId,
            userId,
            reason: "capacity_reduced",
            endedByUserId: actorUserId,
          });
        }
        await rt2DomainEventService(txDb).appendAndProject({
          companyId: task.companyId,
          eventType: "rt2.task.capacity_changed",
          actorType: "user",
          actorId: actorUserId,
          entityType: "task",
          entityId: taskIssueId,
          idempotencyKey: `rt2.task.capacity_changed:${taskIssueId}:${Date.now()}`,
          payload: {
            taskIssueId,
            projectId: task.projectId,
            capacity: input.capacity,
            endedUserIds,
          },
        });
      });

      return {
        issueId: taskIssueId,
        companyId: task.companyId,
        projectId: task.projectId,
        capacity: input.capacity,
      };
    },

    endParticipant: async (
      taskIssueId: string,
      actorUserId: string,
      userId: string,
      input: EndRt2Participant,
    ) => {
      const task = await getTaskMeta(taskIssueId);

      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await endParticipantInTx(txDb, {
          taskIssueId,
          userId,
          reason: input.reason,
          endedByUserId: actorUserId,
        });
        await rt2DomainEventService(txDb).appendAndProject({
          companyId: task.companyId,
          eventType: "rt2.participant.ended",
          actorType: "user",
          actorId: actorUserId,
          entityType: "participant",
          entityId: `${taskIssueId}:${userId}`,
          idempotencyKey: `rt2.participant.ended:${taskIssueId}:${userId}:${Date.now()}`,
          payload: {
            taskIssueId,
            projectId: task.projectId,
            participantUserId: userId,
            reason: input.reason,
          },
        });
      });

      return {
        issueId: taskIssueId,
        companyId: task.companyId,
        projectId: task.projectId,
        userId,
        reason: input.reason,
      };
    },

    startTodo: async (todoIssueId: string) => {
      const todo = await issuesSvc.getById(todoIssueId);
      if (!todo || !todo.parentId) {
        throw notFound("RT2 todo not found");
      }

      const task = await getTaskMeta(todo.parentId);

      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const txIssues = issueService(txDb);
        const updatedTodo = await txIssues.update(todoIssueId, { status: "in_progress" }, tx);
        if (!updatedTodo) {
          throw notFound("RT2 todo not found");
        }

        if (task.status === "todo" || task.status === "backlog") {
          await tx
            .update(issues)
            .set({
              status: "in_progress",
              startedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(issues.id, task.issueId));
        }

        await rt2DomainEventService(txDb).appendAndProject({
          companyId: task.companyId,
          eventType: "rt2.todo.started",
          actorType: "user",
          actorId: todo.assigneeUserId ?? "unknown",
          entityType: "todo",
          entityId: todo.id,
          idempotencyKey: `rt2.todo.started:${todo.id}`,
          payload: {
            taskIssueId: task.issueId,
            projectId: task.projectId,
            todoIssueId: todo.id,
          },
        });

        return {
          todo: updatedTodo,
          taskIssueId: task.issueId,
          companyId: task.companyId,
          projectId: task.projectId,
        };
      });
    },
  };
}
