import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueWorkProducts,
  issues,
  rt2V33TaskParticipants,
  rt2V33TaskProfiles,
} from "@paperclipai/db";
import type {
  CreateRt2Task,
  CreateRt2Todo,
  EndRt2Participant,
  UpdateRt2TaskCapacity,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound } from "../errors.js";
import { issueService } from "./issues.js";
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
    for (const deliverable of deliverables) {
      await txWorkProducts.createForIssue(issueId, companyId, {
        projectId,
        type: "document",
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
        },
      });
    }
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
      summary: row.summary ?? null,
      isRequired: metadata?.rt2Required !== false,
    };
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
      const [activeParticipants, todoRows, deliverableRows] = await Promise.all([
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
      const deliverableRows = await db
        .select()
        .from(issueWorkProducts)
        .where(inArray(issueWorkProducts.issueId, deliverableIssueIds));

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

        await createDeliverables(txDb, issue.id, companyId, input.projectId, "task", input.deliverables);

        return issue;
      });
    },

    joinTask: async (taskIssueId: string, actorUserId: string) => {
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

      if (activeParticipants.some((participant) => participant.userId === actorUserId)) {
        throw conflict("RT2_PARTICIPANT_ALREADY_ACTIVE");
      }

      if (activeParticipants.length >= task.capacity) {
        throw conflict("RT2_TASK_CAPACITY_REACHED");
      }

      const [participant] = await db
        .insert(rt2V33TaskParticipants)
        .values({
          companyId: task.companyId,
          taskIssueId,
          userId: actorUserId,
          state: "active",
          joinedByUserId: actorUserId,
        })
        .returning();

      return participant;
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

        await createDeliverables(txDb, todo.id, task.companyId, task.projectId, "todo", input.deliverables);

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
        await endParticipantInTx(tx as unknown as Db, {
          taskIssueId,
          userId,
          reason: input.reason,
          endedByUserId: actorUserId,
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
