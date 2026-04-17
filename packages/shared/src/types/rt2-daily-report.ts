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
}

export interface Rt2DailyBoard {
  companyId: string;
  projectId: string;
  userId: string;
  reportDate: string;
  cards: Rt2DailyReportCard[];
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
}

export interface Rt2DailyWikiAnswer {
  question: "오늘 뭐 했지?";
  answerLines: string[];
  evidence: Rt2DailyActivityEntry[];
}
