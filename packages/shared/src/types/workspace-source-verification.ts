import type { EnvironmentLeasePolicy } from "../constants.js";

export const WORKSPACE_SOURCE_VERIFICATION_REASONS = [
  "source_run_missing", "recovery_action_missing", "recovery_action_run_mismatch", "source_run_not_terminal",
  "source_issue_mismatch", "native_reference_invalid", "restore_reference_invalid", "historical_reference_invalid",
  "lease_reference_invalid", "source_lease_not_bound", "lease_issue_mismatch", "lease_environment_missing",
  "lease_allocation_missing", "lease_provider_invalid", "lease_policy_not_retained", "lease_cwd_invalid",
  "allocation_reference_mismatch", "cwd_reference_mismatch", "workspace_reference_mismatch",
  "recovery_lease_not_selected", "recovery_environment_mismatch", "recovery_lease_not_claimed",
  "recovery_owner_mismatch", "recovery_stop_intent_missing", "local_descriptor_invalid", "execution_target_invalid",
  "recovery_stop_intent_invalid", "reopened_allocation_mismatch", "reopened_cwd_mismatch",
] as const;

export interface WorkspaceSourceVerificationFailure {
  reason: (typeof WORKSPACE_SOURCE_VERIFICATION_REASONS)[number];
  observedLeasePolicy?: EnvironmentLeasePolicy | "unrecognized";
}

export type WorkspaceSourceInspection = {
  schema: "paperclip.workspace-source-inspection.v1";
  actionId: string;
  runId: string;
  observedAt: string;
  scope: "recorded_source_identity";
} & (
  | { status: "verified" }
  | { status: "blocked"; failureCode: string; sourceVerification?: WorkspaceSourceVerificationFailure }
  | { status: "not_inspected"; reason: "source_limit" }
);
