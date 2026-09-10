import type { IssuePriority, IssueStatus } from "../constants.js";

/**
 * Fixed page size for the bounded company coordination work list. The endpoint
 * exposes no limit parameter by design: this value is the contract.
 */
export const COORDINATION_WORK_PAGE_SIZE = 50;

/**
 * The only issue statuses the coordination work list returns. Terminal states
 * (done, cancelled) and delivery states (ready_to_merge, merging) are excluded
 * on purpose: the list answers "what can still be picked up or nudged".
 */
export const COORDINATION_WORK_OPEN_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
] as const satisfies readonly IssueStatus[];

export type CompanyCoordinationOpenStatus = (typeof COORDINATION_WORK_OPEN_STATUSES)[number];

/**
 * One bounded work row for a coordination caller. Deliberately narrow: no
 * description, no comments, no secrets, no metadata — only what a coordinator
 * needs to pick or route work.
 */
export interface CompanyCoordinationWorkItem {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  projectId: string | null;
  assigneeAgentId: string | null;
  executionRunId: string | null;
  project: CompanyCoordinationProjectRef | null;
}

export interface CompanyCoordinationProjectRef {
  id: string;
  name: string;
  leadAgentId: string | null;
}

export interface CompanyCoordinationWorkResponse {
  items: CompanyCoordinationWorkItem[];
  nextOffset: number | null;
}

/**
 * Durable result of one coordination handoff. `wakeRequestId` is null when the
 * existing wake machinery deferred, coalesced-without-new-request, or
 * policy-skipped the addressed wake; the comment on the lead issue is still the
 * durable coordination record.
 */
export interface CoordinationHandoffResponse {
  sourceIssueId: string;
  targetIssueId: string;
  leadAgentId: string;
  leadIssueId: string;
  commentId: string;
  wakeRequestId: string | null;
}

/** Activity-log action for the audited coordination notice. */
export const COORDINATION_HANDOFF_ACTIVITY_ACTION = "coordination.handoff_requested" as const;

/** Wake reason used on the addressed wake to the lead agent. */
export const COORDINATION_HANDOFF_WAKE_REASON = "coordination_handoff" as const;

/** Idempotency-key prefix recorded on the addressed wake request row. */
export const COORDINATION_HANDOFF_WAKE_IDEMPOTENCY_PREFIX = "coordination_handoff:" as const;
