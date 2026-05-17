export type ContractType =
  | "telegram-origin"
  | "bridge-dispatched"
  | "code-change"
  | "design-only"
  | "meta-no-artifact";

export type VerificationResult =
  | { ok: true }
  | { ok: false; missing: string; evidenceQuery: string };

export interface IssueForContracts {
  id: string;
  title: string;
  description: string | null;
  originKind: string;
  labels: Array<{ name: string }>;
}

export interface CommentForContracts {
  id: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: Date;
}

export interface ContractEvaluationContext {
  issueId: string;
  agentId: string | null;
  evaluator: "gate" | "preflight" | "audit";
}
