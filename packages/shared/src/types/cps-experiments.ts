// Read-only CPS experiment index surface.
//
// `GET /api/companies/:companyId/cps-experiments` exposes the local
// `/root/cps/var/self_practice/experiment-tracker-*/EXPERIMENTS_INDEX.json`
// artifact to Paperclip. This is an index of already-produced artifacts; it must
// never trigger experiments, broker actions, paid APIs, or signal publishing.

export type CpsExperimentKind =
  | "strategy_experiment"
  | "tool_or_repo_evaluation"
  | "autonomous_bundle"
  | "shadow_ledger"
  | "local_proxy_validation"
  | "paper_repair"
  | "artifact_dir"
  | "empty_scaffold"
  | string;

export type CpsExperimentStatus = "ok" | "empty" | "no_primary_json" | "invalid_primary_json" | string;

export type CpsJudgmentStatus = string;

export interface CpsExperimentJudgment {
  schema: "cps.experiment_judgment.v1" | string;
  experiment_id?: string;
  experimentId?: string;
  generated_utc?: string;
  generatedUtc?: string;
  source?: Record<string, unknown>;
  task_family?: string;
  taskFamily?: string;
  claim_type?: string;
  claimType?: string;
  rules_disclosure?: Record<string, unknown>;
  rulesDisclosure?: Record<string, unknown>;
  data_fit?: Record<string, unknown>;
  dataFit?: Record<string, unknown>;
  execution_fit?: Record<string, unknown>;
  executionFit?: Record<string, unknown>;
  result_verdict?: string;
  resultVerdict?: string;
  promotion_verdict?: string;
  promotionVerdict?: string;
  confidence?: number;
  blockers?: Array<Record<string, unknown>>;
  next_action?: Record<string, unknown>;
  nextAction?: Record<string, unknown>;
  operator_feedback?: Record<string, unknown>;
  operatorFeedback?: Record<string, unknown>;
  evidence_refs?: Record<string, unknown>;
  evidenceRefs?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CpsExperimentEntry {
  id: string;
  runId: string;
  path: string | null;
  absolutePath?: string | null;
  updatedUtc: string;
  kind: CpsExperimentKind;
  status: CpsExperimentStatus;
  decision: string | null;
  primaryJson: string | null;
  absolutePrimaryJson?: string | null;
  files: string[];
  summary: Record<string, unknown>;
  judgment?: CpsExperimentJudgment | null;
  judgmentPath?: string | null;
}

export type CpsRunRequestAction =
  | "rerun_with_variant"
  | "investigate_near_miss"
  | "refresh_index"
  | "custom_bounded_research"
  | "generate_judgment"
  | "revise_judgment_from_operator_label"
  | "delegate_quant_review"
  | "delegate_data_feasibility"
  | "run_next_safe_action"
  | "build_operator_dossier"
  | "archive_failure_with_learning";

export interface CreateCpsRunRequestInput {
  action: CpsRunRequestAction;
  experimentId?: string | null;
  prompt: string;
  maxRuntimeMinutes?: number;
  allowPaidData?: boolean;
  allowPaidCompute?: boolean;
}

export interface CpsRunRequest {
  schema: "cps.paperclip_run_request.v1";
  id: string;
  companyId: string;
  action: CpsRunRequestAction;
  experimentId: string | null;
  prompt: string;
  requestedAt: string;
  requestedBy: "board";
  status: "queued";
  maxRuntimeMinutes: number;
  safety: {
    brokerActions: false;
    signalPublishing: false;
    allowPaidData: boolean;
    allowPaidCompute: boolean;
    note: string;
  };
  path: string;
  queuePath: string;
}

export type CpsJudgmentFeedbackLabel =
  | "agree"
  | "disagree"
  | "too_optimistic"
  | "too_conservative"
  | "wrong_blocker"
  | "proceed_autonomously"
  | "archive"
  | "requires_approval"
  | string;

export interface CreateCpsJudgmentFeedbackInput {
  experimentId: string;
  label: CpsJudgmentFeedbackLabel;
  correctedVerdict?: string | null;
  comment?: string | null;
}

export interface CpsJudgmentFeedback {
  schema: "cps.judgment_feedback.v1";
  id: string;
  companyId: string;
  experimentId: string;
  label: CpsJudgmentFeedbackLabel;
  correctedVerdict: string | null;
  comment: string | null;
  createdAt: string;
  createdBy: "board";
  judgmentPath: string | null;
  path: string;
  queuePath: string;
}

export interface CpsExperimentOverview {
  companyId: string;
  generatedAt: string;
  source: {
    indexPath: string;
    present: boolean;
    stale: boolean;
    ageSeconds: number | null;
    schema: string | null;
    root: string | null;
  };
  counts: {
    total: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
    byDecision: Record<string, number>;
    strategyByDecision: Record<string, number>;
    evalByVerdict: Record<string, number>;
    judgmentByResultVerdict: Record<string, number>;
    judgmentByPromotionVerdict: Record<string, number>;
    judgmentByDataFit: Record<string, number>;
    judgmentByRulesDisclosure: Record<string, number>;
  };
  recent: CpsExperimentEntry[];
  entries: CpsExperimentEntry[];
  safety: {
    readOnly: true;
    brokerActions: false;
    paidComputeActions: false;
    paidDataActions: false;
    signalPublishing: false;
    note: string;
  };
}
