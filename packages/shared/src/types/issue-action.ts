import type { IssueActionType, IssueStatus } from "../constants.js";
import type { Issue, IssueComment } from "./issue.js";

export type IssueActionQaVerdictState = "pass" | "warn" | "fail" | "na";
export type IssueActionOpenStatus = Exclude<IssueStatus, "done" | "cancelled">;

export interface IssueActionQaSummary {
  codeQuality: IssueActionQaVerdictState;
  errorHandling: IssueActionQaVerdictState;
  testCoverage: IssueActionQaVerdictState;
  commentQuality: IssueActionQaVerdictState;
  docsImpact: IssueActionQaVerdictState;
}

export interface IssueActionQaVerification {
  typecheck: IssueActionQaVerdictState;
  tests: IssueActionQaVerdictState;
  build: IssueActionQaVerdictState;
  smoke: IssueActionQaVerdictState;
}

export interface EnterReviewIssueActionPayload {
  body?: string | null;
}

export interface SubmitQaVerdictIssueActionPayload {
  summary: IssueActionQaSummary;
  verification: IssueActionQaVerification;
  qaPass: boolean;
  releaseConfirmed: boolean;
  summaryText?: string | null;
  verificationText?: string | null;
}

export interface CompleteIssueActionPayload {
  body?: string | null;
}

export interface ReopenIssueActionPayload {
  status?: IssueActionOpenStatus;
  body?: string | null;
}

export interface HandoffIssueActionPayload {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  body: string;
  reopen?: boolean;
}

export interface AppendNoteIssueActionPayload {
  body: string;
  reopen?: boolean;
}

export type IssueActionRequest =
  | { type: "enter_review"; payload: EnterReviewIssueActionPayload }
  | { type: "submit_qa_verdict"; payload: SubmitQaVerdictIssueActionPayload }
  | { type: "complete_issue"; payload: CompleteIssueActionPayload }
  | { type: "reopen_issue"; payload: ReopenIssueActionPayload }
  | { type: "handoff_issue"; payload: HandoffIssueActionPayload }
  | { type: "append_note"; payload: AppendNoteIssueActionPayload };

export interface IssueActionWarning {
  code: string;
  message: string;
}

export interface IssueActionResult {
  type: IssueActionType;
  issue: Issue;
  comment: IssueComment | null;
  generatedCommentBody?: string | null;
  warnings?: IssueActionWarning[];
}
