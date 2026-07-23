import type { IssueStatus } from "../constants.js";

export type DecisionEffectStaleness = "strict" | "lenient";
export type DecisionOptionStyle = "default" | "primary" | "destructive";

export interface DecisionInput {
  id: string;
  label: string;
  placeholder?: string | null;
  required?: boolean;
  maxLength?: number;
}

interface DecisionEffectBase {
  targetIssueId: string;
  staleness: DecisionEffectStaleness;
}

export interface CommentOnIssueDecisionEffect extends DecisionEffectBase {
  type: "comment_on_issue";
  bodyMarkdown: string;
}

export interface CreateIssueDecisionEffect extends DecisionEffectBase {
  type: "create_issue";
  draft: {
    title: string;
    description?: string | null;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    projectId?: string | null;
    goalId?: string | null;
    blockedByIssueIds?: string[];
  };
}

export interface UpdateIssueStatusDecisionEffect extends DecisionEffectBase {
  type: "update_issue_status";
  status: IssueStatus;
  comment?: string | null;
}

export interface AssignIssueDecisionEffect extends DecisionEffectBase {
  type: "assign_issue";
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  comment?: string | null;
}

export interface CancelIssueTreeDecisionEffect extends DecisionEffectBase {
  type: "cancel_issue_tree";
  staleness: "strict";
  reasonComment: string;
}

export interface ResolveBlockerDecisionEffect extends DecisionEffectBase {
  type: "resolve_blocker";
  removeBlockedByIssueIds: string[];
}

export type DecisionEffect =
  | CommentOnIssueDecisionEffect
  | CreateIssueDecisionEffect
  | UpdateIssueStatusDecisionEffect
  | AssignIssueDecisionEffect
  | CancelIssueTreeDecisionEffect
  | ResolveBlockerDecisionEffect;

export interface DecisionOption {
  id: string;
  label: string;
  description?: string | null;
  style?: DecisionOptionStyle;
  effects: DecisionEffect[];
}

export interface DecisionStatsCounts {
  proposed: number;
  accepted: number;
  rejected: number;
  expired: number;
}

export interface DecisionChosenOptionCount {
  optionId: string;
  count: number;
}

export interface DecisionRuleKeyStats extends DecisionStatsCounts {
  ruleKey: string | null;
  chosenOptions: DecisionChosenOptionCount[];
}

export interface DecisionStatsResponse {
  groupBy: "ruleKey";
  filters: {
    originAgentId: string | null;
    since: string | null;
  };
  totals: DecisionStatsCounts;
  groups: DecisionRuleKeyStats[];
}
