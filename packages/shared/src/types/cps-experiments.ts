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
}

export type CpsRunRequestAction =
  | "rerun_with_variant"
  | "investigate_near_miss"
  | "refresh_index"
  | "custom_bounded_research";

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
