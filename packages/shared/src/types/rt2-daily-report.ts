export type Rt2DailyLane = "today" | "support_1" | "support_2";

export type Rt2DailyActivityType =
  | "todo_added"
  | "todo_moved"
  | "todo_progress_updated"
  | "todo_note_updated"
  | "todo_completed";

export interface Rt2DailyReportCard {
  taskIssueId: string;
  todoIssueId: string;
  taskTitle: string;
  todoTitle: string;
  assigneeUserId: string;
  reportDate: string;
  lane: Rt2DailyLane;
  bucketLabel: string;
  progressPercent: number;
  note: string;
  status: "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  updatedAt: Date;
  deliverableCount: number;
  submittedDeliverableCount: number;
  taskDeliverableCount: number;
  basePriceTotal: number;
  qualityStatus: "none" | "pending_review" | "reviewed";
  okrContextStatus: "connected" | "missing_goal";
  gapFlags: Rt2DailyGapFlag[];
}

export interface Rt2DailyBoard {
  companyId: string;
  projectId: string;
  userId: string;
  reportDate: string;
  cards: Rt2DailyReportCard[];
  cockpit: Rt2DailyCockpit;
}

export type Rt2DailyGapFlag = "missing_deliverable" | "missing_okr_context";

export interface Rt2DailyOkrNode {
  id: string;
  title: string;
  level: string;
  status: string;
  parentId: string | null;
}

export interface Rt2DailyTraceRow {
  taskIssueId: string;
  todoIssueId: string;
  taskTitle: string;
  todoTitle: string;
  projectId: string;
  projectTitle: string;
  projectStatus: string;
  goalPath: Rt2DailyOkrNode[];
  gapFlags: Rt2DailyGapFlag[];
}

export interface Rt2DailyCockpitSummary {
  tasksWorked: number;
  todosCompleted: number;
  deliverablesDefined: number;
  deliverablesSubmitted: number;
  effortNoteCount: number;
  goldImpact: number;
  xpImpact: number;
  qualityStatus: "none" | "pending_review" | "reviewed";
}

export interface Rt2DailyCockpit {
  summary: Rt2DailyCockpitSummary;
  traceRows: Rt2DailyTraceRow[];
  gapFlags: Array<{
    kind: Rt2DailyGapFlag;
    taskIssueId: string;
    todoIssueId: string;
    label: string;
  }>;
  aiSummary: string[];
}

export interface Rt2DailyActivityEntry {
  actionId: string;
  occurredAt: Date;
  activityType: Rt2DailyActivityType;
  summary: string;
  todoIssueId: string;
  lane: Rt2DailyLane;
  bucketLabel: string;
  progressPercent: number;
  evidenceTag: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
}

export interface Rt2DailyWikiPage {
  pageKey: string;
  companyId: string;
  projectId: string;
  userId: string;
  reportDate: string;
  shortSummary: string[];
  markdown: string;
  history: Rt2DailyActivityEntry[];
  sourceEventIds?: string[];
}

export interface Rt2DailyWikiPageList {
  companyId: string;
  pages: Rt2DailyWikiPage[];
}

export interface Rt2DailyWikiAnswer {
  question: "오늘 뭐 했지?";
  answerLines: string[];
  evidence: Rt2DailyActivityEntry[];
}
