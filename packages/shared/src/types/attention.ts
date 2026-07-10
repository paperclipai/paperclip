export type AttentionSourceKind =
  | "approval"
  | "issue_thread_interaction"
  | "join_request"
  | "recovery_action"
  | "productivity_review"
  | "blocker_attention"
  | "review"
  | "failed_run"
  | "budget_alert"
  | "agent_error_alert";

export type AttentionSubjectKind =
  | "approval"
  | "issue"
  | "interaction"
  | "join_request"
  | "recovery_action"
  | "run"
  | "budget_incident"
  | "agent";

export type AttentionSeverity = "critical" | "high" | "medium" | "low";

export interface AttentionSubject {
  kind: AttentionSubjectKind;
  id: string;
  companyId: string;
  title: string | null;
  identifier: string | null;
  status: string | null;
  href: string | null;
  metadata?: Record<string, unknown>;
}

export interface AttentionDecisionVerb {
  id: string;
  label: string;
  description: string | null;
}

export interface AttentionItem {
  id: string;
  companyId: string;
  sourceKind: AttentionSourceKind;
  subject: AttentionSubject;
  whyNow: string;
  decisionVerbs: AttentionDecisionVerb[];
  inlineResolvable: boolean;
  entryRule: string;
  exitRule: string;
  dedupKey: string;
  dismissalKey: string;
  severity: AttentionSeverity;
  rank: number;
  activityAt: string;
  createdAt: string;
  updatedAt: string;
  relatedIssue: AttentionSubject | null;
}

export interface AttentionFeed {
  companyId: string;
  generatedAt: string;
  totalCount: number;
  countsBySourceKind: Record<AttentionSourceKind, number>;
  items: AttentionItem[];
}
