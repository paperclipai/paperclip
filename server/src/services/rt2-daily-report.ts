import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  goals,
  issues,
  issueWorkProducts,
  projects,
  projectGoals,
  rt2V33DailyReportCards,
  rt2V33DailyWikiPages,
  rt2V33TaskProfiles,
} from "@paperclipai/db";
import type {
  Rt2BoardQualityStatus,
  Rt2DailyCockpit,
  Rt2DailyActivityEntry,
  Rt2DailyApprovalWaitingSource,
  Rt2DailyDeliverableOwner,
  Rt2DailyGapFlag,
  Rt2DailyActivityType,
  Rt2DailyBoard,
  Rt2DailyHierarchyNode,
  Rt2DailyLane,
  Rt2DailyOkrSource,
  Rt2DailyOkrNode,
  Rt2DailyReportCard,
  Rt2DailyWikiAnswer,
  Rt2DailyWikiPage,
  UpdateRt2DailyCardLane,
  UpdateRt2DailyCardOkr,
  UpdateRt2DailyCardQuality,
  UpdateRt2DailyCardTitle,
  UpsertRt2DailyCardDeliverable,
  UpsertRt2DailyReportCard,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { rt2WorkBoardService } from "./rt2-work-board.js";

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
type WorkProductRow = typeof issueWorkProducts.$inferSelect;

const DEFAULT_DAILY_LANE: Rt2DailyLane = "todo";
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

function normalizeDailyLane(value: unknown): Rt2DailyLane {
  if (value === "todo" || value === "doing" || value === "done") return value;
  if (value === "today") return "todo";
  if (value === "support_1") return "doing";
  if (value === "support_2") return "done";
  return DEFAULT_DAILY_LANE;
}

function readRt2WorkProductMetadata(row: WorkProductRow) {
  return row.metadata && typeof row.metadata === "object" ? row.metadata : null;
}

function isRt2Deliverable(row: WorkProductRow) {
  return row.type === "rt2_deliverable" || readRt2WorkProductMetadata(row)?.rt2Deliverable === true;
}

function readBasePrice(row: WorkProductRow) {
  const metadata = readRt2WorkProductMetadata(row);
  return typeof metadata?.rt2BasePrice === "number" ? metadata.rt2BasePrice : 0;
}

function readDeliverableType(row: WorkProductRow) {
  const metadata = readRt2WorkProductMetadata(row);
  if (metadata?.rt2Type === "document" || metadata?.rt2Type === "artifact") return metadata.rt2Type;
  if (row.type === "document" || row.type === "artifact") return row.type;
  return null;
}

function readDeliverableRequired(row: WorkProductRow) {
  const metadata = readRt2WorkProductMetadata(row);
  return typeof metadata?.rt2Required === "boolean" ? metadata.rt2Required : true;
}

function readDeliverableOwner(row: WorkProductRow): Rt2DailyDeliverableOwner | null {
  const metadata = readRt2WorkProductMetadata(row);
  if (metadata?.rt2Owner === "task" || metadata?.rt2Owner === "todo") return metadata.rt2Owner;
  return null;
}

function isSubmittedDeliverable(row: WorkProductRow) {
  const metadata = readRt2WorkProductMetadata(row);
  return row.status === "submitted" || metadata?.rt2State === "submitted";
}

function resolveDeliverableQualityStatus(rows: WorkProductRow[]): Rt2BoardQualityStatus {
  if (rows.some((row) => row.reviewState === "needs_work" || row.reviewState === "changes_requested")) return "needs_work";
  if (rows.some((row) => row.reviewState !== "none")) return "reviewed";
  if (rows.some(isSubmittedDeliverable)) return "pending_review";
  return "none";
}

function resolveQualityStatus(rows: WorkProductRow[], boardStatus?: Rt2BoardQualityStatus): Rt2BoardQualityStatus {
  if (boardStatus && boardStatus !== "none") return boardStatus;
  return resolveDeliverableQualityStatus(rows);
}

function qualityLabel(status: Rt2BoardQualityStatus) {
  switch (status) {
    case "pending_review":
      return "검토 대기";
    case "reviewed":
      return "검토 완료";
    case "needs_work":
      return "수정 필요";
    case "none":
    default:
      return "없음";
  }
}

function approvalWaitingFor(status: Rt2BoardQualityStatus): { approvalWaiting: boolean; approvalWaitingSource: Rt2DailyApprovalWaitingSource } {
  return {
    approvalWaiting: status === "pending_review" || status === "needs_work",
    approvalWaitingSource: "deliverable_review",
  };
}

function pickPrimaryDeliverable(input: {
  taskDeliverables: WorkProductRow[];
  todoDeliverables: WorkProductRow[];
}) {
  const todoPrimary = input.todoDeliverables.find((row) => row.isPrimary) ?? input.todoDeliverables[0] ?? null;
  const taskPrimary = input.taskDeliverables.find((row) => row.isPrimary) ?? input.taskDeliverables[0] ?? null;
  return todoPrimary ?? taskPrimary;
}

function buildSearchText(input: {
  taskTitle: string;
  todoTitle: string;
  assigneeUserId: string;
  deliverableTitle: string | null;
  qualityLabel: string;
  directGoalTitle: string | null;
  inheritedGoalTitle: string | null;
  status: string;
}) {
  return [
    input.taskTitle,
    input.todoTitle,
    input.assigneeUserId,
    input.deliverableTitle,
    input.qualityLabel,
    input.directGoalTitle,
    input.inheritedGoalTitle,
    input.status,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function summarizeGoldImpact(basePriceTotal: number) {
  return Math.max(0, Math.round(basePriceTotal * 0.01));
}

function summarizeXpImpact(basePriceTotal: number, submittedDeliverableCount: number) {
  return Math.max(0, Math.round(basePriceTotal * 0.005) + submittedDeliverableCount * 5);
}

function hierarchyKindForGoalLevel(level: string): Rt2DailyHierarchyNode["kind"] {
  const normalized = level.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "mission") return "mission";
  if (normalized === "objective") return "objective";
  if (normalized === "key_result" || normalized === "kr") return "key_result";
  return "goal";
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
  const lane = normalizeDailyLane(details?.lane);
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

    const deliverableIssueIds = [...new Set(todos.flatMap((todo) => [todo.taskIssueId, todo.todoIssueId]))];
    const deliverableRows = deliverableIssueIds.length > 0
      ? await db
          .select()
          .from(issueWorkProducts)
          .where(
            and(
              eq(issueWorkProducts.companyId, companyId),
              inArray(issueWorkProducts.issueId, deliverableIssueIds),
            ),
          )
      : [];
    const deliverablesByIssueId = new Map<string, WorkProductRow[]>();
    for (const deliverable of deliverableRows) {
      if (!isRt2Deliverable(deliverable)) continue;
      const bucket = deliverablesByIssueId.get(deliverable.issueId) ?? [];
      bucket.push(deliverable);
      deliverablesByIssueId.set(deliverable.issueId, bucket);
    }

    const [taskProfiles, projectGoalRows, projectRow, workBoardOverview] = await Promise.all([
      db
        .select({
          taskIssueId: rt2V33TaskProfiles.issueId,
          goalId: rt2V33TaskProfiles.goalId,
        })
        .from(rt2V33TaskProfiles)
        .where(
          and(
            eq(rt2V33TaskProfiles.companyId, companyId),
            eq(rt2V33TaskProfiles.projectId, projectId),
            inArray(rt2V33TaskProfiles.issueId, [...new Set(todos.map((todo) => todo.taskIssueId))]),
          ),
        ),
      db
        .select({ goalId: projectGoals.goalId })
        .from(projectGoals)
        .where(and(eq(projectGoals.companyId, companyId), eq(projectGoals.projectId, projectId))),
      db
        .select({ goalId: projects.goalId })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
        .then((rows) => rows[0] ?? null),
      rt2WorkBoardService(db).getBoardOverview(companyId, todos.map((todo) => todo.todoIssueId)),
    ]);
    const taskGoalIdByIssueId = new Map(taskProfiles.map((profile) => [profile.taskIssueId, profile.goalId ?? null]));
    const projectFallbackGoalId = projectRow?.goalId ?? projectGoalRows[0]?.goalId ?? null;
    const goalIds = [
      ...new Set(
        [
          ...taskProfiles.map((profile) => profile.goalId).filter((goalId): goalId is string => Boolean(goalId)),
          projectFallbackGoalId,
        ].filter((goalId): goalId is string => Boolean(goalId)),
      ),
    ];
    const goalRows = goalIds.length > 0
      ? await db
          .select({ id: goals.id, title: goals.title })
          .from(goals)
          .where(and(eq(goals.companyId, companyId), inArray(goals.id, goalIds)))
      : [];
    const goalTitleById = new Map(goalRows.map((goal) => [goal.id, goal.title]));
    const boardMetaByIssueId = new Map(workBoardOverview.cards.map((card) => [card.issueId, card]));

    const persistedByTodoId = new Map(persistedRows.map((row) => [row.todoIssueId, row]));
    return todos.map((todo) => {
      const persisted = persistedByTodoId.get(todo.todoIssueId);
      const taskDeliverables = deliverablesByIssueId.get(todo.taskIssueId) ?? [];
      const todoDeliverables = deliverablesByIssueId.get(todo.todoIssueId) ?? [];
      const allDeliverables = [...taskDeliverables, ...todoDeliverables];
      const deliverableCount = allDeliverables.length;
      const submittedDeliverableCount = allDeliverables.filter(isSubmittedDeliverable).length;
      const basePriceTotal = allDeliverables.reduce((total, deliverable) => total + readBasePrice(deliverable), 0);
      const primaryDeliverable = pickPrimaryDeliverable({ taskDeliverables, todoDeliverables });
      const directGoalId = taskGoalIdByIssueId.get(todo.taskIssueId) ?? null;
      const inheritedGoalId = directGoalId ? null : projectFallbackGoalId;
      const okrSource: Rt2DailyOkrSource = directGoalId ? "direct_task" : inheritedGoalId ? "inherited_project" : "none";
      const boardMeta = boardMetaByIssueId.get(todo.todoIssueId);
      const resolvedQualityStatus = resolveQualityStatus(allDeliverables, boardMeta?.qualityStatus);
      const resolvedQualityLabel = qualityLabel(resolvedQualityStatus);
      const approval = approvalWaitingFor(resolvedQualityStatus);
      const deliverableTitle = primaryDeliverable?.title ?? null;
      const gapFlags: Rt2DailyGapFlag[] = [];
      if (deliverableCount === 0) gapFlags.push("missing_deliverable");
      if (!(directGoalId ?? inheritedGoalId)) gapFlags.push("missing_okr_context");
      return {
        taskIssueId: todo.taskIssueId,
        todoIssueId: todo.todoIssueId,
        taskTitle: todo.taskTitle,
        todoTitle: todo.todoTitle,
        assigneeUserId: todo.assigneeUserId,
        reportDate,
        lane: persisted ? normalizeDailyLane(persisted.lane) : DEFAULT_DAILY_LANE,
        bucketLabel: persisted?.bucketLabel ?? "",
        progressPercent: defaultProgressPercent(todo.todoStatus, persisted?.progressPercent ?? null),
        note: persisted?.note ?? "",
        status: (persisted?.status ?? todo.todoStatus) as Rt2DailyReportCard["status"],
        updatedAt: persisted?.updatedAt ?? todo.todoUpdatedAt,
        deliverableCount,
        submittedDeliverableCount,
        taskDeliverableCount: taskDeliverables.length,
        deliverableId: primaryDeliverable?.id ?? null,
        deliverableTitle,
        deliverableType: primaryDeliverable ? readDeliverableType(primaryDeliverable) : null,
        deliverableRequired: primaryDeliverable ? readDeliverableRequired(primaryDeliverable) : false,
        deliverableOwner: primaryDeliverable
          ? primaryDeliverable.issueId === todo.taskIssueId
            ? "task"
            : "todo"
          : null,
        deliverableSource: primaryDeliverable ? readDeliverableOwner(primaryDeliverable) : null,
        deliverableMissing: deliverableCount === 0,
        basePriceTotal,
        qualityStatus: resolvedQualityStatus,
        qualityLabel: resolvedQualityLabel,
        ...approval,
        okrContextStatus: (directGoalId ?? inheritedGoalId) ? "connected" : "missing_goal",
        okrSource,
        directGoalId,
        directGoalTitle: directGoalId ? goalTitleById.get(directGoalId) ?? null : null,
        inheritedGoalId,
        inheritedGoalTitle: inheritedGoalId ? goalTitleById.get(inheritedGoalId) ?? null : null,
        reportDateMatchesBoard: todo.todoUpdatedAt.toISOString().slice(0, 10) === reportDate,
        actorMatchesAssignee: todo.assigneeUserId === userId,
        assigneeDisplayName: todo.assigneeUserId,
        searchText: buildSearchText({
          taskTitle: todo.taskTitle,
          todoTitle: todo.todoTitle,
          assigneeUserId: todo.assigneeUserId,
          deliverableTitle,
          qualityLabel: resolvedQualityLabel,
          directGoalTitle: directGoalId ? goalTitleById.get(directGoalId) ?? null : null,
          inheritedGoalTitle: inheritedGoalId ? goalTitleById.get(inheritedGoalId) ?? null : null,
          status: persisted?.status ?? todo.todoStatus,
        }),
        searchableLabels: [
          todo.taskTitle,
          todo.todoTitle,
          todo.assigneeUserId,
          deliverableTitle,
          resolvedQualityLabel,
          directGoalId ? goalTitleById.get(directGoalId) ?? null : null,
          inheritedGoalId ? goalTitleById.get(inheritedGoalId) ?? null : null,
        ].filter((value): value is string => Boolean(value)),
        dueDate: boardMeta?.dueDate ?? null,
        gapFlags,
      } satisfies Rt2DailyReportCard;
    });
  }

  async function buildGoalPaths(companyId: string, seedGoalIds: string[]) {
    if (seedGoalIds.length === 0) return new Map<string, Rt2DailyOkrNode[]>();

    const allGoals = await db
      .select({
        id: goals.id,
        title: goals.title,
        level: goals.level,
        status: goals.status,
        parentId: goals.parentId,
      })
      .from(goals)
      .where(eq(goals.companyId, companyId));
    const goalById = new Map(allGoals.map((goal) => [goal.id, goal]));
    const paths = new Map<string, Rt2DailyOkrNode[]>();

    for (const seedGoalId of seedGoalIds) {
      const path: Rt2DailyOkrNode[] = [];
      const seen = new Set<string>();
      let cursor: string | null = seedGoalId;
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const goal = goalById.get(cursor);
        if (!goal) break;
        path.unshift({
          id: goal.id,
          title: goal.title,
          level: goal.level,
          status: goal.status,
          parentId: goal.parentId ?? null,
        });
        cursor = goal.parentId ?? null;
      }
      paths.set(seedGoalId, path);
    }

    return paths;
  }

  async function buildCockpit(companyId: string, projectId: string, cards: Rt2DailyReportCard[]): Promise<Rt2DailyCockpit> {
    const project = await db
      .select({
        id: projects.id,
        title: projects.name,
        status: projects.status,
        goalId: projects.goalId,
      })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
      .then((rows) => rows[0] ?? null);

    const taskIds = [...new Set(cards.map((card) => card.taskIssueId))];
    const [taskProfiles, projectGoalRows] = await Promise.all([
      taskIds.length > 0
        ? db
            .select({
              taskIssueId: rt2V33TaskProfiles.issueId,
              goalId: rt2V33TaskProfiles.goalId,
            })
            .from(rt2V33TaskProfiles)
            .where(
              and(
                eq(rt2V33TaskProfiles.companyId, companyId),
                eq(rt2V33TaskProfiles.projectId, projectId),
                inArray(rt2V33TaskProfiles.issueId, taskIds),
              ),
            )
        : [],
      db
        .select({ goalId: projectGoals.goalId })
        .from(projectGoals)
        .where(and(eq(projectGoals.companyId, companyId), eq(projectGoals.projectId, projectId))),
    ]);
    const taskGoalById = new Map(taskProfiles.map((profile) => [profile.taskIssueId, profile.goalId ?? null]));
    const projectFallbackGoalId = project?.goalId ?? projectGoalRows[0]?.goalId ?? null;
    const seedGoalIds = [
      ...new Set([
        ...taskProfiles.map((profile) => profile.goalId).filter((goalId): goalId is string => Boolean(goalId)),
        ...(projectFallbackGoalId ? [projectFallbackGoalId] : []),
      ]),
    ];
    const goalPaths = await buildGoalPaths(companyId, seedGoalIds);

    const traceRows = cards.map((card) => {
      const taskGoalId = taskGoalById.get(card.taskIssueId) ?? projectFallbackGoalId;
      const goalPath = taskGoalId ? goalPaths.get(taskGoalId) ?? [] : [];
      const gapFlags = [...card.gapFlags];
      if (goalPath.length === 0 && !gapFlags.includes("missing_okr_context")) {
        gapFlags.push("missing_okr_context");
      }
      return {
        taskIssueId: card.taskIssueId,
        todoIssueId: card.todoIssueId,
        taskTitle: card.taskTitle,
        todoTitle: card.todoTitle,
        projectId,
        projectTitle: project?.title ?? "Project",
        projectStatus: project?.status ?? "unknown",
        goalPath,
        gapFlags,
      };
    });
    const cardByTodoId = new Map(cards.map((card) => [card.todoIssueId, card]));
    const hierarchyRows = traceRows.map((trace) => {
      const card = cardByTodoId.get(trace.todoIssueId);
      const goalNodes: Rt2DailyHierarchyNode[] = trace.goalPath.map((goal) => ({
        id: goal.id,
        kind: hierarchyKindForGoalLevel(goal.level),
        title: goal.title,
        status: goal.status,
        parentId: goal.parentId,
      }));
      const projectNode: Rt2DailyHierarchyNode = {
        id: trace.projectId,
        kind: "project",
        title: trace.projectTitle,
        status: trace.projectStatus,
        parentId: goalNodes.at(-1)?.id ?? null,
      };
      const taskNode: Rt2DailyHierarchyNode = {
        id: trace.taskIssueId,
        kind: "task",
        title: trace.taskTitle,
        status: card?.status ?? "unknown",
        parentId: trace.projectId,
      };
      const todoNode: Rt2DailyHierarchyNode = {
        id: trace.todoIssueId,
        kind: "todo",
        title: trace.todoTitle,
        status: card?.status ?? "unknown",
        parentId: trace.taskIssueId,
      };

      return {
        taskIssueId: trace.taskIssueId,
        todoIssueId: trace.todoIssueId,
        path: [...goalNodes, projectNode, taskNode, todoNode],
        rollup: {
          status: card?.status ?? "todo",
          progressPercent: card?.progressPercent ?? 0,
          deliverableCount: card?.deliverableCount ?? 0,
          submittedDeliverableCount: card?.submittedDeliverableCount ?? 0,
          goldImpact: summarizeGoldImpact(card?.basePriceTotal ?? 0),
          gapFlags: trace.gapFlags,
        },
      };
    });

    const deliverablesDefined = cards.reduce((total, card) => total + card.deliverableCount, 0);
    const deliverablesSubmitted = cards.reduce((total, card) => total + card.submittedDeliverableCount, 0);
    const basePriceTotal = cards.reduce((total, card) => total + card.basePriceTotal, 0);
    const qualityStatus: Rt2DailyReportCard["qualityStatus"] = cards.some((card) => card.qualityStatus === "reviewed")
      ? "reviewed"
      : cards.some((card) => card.qualityStatus === "pending_review")
        ? "pending_review"
        : "none";
    const gapFlags = traceRows.flatMap((trace) =>
      trace.gapFlags.map((kind) => ({
        kind,
        taskIssueId: trace.taskIssueId,
        todoIssueId: trace.todoIssueId,
        label:
          kind === "missing_deliverable"
            ? `${trace.todoTitle}: 산출물이 없습니다`
            : `${trace.todoTitle}: OKR/KPI 상위 맥락이 없습니다`,
      })),
    );

    const summary = {
      tasksWorked: new Set(cards.map((card) => card.taskIssueId)).size,
      todosCompleted: cards.filter((card) => card.status === "done" || card.progressPercent >= 100).length,
      deliverablesDefined,
      deliverablesSubmitted,
      effortNoteCount: cards.filter((card) => card.note.trim().length > 0).length,
      goldImpact: summarizeGoldImpact(basePriceTotal),
      xpImpact: summarizeXpImpact(basePriceTotal, deliverablesSubmitted),
      qualityStatus,
    };

    return {
      summary,
      traceRows,
      hierarchyRows,
      gapFlags,
      aiSummary: [
        `${summary.tasksWorked}개 task, ${summary.todosCompleted}개 to-do가 오늘 보고에 연결되었습니다.`,
        `${summary.deliverablesDefined}개 산출물과 ${summary.goldImpact} gold 영향이 확인되었습니다.`,
        gapFlags.length > 0 ? `${gapFlags.length}개 context/deliverable gap을 먼저 보완해야 합니다.` : "산출물과 OKR 맥락이 연결되어 있습니다.",
      ],
    };
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

  async function assertDailyCardMutationContext(
    txDb: Db,
    companyId: string,
    actorUserId: string,
    todoIssueId: string,
    projectId: string,
  ) {
    const todo = await getTodoContext(txDb, companyId, todoIssueId);
    if (todo.assigneeUserId !== actorUserId) {
      throw forbidden("RT2_DAILY_REPORT_CARD_REQUIRES_BOARD_ASSIGNEE");
    }
    if (todo.projectId !== projectId) {
      throw notFound("RT2 daily report todo not found");
    }
    return todo;
  }

  async function getUpdatedDailyCard(
    companyId: string,
    actorUserId: string,
    projectId: string,
    reportDate: string,
    todoIssueId: string,
  ) {
    const card = (await listCards(companyId, projectId, actorUserId, reportDate)).find(
      (candidate) => candidate.todoIssueId === todoIssueId,
    );
    if (!card) throw notFound("RT2 daily report todo not found");
    return card;
  }

  async function saveDailyCard(
    companyId: string,
    actorUserId: string,
    todoIssueId: string,
    input: UpsertRt2DailyReportCard,
  ) {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const todo = await assertDailyCardMutationContext(txDb, companyId, actorUserId, todoIssueId, input.projectId);

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

      void savedRow;
    });

    return {
      card: await getUpdatedDailyCard(companyId, actorUserId, input.projectId, input.reportDate, todoIssueId),
    };
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
    updateCardTitle: async (
      companyId: string,
      actorUserId: string,
      todoIssueId: string,
      input: UpdateRt2DailyCardTitle & { projectId: string; reportDate: string },
    ) => {
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await assertDailyCardMutationContext(txDb, companyId, actorUserId, todoIssueId, input.projectId);
        const now = new Date();
        await txDb
          .update(issues)
          .set({ title: input.title, updatedAt: now })
          .where(and(eq(issues.companyId, companyId), eq(issues.projectId, input.projectId), eq(issues.id, todoIssueId)));
        await txDb
          .update(rt2V33DailyReportCards)
          .set({ todoTitle: input.title, updatedAt: now })
          .where(
            and(
              eq(rt2V33DailyReportCards.companyId, companyId),
              eq(rt2V33DailyReportCards.projectId, input.projectId),
              eq(rt2V33DailyReportCards.userId, actorUserId),
              eq(rt2V33DailyReportCards.reportDate, input.reportDate),
              eq(rt2V33DailyReportCards.todoIssueId, todoIssueId),
            ),
          );
      });

      return {
        card: await getUpdatedDailyCard(companyId, actorUserId, input.projectId, input.reportDate, todoIssueId),
      };
    },

    updateCardLane: async (
      companyId: string,
      actorUserId: string,
      todoIssueId: string,
      input: UpdateRt2DailyCardLane & { projectId: string; reportDate: string },
    ) => {
      const current = await getUpdatedDailyCard(companyId, actorUserId, input.projectId, input.reportDate, todoIssueId);
      return saveDailyCard(companyId, actorUserId, todoIssueId, {
        projectId: input.projectId,
        reportDate: input.reportDate,
        lane: input.lane,
        bucketLabel: current.bucketLabel,
        progressPercent: current.progressPercent,
        note: current.note,
      });
    },

    upsertCardDeliverable: async (
      companyId: string,
      actorUserId: string,
      todoIssueId: string,
      input: UpsertRt2DailyCardDeliverable & { projectId: string; reportDate: string },
    ) => {
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const todo = await assertDailyCardMutationContext(txDb, companyId, actorUserId, todoIssueId, input.projectId);
        const deliverableRows = await txDb
          .select()
          .from(issueWorkProducts)
          .where(
            and(
              eq(issueWorkProducts.companyId, companyId),
              inArray(issueWorkProducts.issueId, [todo.todoIssueId, todo.taskIssueId]),
            ),
          )
          .orderBy(desc(issueWorkProducts.isPrimary), asc(issueWorkProducts.createdAt));
        const rt2Deliverables = deliverableRows.filter(isRt2Deliverable);
        const existing =
          rt2Deliverables.find((row) => row.issueId === todo.todoIssueId) ??
          rt2Deliverables.find((row) => row.issueId === todo.taskIssueId) ??
          null;
        const metadata = {
          ...(existing ? readRt2WorkProductMetadata(existing) ?? {} : {}),
          rt2Deliverable: true,
          rt2State: existing?.status === "submitted" ? "submitted" : "defined",
          rt2Type: input.type,
          rt2Owner: existing?.issueId === todo.taskIssueId ? "task" : "todo",
          rt2Required: input.required,
          rt2BasePrice: input.basePrice,
        };
        const now = new Date();
        if (existing) {
          await txDb
            .update(issueWorkProducts)
            .set({
              title: input.title,
              type: input.type,
              metadata,
              updatedAt: now,
            })
            .where(and(eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.id, existing.id)));
        } else {
          await txDb.insert(issueWorkProducts).values({
            companyId,
            projectId: input.projectId,
            issueId: todoIssueId,
            type: input.type,
            provider: "paperclip",
            title: input.title,
            status: "draft",
            reviewState: "none",
            isPrimary: true,
            summary: null,
            metadata,
          });
        }
      });

      return {
        card: await getUpdatedDailyCard(companyId, actorUserId, input.projectId, input.reportDate, todoIssueId),
      };
    },

    updateCardQuality: async (
      companyId: string,
      actorUserId: string,
      todoIssueId: string,
      input: UpdateRt2DailyCardQuality & { projectId: string; reportDate: string },
    ) => {
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await assertDailyCardMutationContext(txDb, companyId, actorUserId, todoIssueId, input.projectId);
      });
      await rt2WorkBoardService(db).updateCard(companyId, todoIssueId, actorUserId, {
        qualityStatus: input.qualityStatus,
      });

      return {
        card: await getUpdatedDailyCard(companyId, actorUserId, input.projectId, input.reportDate, todoIssueId),
      };
    },

    updateCardOkr: async (
      companyId: string,
      actorUserId: string,
      todoIssueId: string,
      input: UpdateRt2DailyCardOkr & { projectId: string; reportDate: string },
    ) => {
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const todo = await assertDailyCardMutationContext(txDb, companyId, actorUserId, todoIssueId, input.projectId);
        await txDb
          .update(rt2V33TaskProfiles)
          .set({ goalId: input.goalId, updatedAt: new Date() })
          .where(
            and(
              eq(rt2V33TaskProfiles.companyId, companyId),
              eq(rt2V33TaskProfiles.projectId, input.projectId),
              eq(rt2V33TaskProfiles.issueId, todo.taskIssueId),
            ),
          );
      });

      return {
        card: await getUpdatedDailyCard(companyId, actorUserId, input.projectId, input.reportDate, todoIssueId),
      };
    },

    listDailyBoard: async (companyId: string, userId: string, projectId: string, reportDate: string): Promise<Rt2DailyBoard> => {
      const cards = await listCards(companyId, projectId, userId, reportDate);
      return {
        companyId,
        projectId,
        userId,
        reportDate,
        cards,
        cockpit: await buildCockpit(companyId, projectId, cards),
      };
    },
    saveDailyCard,
    materializeDailyWikiPage: materializeAndGetDailyWiki,
    queryDailyWiki,
  };
}
