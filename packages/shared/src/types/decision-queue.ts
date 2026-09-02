import type { AttentionSourceKind } from "./attention.js";

export type DecisionQueueSeedRuleSignal =
  | "issue_has_pull_request_work_product"
  | "plan_document_confirmation"
  | "ask_user_questions";

export interface DecisionQueueSeedRule {
  key: string;
  description: string;
  signal: DecisionQueueSeedRuleSignal;
}

export interface DecisionQueueItem {
  id: string;
  companyId: string;
  queueId: string;
  sourceKind: AttentionSourceKind;
  sourceId: string;
  addedByType: "agent" | "user" | "system";
  addedByAgentId: string | null;
  addedByUserId: string | null;
  addedByRunId: string | null;
  responsibleUserId: string | null;
  createdAt: Date;
}

export interface DecisionQueue {
  id: string;
  companyId: string;
  key: string;
  title: string;
  description: string | null;
  createdByType: "agent" | "user" | "system";
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  retentionDays: number | null;
  seedRules: DecisionQueueSeedRule[];
  seedRulesEnabled: boolean;
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type DecisionTriageDecideBy = "today" | "this_week" | "whenever" | string;

export interface DecisionTriage {
  id: string;
  companyId: string;
  sourceKind: AttentionSourceKind;
  sourceId: string;
  decideBy: DecisionTriageDecideBy | null;
  snoozedUntil: Date | null;
  setByType: "agent" | "user";
  setByAgentId: string | null;
  setByUserId: string | null;
  setByRunId: string | null;
  responsibleUserId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
