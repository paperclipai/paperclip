import type { IssuePriority, IssueStatus } from "../constants.js";
import type { Goal } from "./goal.js";
import type { AcceptedPlanDecompositionStatus } from "./issue.js";

export interface GoalMapStatusCounts {
  total: number;
  backlog: number;
  todo: number;
  inProgress: number;
  inReview: number;
  done: number;
  blocked: number;
  cancelled: number;
}

export interface GoalMapRootIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  rationale: string | null;
  updatedAt: Date | string;
}

export interface GoalMapDecompositionSummary {
  sourceIssueId: string;
  sourceIssueIdentifier: string | null;
  sourceIssueTitle: string;
  status: AcceptedPlanDecompositionStatus;
  childCount: number;
  ownerAgentId: string | null;
  createdAt: Date | string;
}

export interface GoalMapNode {
  goal: Goal;
  /** Issues assigned directly to this goal (hidden issues excluded). */
  counts: GoalMapStatusCounts;
  /** Direct counts plus all descendant goals' counts. */
  subtreeCounts: GoalMapStatusCounts;
  /** Issues in this goal whose parent is absent or belongs to another goal. */
  rootIssues: GoalMapRootIssue[];
  rootIssuesTruncated: boolean;
  /** Accepted-plan decompositions whose source issue belongs to this goal. */
  decompositions: GoalMapDecompositionSummary[];
  /** Open blocker issues in other goals that gate work in this goal. */
  inboundOpenGateCount: number;
  gated: boolean;
}

export type GoalMapEdge =
  | {
    kind: "parent";
    fromGoalId: string;
    toGoalId: string;
  }
  | {
    kind: "gates";
    fromGoalId: string;
    toGoalId: string;
    openIssueCount: number;
    totalIssueCount: number;
  };

export interface GoalMapResponse {
  nodes: GoalMapNode[];
  edges: GoalMapEdge[];
}
