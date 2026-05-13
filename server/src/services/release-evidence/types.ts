import type { ReleaseEvidence } from "@paperclipai/shared";

export const CLOSURE_GATE_ERROR_CODES = [
  "release_evidence_required",
  "release_evidence_schema_invalid",
  "sha_not_reachable_from_ref",
  "sha_predates_issue",
  "pr_not_merged",
  "pr_targets_wrong_ref",
  "pr_sha_not_reachable",
  "not_code_reason_too_short",
  "code_evidence_contradicts_not_code",
  "signer_not_release_owner",
  "signoff_comment_not_found",
  "signoff_author_mismatch",
  "signoff_regex_mismatch",
  "signoff_comment_wrong_scope",
  "signoff_sha_not_reachable",
  "repo_mismatch",
  "pr_not_linked_to_issue",
  "github_api_unavailable",
] as const;

export type ClosureGateErrorCode = (typeof CLOSURE_GATE_ERROR_CODES)[number];

export const CLOSURE_GATE_HINT =
  "Include releaseEvidence in the PATCH body. Run: scripts/paperclip-issue-update.sh --help";

export const NOT_CODE_GATE_LABEL = "not-code-gate";
export const CODE_TOUCHING_LABEL = "code-touching";

export type CodeTouchingDecision = {
  codeTouching: boolean;
  reason:
    | "label_not_code_gate_override"
    | "label_code_touching"
    | "workspace_diff_present"
    | "non_engineer_role_default_not_code"
    | "engineer_role_default_code_touching"
    | "parent_inherits_code_touching"
    | "default_not_code";
};

export type ClosureGateAccept = {
  ok: true;
  validated: ReleaseEvidence;
  githubApiCalled: boolean;
  degraded: boolean;
  detail?: Record<string, unknown>;
};

export type ClosureGateReject = {
  ok: false;
  errorCode: ClosureGateErrorCode;
  message: string;
  githubApiCalled: boolean;
  degraded: boolean;
  detail?: Record<string, unknown>;
};

export type ClosureGateOutcome = ClosureGateAccept | ClosureGateReject;
