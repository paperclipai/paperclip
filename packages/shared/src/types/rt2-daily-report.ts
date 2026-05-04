import type { Rt2BoardQualityStatus, Rt2DeliverableKind } from "./rt2-task.js";

export type Rt2DailyLane = "todo" | "doing" | "done";

export type Rt2DailyDeliverableOwner = "task" | "todo";
export type Rt2DailyApprovalWaitingSource = "none" | "deliverable_review" | "quality_review_proxy";
export type Rt2DailyOkrSource = "direct_task" | "inherited_project" | "none";

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
  deliverableId?: string | null;
  deliverableTitle?: string | null;
  deliverableType?: Rt2DeliverableKind | null;
  deliverableRequired?: boolean;
  deliverableOwner?: Rt2DailyDeliverableOwner | null;
  deliverableSource?: Rt2DailyDeliverableOwner | null;
  deliverableMissing?: boolean;
  basePriceTotal: number;
  qualityStatus: Rt2BoardQualityStatus;
  qualityLabel?: string;
  approvalWaiting?: boolean;
  approvalWaitingSource?: Rt2DailyApprovalWaitingSource;
  okrContextStatus: "connected" | "missing_goal";
  okrSource?: Rt2DailyOkrSource;
  directGoalId?: string | null;
  directGoalTitle?: string | null;
  inheritedGoalId?: string | null;
  inheritedGoalTitle?: string | null;
  reportDateMatchesBoard?: boolean;
  actorMatchesAssignee?: boolean;
  assigneeDisplayName?: string | null;
  searchText?: string;
  searchableLabels?: string[];
  dueDate?: string | null;
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

export type Rt2DailyHierarchyNodeKind = "mission" | "objective" | "key_result" | "goal" | "project" | "task" | "todo";

export interface Rt2DailyHierarchyNode {
  id: string;
  kind: Rt2DailyHierarchyNodeKind;
  title: string;
  status: string;
  parentId: string | null;
}

export interface Rt2DailyHierarchyRollup {
  status: Rt2DailyReportCard["status"];
  progressPercent: number;
  deliverableCount: number;
  submittedDeliverableCount: number;
  goldImpact: number;
  gapFlags: Rt2DailyGapFlag[];
}

export interface Rt2DailyHierarchyRow {
  taskIssueId: string;
  todoIssueId: string;
  path: Rt2DailyHierarchyNode[];
  rollup: Rt2DailyHierarchyRollup;
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
  hierarchyRows: Rt2DailyHierarchyRow[];
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
