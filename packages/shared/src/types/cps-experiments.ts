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

// Paper/experiment lifecycle progress sidecar (`PROGRESS.json`), schema
// cps.paper_progress.v1. Canonical stage order: intake -> decomposed ->
// inventory -> data_check -> replication -> oos_validation -> shadow -> dossier.
export type CpsPaperStage =
  | "intake"
  | "decomposed"
  | "inventory"
  | "data_check"
  | "replication"
  | "oos_validation"
  | "shadow"
  | "dossier"
  | string;

export type CpsPaperStageStatus = "done" | "in_progress" | "stuck" | "pending" | "skipped" | string;

export interface CpsPaperProgressBlocker {
  kind?: string;
  human_required?: boolean;
  humanRequired?: boolean;
  simple_ask?: string;
  simpleAsk?: string;
  link?: string;
  [key: string]: unknown;
}

export interface CpsPaperProgressStage {
  stage: CpsPaperStage;
  status: CpsPaperStageStatus;
  at?: string;
  missing?: string[];
  note?: string;
  blocker?: CpsPaperProgressBlocker | null;
  [key: string]: unknown;
}

export interface CpsPaperProgress {
  schema: "cps.paper_progress.v1" | string;
  paper_id?: string;
  paperId?: string;
  updated_utc?: string;
  updatedUtc?: string;
  stages?: CpsPaperProgressStage[];
  [key: string]: unknown;
}

// One human-required blocker surfaced to the board, in simple language.
export interface CpsOperatorAction {
  experimentId: string;
  stage: string;
  kind: string | null;
  simpleAsk: string;
  link: string | null;
}

// Summary of append-only operator feedback labels for one experiment.
// LABELS.jsonl is append-only, so the last line per experiment is the latest.
export interface CpsOperatorLabelSummary {
  count: number;
  latestLabel: string | null;
  latestCorrectedVerdict: string | null;
  latestRouteToRole: string | null;
  latestComment: string | null;
  latestAt: string | null;
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
  operatorLabels?: CpsOperatorLabelSummary | null;
  progress?: CpsPaperProgress | null;
  progressPath?: string | null;
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
  | "archive_failure_with_learning"
  | "decompose_idea";

// E3 idea intake: the operator pastes an X post / article / paper on the board.
// The pasted text is the guaranteed snapshot (pages die); a URL fetch is
// best-effort extra. Decomposition + routing happen in the bounded CPS consumer
// via a decompose_idea run request — the board never runs research inline.
export type CpsIdeaSourceType = "x_post" | "article" | "paper" | "other";

export interface CreateCpsIdeaInput {
  sourceType: CpsIdeaSourceType;
  pastedText: string;
  url?: string | null;
  title?: string | null;
  notes?: string | null;
}

export interface CpsIdeaIntake {
  schema: "cps.idea_intake.v1";
  id: string;
  companyId: string;
  sourceType: CpsIdeaSourceType;
  title: string | null;
  url: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: "board";
  dir: string;
  snapshot: {
    pastedTextPath: string;
    htmlPath: string | null;
    fetchStatus: "ok" | "failed" | "skipped";
    fetchError: string | null;
  };
  runRequestId: string;
  progressPath: string;
}

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

// Mirrors the JUDGMENT.json blocker `route_to_role` enum. Note: the schema enum
// is `quant_review`, not the roles-table `quant_research`.
export type CpsJudgmentRouteRole =
  | "data_engineering"
  | "quant_review"
  | "platform_engineering"
  | "board"
  | "external_vendor"
  | string;

export interface CreateCpsJudgmentFeedbackInput {
  experimentId: string;
  label: CpsJudgmentFeedbackLabel;
  correctedVerdict?: string | null;
  routeToRole?: CpsJudgmentRouteRole | null;
  comment?: string | null;
}

export interface CpsJudgmentFeedback {
  schema: "cps.judgment_feedback.v1";
  id: string;
  companyId: string;
  experimentId: string;
  label: CpsJudgmentFeedbackLabel;
  correctedVerdict: string | null;
  routeToRole: CpsJudgmentRouteRole | null;
  comment: string | null;
  createdAt: string;
  createdBy: "board";
  judgmentPath: string | null;
  path: string;
  queuePath: string;
}

// E1 backtest worker queue surface (fincli.backtest_queue.v1). Read-only view
// of the shared pod backtest queue: pods submit via the CLI, a supervised
// dispatcher leases FIFO to free trusted local workers. Vast.ai / paid compute
// is never launched automatically — a starving queue becomes an operator ask.
export interface CpsBacktestQueueSummary {
  total: number;
  pending: number;
  leased: number;
  running: number;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
}

export interface CpsBacktestQueueLease {
  requestId: string | null;
  worker: string | null;
  pod: string | null;
}

export interface CpsBacktestQueueLastTick {
  status: string | null;
  atUtc: string | null;
  probedWorkers: Record<string, string>;
  reachableWorkers: string[];
  leased: CpsBacktestQueueLease[];
}

export interface CpsBacktestQueue {
  present: boolean;
  queuePath: string;
  updatedUtc: string | null;
  summary: CpsBacktestQueueSummary | null;
  oldestPendingAgeSeconds: number | null;
  lastTick: CpsBacktestQueueLastTick | null;
  stopPresent: boolean;
  // pending work exists but the last dispatcher tick found no reachable worker
  starving: boolean;
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
  labels: {
    total: number;
    experimentsLabeled: number;
    byLabel: Record<string, number>;
    labelsPath: string;
  };
  operatorActions: CpsOperatorAction[];
  backtestQueue: CpsBacktestQueue;
  datasetExport: {
    trainingPath: string;
    trainingRows: number | null;
    trainingUpdatedUtc: string | null;
    tinkerPath: string;
    tinkerRows: number | null;
    tinkerUpdatedUtc: string | null;
    evalPath: string;
    evalRows: number | null;
    evalUpdatedUtc: string | null;
    evalMinLabels: number;
    labeledJudgments: number;
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
