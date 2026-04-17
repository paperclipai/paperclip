import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  issues,
  rt2V33DailyReportCards,
  rt2V33DailyWikiPages,
  rt2V33TaskProfiles,
} from "@paperclipai/db";
import type {
  Rt2DailyActivityEntry,
  Rt2DailyActivityType,
  Rt2DailyBoard,
  Rt2DailyLane,
  Rt2DailyReportCard,
  Rt2DailyWikiAnswer,
  Rt2DailyWikiPage,
  UpsertRt2DailyReportCard,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";

type TodoRow = {
  todoIssueId: string;
  taskIssueId: string;
  taskTitle: string;
  todoTitle: string;
  assigneeUserId: string;
  todoStatus: Rt2DailyReportCard["status"];
  todoUpdatedAt: Date;
};

type SavedCardRow = typeof rt2V33DailyReportCards.$inferSelect;
type ActivityRow = typeof activityLog.$inferSelect;

const DEFAULT_DAILY_LANE: Rt2DailyLane = "today";
const DAILY_ACTIVITY_TYPES = new Set<Rt2DailyActivityType>([
  "todo_added",
  "todo_moved",
  "todo_progress_updated",
  "todo_note_updated",
  "todo_completed",
]);

function normalizeNullableText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function dailyReportKey(projectId: string, userId: string, reportDate: string) {
  return `rt2.daily-report:${projectId}:${userId}:${reportDate}`;
}

function buildCardSummary(input: {
  todoTitle: string;
  lane: Rt2DailyLane;
  bucketLabel: string | null;
  progressPercent: number;
  note: string | null;
}) {
  const bits = [input.todoTitle, input.lane, `${input.progressPercent}%`];
  if (input.bucketLabel) bits.push(input.bucketLabel);
  if (input.note) bits.push(input.note);
  return bits.join(" · ");
}

function defaultProgressPercent(todoStatus: Rt2DailyReportCard["status"], persistedProgressPercent: number | null) {
  if (persistedProgressPercent !== null) {
    return persistedProgressPercent;
  }
  return todoStatus === "done" ? 100 : 0;
}

function inferActivityType(previous: SavedCardRow | null, next: UpsertRt2DailyReportCard): Rt2DailyActivityType {
  if (next.progressPercent >= 100) {
    return "todo_completed";
  }
  if (!previous) {
    return "todo_added";
  }
  if (previous.lane !== next.lane || (previous.bucketLabel ?? null) !== (next.bucketLabel ?? null)) {
    return "todo_moved";
  }
  if ((previous.note ?? null) !== (next.note ?? null)) {
    return "todo_note_updated";
  }
  if (previous.progressPercent !== next.progressPercent) {
    return "todo_progress_updated";
  }
  return "todo_progress_updated";
}

function buildHistoryEntry(row: ActivityRow): Rt2DailyActivityEntry | null {
  if (row.entityType !== "rt2_daily_report") return null;

  const details = row.details ?? null;
  const summary = details && typeof details.summary === "string" ? details.summary : null;
  const activityType = DAILY_ACTIVITY_TYPES.has(row.action as Rt2DailyActivityType)
    ? (row.action as Rt2DailyActivityType)
    : "todo_progress_updated";
  const todoIssueId = details && typeof details.todoIssueId === "string" ? details.todoIssueId : "";
  const lane =
    details && (details.lane === "today" || details.lane === "support_1" || details.lane === "support_2")
      ? (details.lane as Rt2DailyLane)
      : DEFAULT_DAILY_LANE;
  const bucketLabel = details && typeof details.bucketLabel === "string" ? details.bucketLabel : "";
  const progressPercent = details && typeof details.progressPercent === "number" ? details.progressPercent : 0;

  return {
    actionId: row.id,
    occurredAt: row.createdAt,
    activityType,
    summary: summary ?? `${todoIssueId} · ${lane} · ${progressPercent}%`,
    todoIssueId,
    lane,
    bucketLabel,
    progressPercent,
    evidenceTag: "EXTRACTED",
  };
}

function buildWikiMarkdown(input: { page: Rt2DailyWikiPage }) {
  const lines = [
    `# ${input.page.reportDate} Daily Wiki`,
    "",
    ...input.page.shortSummary.map((line) => `- ${line}`),
    "",
    "## History",
    ...(input.page.history.length > 0
      ? input.page.history.map((entry) => `- ${entry.summary}`)
      : ["- 오늘은 기록이 없습니다."]),
  ];
  return lines.join("\n");
}

export function rt2DailyReportService(db: Db) {
  async function getAssignedTodos(companyId: string, projectId: string, userId: string) {
    const todos = await db
      .select({
        todoIssueId: issues.id,
        taskIssueId: issues.parentId,
        todoTitle: issues.title,
        assigneeUserId: issues.assigneeUserId,
        todoStatus: issues.status,
        todoUpdatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.projectId, projectId),
          eq(issues.assigneeUserId, userId),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt));

    const taskIds = [
      ...new Set(
        todos
          .map((todo) => todo.taskIssueId)
          .filter((taskIssueId): taskIssueId is string => typeof taskIssueId === "string"),
      ),
    ];
    if (taskIds.length === 0) {
      return [];
    }

    const taskRows = await db
      .select({
        taskIssueId: rt2V33TaskProfiles.issueId,
        taskTitle: issues.title,
      })
      .from(rt2V33TaskProfiles)
      .innerJoin(issues, eq(rt2V33TaskProfiles.issueId, issues.id))
      .where(
        and(
          eq(rt2V33TaskProfiles.companyId, companyId),
          eq(rt2V33TaskProfiles.projectId, projectId),
          inArray(rt2V33TaskProfiles.issueId, taskIds),
        ),
      );

    const taskTitleById = new Map(taskRows.map((row) => [row.taskIssueId, row.taskTitle]));
    return todos
      .map((todo) => {
        if (!todo.taskIssueId) return null;
        const taskTitle = taskTitleById.get(todo.taskIssueId);
        if (!taskTitle) return null;
        return {
          todoIssueId: todo.todoIssueId,
          taskIssueId: todo.taskIssueId,
          taskTitle,
          todoTitle: todo.todoTitle,
          assigneeUserId: todo.assigneeUserId ?? userId,
          todoStatus: todo.todoStatus as Rt2DailyReportCard["status"],
          todoUpdatedAt: todo.todoUpdatedAt,
        } satisfies TodoRow;
      })
      .filter((row): row is TodoRow => row !== null);
  }

  async function listCards(companyId: string, projectId: string, userId: string, reportDate: string) {
    const todos = await getAssignedTodos(companyId, projectId, userId);
    if (todos.length === 0) {
      return [];
    }

    const persistedRows = await db
      .select()
      .from(rt2V33DailyReportCards)
      .where(
        and(
          eq(rt2V33DailyReportCards.companyId, companyId),
          eq(rt2V33DailyReportCards.projectId, projectId),
          eq(rt2V33DailyReportCards.userId, userId),
          eq(rt2V33DailyReportCards.reportDate, reportDate),
          inArray(rt2V33DailyReportCards.todoIssueId, todos.map((todo) => todo.todoIssueId)),
        ),
      );

    const persistedByTodoId = new Map(persistedRows.map((row) => [row.todoIssueId, row]));
    return todos.map((todo) => {
      const persisted = persistedByTodoId.get(todo.todoIssueId);
      return {
        taskIssueId: todo.taskIssueId,
        todoIssueId: todo.todoIssueId,
        taskTitle: todo.taskTitle,
        todoTitle: todo.todoTitle,
        assigneeUserId: todo.assigneeUserId,
        reportDate,
        lane: (persisted?.lane as Rt2DailyLane | undefined) ?? DEFAULT_DAILY_LANE,
        bucketLabel: persisted?.bucketLabel ?? "",
        progressPercent: defaultProgressPercent(todo.todoStatus, persisted?.progressPercent ?? null),
        note: persisted?.note ?? "",
        status: (persisted?.status ?? todo.todoStatus) as Rt2DailyReportCard["status"],
        updatedAt: persisted?.updatedAt ?? todo.todoUpdatedAt,
      } satisfies Rt2DailyReportCard;
    });
  }

  async function materializeDailyWikiPage(
    txDb: Db,
    companyId: string,
    projectId: string,
    userId: string,
    reportDate: string,
  ): Promise<Rt2DailyWikiPage> {
    const pageKey = dailyReportKey(projectId, userId, reportDate);
    const logs = await txDb
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "rt2_daily_report"),
          eq(activityLog.entityId, pageKey),
        ),
      )
      .orderBy(asc(activityLog.createdAt));

    const history = logs
      .map(buildHistoryEntry)
      .filter((entry): entry is Rt2DailyActivityEntry => entry !== null);
    const shortSummary =
      history.length > 0 ? history.slice(-3).map((entry) => entry.summary) : ["오늘은 기록이 없습니다."];
    const page: Rt2DailyWikiPage = {
      pageKey,
      companyId,
      projectId,
      userId,
      reportDate,
      shortSummary,
      markdown: "",
      history,
    };
    const markdown = buildWikiMarkdown({ page });
    const [saved] = await txDb
      .insert(rt2V33DailyWikiPages)
      .values({
        companyId,
        projectId,
        userId,
        reportDate,
        pageKey,
        shortSummary,
        markdown,
        history,
      })
      .onConflictDoUpdate({
        target: [rt2V33DailyWikiPages.companyId, rt2V33DailyWikiPages.pageKey],
        set: {
          projectId,
          userId,
          reportDate,
          shortSummary,
          markdown,
          history,
          updatedAt: new Date(),
        },
      })
      .returning();

    return {
      pageKey: saved.pageKey,
      companyId: saved.companyId,
      projectId: saved.projectId,
      userId: saved.userId,
      reportDate: saved.reportDate,
      shortSummary: saved.shortSummary,
      markdown: saved.markdown,
      history: saved.history as Rt2DailyActivityEntry[],
    };
  }

  async function getTodoContext(txDb: Db, companyId: string, todoIssueId: string) {
    const todo = await txDb
      .select({
        todoIssueId: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        parentId: issues.parentId,
        todoTitle: issues.title,
        todoStatus: issues.status,
        assigneeUserId: issues.assigneeUserId,
        todoUpdatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(eq(issues.id, todoIssueId))
      .then((rows) => rows[0] ?? null);

    if (!todo || todo.companyId !== companyId || !todo.projectId || !todo.parentId) {
      throw notFound("RT2 daily report todo not found");
    }

    const task = await txDb
      .select({
        taskIssueId: rt2V33TaskProfiles.issueId,
        taskTitle: issues.title,
      })
      .from(rt2V33TaskProfiles)
      .innerJoin(issues, eq(rt2V33TaskProfiles.issueId, issues.id))
      .where(
        and(
          eq(rt2V33TaskProfiles.companyId, companyId),
          eq(rt2V33TaskProfiles.projectId, todo.projectId),
          eq(rt2V33TaskProfiles.issueId, todo.parentId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!task) {
      throw notFound("RT2 daily report todo not found");
    }

    if (!todo.assigneeUserId) {
      throw forbidden("RT2_DAILY_REPORT_CARD_REQUIRES_ASSIGNEE");
    }

    return {
      ...todo,
      taskTitle: task.taskTitle,
      taskIssueId: task.taskIssueId,
    };
  }

  async function saveDailyCard(
    companyId: string,
    actorUserId: string,
    todoIssueId: string,
    input: UpsertRt2DailyReportCard,
  ) {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const todo = await getTodoContext(txDb, companyId, todoIssueId);
      if (todo.assigneeUserId !== actorUserId) {
        throw forbidden("RT2_DAILY_REPORT_CARD_REQUIRES_BOARD_ASSIGNEE");
      }
      if (todo.projectId !== input.projectId) {
        throw notFound("RT2 daily report todo not found");
      }

      const reportKey = dailyReportKey(input.projectId, actorUserId, input.reportDate);
      const previousRow = await txDb
        .select()
        .from(rt2V33DailyReportCards)
        .where(
          and(
            eq(rt2V33DailyReportCards.companyId, companyId),
            eq(rt2V33DailyReportCards.projectId, input.projectId),
            eq(rt2V33DailyReportCards.userId, actorUserId),
            eq(rt2V33DailyReportCards.reportDate, input.reportDate),
            eq(rt2V33DailyReportCards.todoIssueId, todoIssueId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      const note = normalizeNullableText(input.note ?? null);
      const bucketLabel = normalizeNullableText(input.bucketLabel ?? null);
      const [savedRow] = await txDb
        .insert(rt2V33DailyReportCards)
        .values({
          companyId,
          projectId: input.projectId,
          userId: actorUserId,
          reportDate: input.reportDate,
          taskIssueId: todo.taskIssueId,
          todoIssueId,
          assigneeUserId: actorUserId,
          taskTitle: todo.taskTitle,
          todoTitle: todo.todoTitle,
          lane: input.lane,
          bucketLabel,
          progressPercent: input.progressPercent,
          note,
          status: todo.todoStatus,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            rt2V33DailyReportCards.companyId,
            rt2V33DailyReportCards.projectId,
            rt2V33DailyReportCards.userId,
            rt2V33DailyReportCards.reportDate,
            rt2V33DailyReportCards.todoIssueId,
          ],
          set: {
            taskIssueId: todo.taskIssueId,
            assigneeUserId: actorUserId,
            taskTitle: todo.taskTitle,
            todoTitle: todo.todoTitle,
            lane: input.lane,
            bucketLabel,
            progressPercent: input.progressPercent,
            note,
            status: todo.todoStatus,
            updatedAt: new Date(),
          },
        })
        .returning();

      const activityType = inferActivityType(previousRow, input);
      const summary = buildCardSummary({
        todoTitle: todo.todoTitle,
        lane: input.lane,
        bucketLabel,
        progressPercent: input.progressPercent,
        note,
      });
      await txDb.insert(activityLog).values({
        companyId,
        actorType: "user",
        actorId: actorUserId,
        action: activityType,
        entityType: "rt2_daily_report",
        entityId: reportKey,
        details: {
          reportKey,
          companyId,
          projectId: input.projectId,
          reportDate: input.reportDate,
          taskIssueId: todo.taskIssueId,
          taskTitle: todo.taskTitle,
          todoIssueId,
          todoTitle: todo.todoTitle,
          assigneeUserId: actorUserId,
          lane: input.lane,
          bucketLabel,
          progressPercent: input.progressPercent,
          note,
          status: todo.todoStatus,
          activityType,
          summary,
        },
      });

      return {
        card: {
          taskIssueId: savedRow.taskIssueId,
          todoIssueId: savedRow.todoIssueId,
          taskTitle: savedRow.taskTitle,
          todoTitle: savedRow.todoTitle,
          assigneeUserId: savedRow.assigneeUserId,
          reportDate: savedRow.reportDate,
          lane: savedRow.lane as Rt2DailyLane,
          bucketLabel: savedRow.bucketLabel ?? "",
          progressPercent: savedRow.progressPercent,
          note: savedRow.note ?? "",
          status: savedRow.status as Rt2DailyReportCard["status"],
          updatedAt: savedRow.updatedAt,
        } satisfies Rt2DailyReportCard,
      };
    });
  }

  async function materializeAndGetDailyWiki(
    companyId: string,
    projectId: string,
    userId: string,
    reportDate: string,
  ) {
    return materializeDailyWikiPage(db, companyId, projectId, userId, reportDate);
  }

  async function queryDailyWiki(companyId: string, projectId: string, userId: string, reportDate: string) {
    const page = await materializeAndGetDailyWiki(companyId, projectId, userId, reportDate);
    return {
      question: "오늘 뭐 했지?" as const,
      answerLines: page.shortSummary.length > 0 ? page.shortSummary : ["오늘은 기록이 없습니다."],
      evidence: page.history,
    } satisfies Rt2DailyWikiAnswer;
  }

  return {
    listDailyBoard: async (companyId: string, userId: string, projectId: string, reportDate: string): Promise<Rt2DailyBoard> => ({
      companyId,
      projectId,
      userId,
      reportDate,
      cards: await listCards(companyId, projectId, userId, reportDate),
    }),
    saveDailyCard,
    materializeDailyWikiPage: materializeAndGetDailyWiki,
    queryDailyWiki,
  };
}
