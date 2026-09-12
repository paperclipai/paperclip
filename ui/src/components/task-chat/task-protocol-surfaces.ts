import { t } from "@/i18n";

const PROTOCOL_RATIONALE_KEYS: Readonly<Record<string, string>> = {
  "Provider-neutral semantic activity is readable in the task turn.": "localizationTaskRuntime.protocolRationale.ui_Provider_neutral_semantic_activity_is_readable_in_the_task_turn_jl3y9t",
  "In-progress workspace changes update one diff card.": "localizationTaskRuntime.protocolRationale.ui_In_progress_workspace_changes_update_one_diff_card_1sfjyq6",
  "The runner-verified final diff replaces the in-progress revision.": "localizationTaskRuntime.protocolRationale.ui_The_runner_verified_final_diff_replaces_the_in_progress_revision_yc856m",
  "Verified references open a bounded preview and the production file viewer.": "localizationTaskRuntime.protocolRationale.ui_Verified_references_open_a_bounded_preview_and_the_production_fil_1ttu25k",
  "Semantic operations reuse the production tool row.": "localizationTaskRuntime.protocolRationale.ui_Semantic_operations_reuse_the_production_tool_row_gynv1",
  "Semantic operation outcomes update the matching tool row.": "localizationTaskRuntime.protocolRationale.ui_Semantic_operation_outcomes_update_the_matching_tool_row_1ebb69k",
  "Recovered semantic operation outcomes update the matching tool row without duplicating it.": "localizationTaskRuntime.protocolRationale.ui_Recovered_semantic_operation_outcomes_update_the_matching_tool_ro_12cpdfi",
  "MCP inputs reuse the production tool row.": "localizationTaskRuntime.protocolRationale.ui_MCP_inputs_reuse_the_production_tool_row_14rmssm",
  "MCP outcomes update the matching tool row.": "localizationTaskRuntime.protocolRationale.ui_MCP_outcomes_update_the_matching_tool_row_13ztgdl",
  "Action requests materialize as authoritative issue-thread interactions.": "localizationTaskRuntime.protocolRationale.ui_Action_requests_materialize_as_authoritative_issue_thread_interac_1winryg",
  "Action resolution is shown on the authoritative interaction card.": "localizationTaskRuntime.protocolRationale.ui_Action_resolution_is_shown_on_the_authoritative_interaction_card_1w9ocl9",
  "Pending provider runtime requests remain visible and actionable when a resolver is available.": "localizationTaskRuntime.protocolRationale.ui_Pending_provider_runtime_requests_remain_visible_and_actionable_w_1pvk456",
  "Resolution updates the existing request card.": "localizationTaskRuntime.protocolRationale.ui_Resolution_updates_the_existing_request_card_1w5r6zi",
  "Expiry updates the existing request card.": "localizationTaskRuntime.protocolRationale.ui_Expiry_updates_the_existing_request_card_op6e7d",
  "Cancellation updates the existing request card.": "localizationTaskRuntime.protocolRationale.ui_Cancellation_updates_the_existing_request_card_13uw1u1",
  "The control-plane interaction record is canonical and owns rendering.": "localizationTaskRuntime.protocolRationale.ui_The_control_plane_interaction_record_is_canonical_and_owns_render_cqfmtb",
  "Structured completion, evidence, verification, blockers, and artifacts remain inspectable.": "localizationTaskRuntime.protocolRationale.ui_Structured_completion_evidence_verification_blockers_and_artifact_1hnvwrr",
  "Acceptance updates the existing result without duplicating it.": "localizationTaskRuntime.protocolRationale.ui_Acceptance_updates_the_existing_result_without_duplicating_it_1w479g2",
  "Rejected results remain part of run governance rather than a second completion card.": "localizationTaskRuntime.protocolRationale.ui_Rejected_results_remain_part_of_run_governance_rather_than_a_seco_1jx4tyw",
  "Terminal outcome and stop reason remain visible.": "localizationTaskRuntime.protocolRationale.ui_Terminal_outcome_and_stop_reason_remain_visible_1b522ns",
  "Routine lifecycle transitions are summarized by the run turn and composer state.": "localizationTaskRuntime.protocolRationale.ui_Routine_lifecycle_transitions_are_summarized_by_the_run_turn_and__eaciu4",
  "Actionable failure text is folded into the run or system notice.": "localizationTaskRuntime.protocolRationale.ui_Actionable_failure_text_is_folded_into_the_run_or_system_notice_149l5uu",
  "Item payloads normalize into messages, reasoning, tools, diffs, or usage.": "localizationTaskRuntime.protocolRationale.ui_Item_payloads_normalize_into_messages_reasoning_tools_diffs_or_us_1toxmnr",
  "Sandbox telemetry is available in run details, not the primary task thread.": "localizationTaskRuntime.protocolRationale.ui_Sandbox_telemetry_is_available_in_run_details_not_the_primary_tas_bdtg6d",
  "MCP application transport lifecycle remains in run details unless it produces an actionable failure.": "localizationTaskRuntime.protocolRationale.ui_MCP_application_transport_lifecycle_remains_in_run_details_unless_12vbvpu",
  "Authoritative task status, attention, and interaction records own this state.": "localizationTaskRuntime.protocolRationale.ui_Authoritative_task_status_attention_and_interaction_records_own_t_1xv2a7l",
  "Permission choices render on the runtime request card.": "localizationTaskRuntime.protocolRationale.ui_Permission_choices_render_on_the_runtime_request_card_z7bvgp",
  "Structured runtime input renders on the runtime request card.": "localizationTaskRuntime.protocolRationale.ui_Structured_runtime_input_renders_on_the_runtime_request_card_1wegt4y",
  "Uses the production confirmation card.": "localizationTaskRuntime.protocolRationale.ui_Uses_the_production_confirmation_card_31qpx2",
  "Uses the production bounded checkbox card.": "localizationTaskRuntime.protocolRationale.ui_Uses_the_production_bounded_checkbox_card_1pzoq4l",
  "Uses the production per-item verdict card.": "localizationTaskRuntime.protocolRationale.ui_Uses_the_production_per_item_verdict_card_1j708l7",
  "Uses the production typed question controls.": "localizationTaskRuntime.protocolRationale.ui_Uses_the_production_typed_question_controls_g1stgr",
  "Uses the production task suggestion tree.": "localizationTaskRuntime.protocolRationale.ui_Uses_the_production_task_suggestion_tree_19isd68",
};

/** Read-time localization only; the registry remains the raw protocol contract. */
export function taskProtocolRationaleDisplay(registration: TaskProtocolSurfaceRegistration): string {
  const key = PROTOCOL_RATIONALE_KEYS[registration.rationale];
  return key ? t(key) : registration.rationale;
}


/**
 * Exhaustive product disposition for Paperclip Runner Protocol surfaces.
 *
 * This is intentionally separate from the renderer: adding a protocol event
 * must be a conscious product decision even when the decision is to fold it
 * into an existing turn or keep it in DevTools. The contract test compares
 * these keys with the canonical JSON schemas.
 */
export type TaskProtocolDisposition = "inline" | "folded" | "debug-only";

export interface TaskProtocolSurfaceRegistration {
  disposition: TaskProtocolDisposition;
  surface: string;
  story: string | null;
  rationale: string;
}

const inline = (surface: string, story: string, rationale: string): TaskProtocolSurfaceRegistration => ({
  disposition: "inline",
  surface,
  story,
  rationale,
});

const folded = (surface: string, rationale: string): TaskProtocolSurfaceRegistration => ({
  disposition: "folded",
  surface,
  story: null,
  rationale,
});

const debugOnly = (surface: string, rationale: string): TaskProtocolSurfaceRegistration => ({
  disposition: "debug-only",
  surface,
  story: null,
  rationale,
});

const providerEvents = [
  "plan.updated",
  "tool.execution.started", "tool.execution.progressed", "tool.execution.completed",
  "research.started", "research.progressed", "research.completed",
  "delegation.started", "delegation.updated", "delegation.completed",
  "model.route.changed", "model.verification.updated", "context.compacted",
  "artifact.viewed", "artifact.generated", "review.mode.changed",
  "hook.started", "hook.completed", "memory.citation.referenced",
  "safety.review.started", "safety.review.completed", "terminal.input.sent",
  "wait.started", "wait.completed", "provider.notice.recorded",
] as const;

const runnerLifecycleEvents = [
  "runner.connected", "runner.reconnected", "runner.reconciled", "runner.disconnected",
  "runner.draining", "runner.backpressure", "runner.suspending", "runner.suspended", "runner.stopped",
  "runtime.phase.changed", "workspace.ready",
  "harness.starting", "harness.ready", "harness.exited",
  "session.starting", "session.started", "session.resuming", "session.resumed",
  "session.reconciled", "session.updated", "session.closed",
  "turn.submitted", "turn.accepted", "turn.started", "turn.completed",
  "run.attached", "run.detached",
] as const;

const diagnosticEvents = [
  "runner.diagnostic", "harness.diagnostic", "session.failed", "turn.failed",
  "turn.interrupted", "turn.cancelled", "item.failed",
] as const;

const itemEvents = ["item.started", "item.delta", "item.completed", "usage.reported"] as const;

const mcpLifecycleEvents = [
  "mcp_app.discovered", "mcp_app.resource.resolved", "mcp_app.initializing", "mcp_app.ready",
  "mcp_app.host_context.changed", "mcp_app.failed", "mcp_app.teardown",
] as const;

const interactionLifecycleEvents = [
  "interaction.request.proposed", "interaction.request.materialized", "interaction.request.rejected",
  "interaction.response.progressed", "interaction.response.resolved", "interaction.response.delivered",
] as const;

const governanceEvents = [
  "attention.request.proposed", "attention.request.routed", "attention.request.resolved",
  "attention.request.expired", "attention.request.superseded", "work.assessment.recorded",
  "issue.status.decision.recorded", "issue.status.decision.applied", "issue.status.decision.rejected",
  "issue.status.decision.superseded",
] as const;

export const TASK_PROTOCOL_EVENT_SURFACE_REGISTRY: Readonly<Record<string, TaskProtocolSurfaceRegistration>> = Object.freeze({
  ...Object.fromEntries(providerEvents.map((eventType) => [eventType, inline("provider_activity", "Task Page/Runner Protocol/Provider semantics", "Provider-neutral semantic activity is readable in the task turn.")])),
  "workspace.change.updated": inline("workspace_change", "Task Page/Runner Protocol/Workspace changes", "In-progress workspace changes update one diff card."),
  "workspace.diff.recorded": inline("workspace_change", "Task Page/Runner Protocol/Workspace changes", "The runner-verified final diff replaces the in-progress revision."),
  "workspace.file.referenced": inline("workspace_file", "Task Page/Runner Protocol/File references", "Verified references open a bounded preview and the production file viewer."),
  "semantic_tool.input": folded("tool", "Semantic operations reuse the production tool row."),
  "semantic_tool.result": folded("tool", "Semantic operation outcomes update the matching tool row."),
  "semantic_tool.reconciled": folded("tool", "Recovered semantic operation outcomes update the matching tool row without duplicating it."),
  "mcp_app.tool_input": folded("tool", "MCP inputs reuse the production tool row."),
  "mcp_app.tool_result": folded("tool", "MCP outcomes update the matching tool row."),
  "mcp_app.action.requested": folded("interaction", "Action requests materialize as authoritative issue-thread interactions."),
  "mcp_app.action.resolved": folded("interaction", "Action resolution is shown on the authoritative interaction card."),
  "runtime_request.created": inline("runtime_request", "Task Page/Runner Protocol/Runtime requests", "Pending provider runtime requests remain visible and actionable when a resolver is available."),
  "runtime_request.resolved": folded("runtime_request", "Resolution updates the existing request card."),
  "runtime_request.expired": folded("runtime_request", "Expiry updates the existing request card."),
  "runtime_request.cancelled": folded("runtime_request", "Cancellation updates the existing request card."),
  ...Object.fromEntries(interactionLifecycleEvents.map((eventType) => [eventType, folded("interaction", "The control-plane interaction record is canonical and owns rendering." )])),
  "run.result.proposed": inline("run_result", "Task Page/Runner Protocol/Results and terminal states", "Structured completion, evidence, verification, blockers, and artifacts remain inspectable."),
  "run.result.accepted": folded("run_result", "Acceptance updates the existing result without duplicating it."),
  "run.result.rejected": folded("run_result", "Rejected results remain part of run governance rather than a second completion card."),
  "run.terminal": inline("run_terminal", "Task Page/Runner Protocol/Results and terminal states", "Terminal outcome and stop reason remain visible."),
  ...Object.fromEntries(runnerLifecycleEvents.map((eventType) => [eventType, folded("turn", "Routine lifecycle transitions are summarized by the run turn and composer state.")])),
  ...Object.fromEntries(diagnosticEvents.map((eventType) => [eventType, folded("system_notice", "Actionable failure text is folded into the run or system notice.")])),
  ...Object.fromEntries(itemEvents.map((eventType) => [eventType, folded("conversation_or_tool", "Item payloads normalize into messages, reasoning, tools, diffs, or usage." )])),
  "sandbox.metric": debugOnly("run_debug", "Sandbox telemetry is available in run details, not the primary task thread."),
  ...Object.fromEntries(mcpLifecycleEvents.map((eventType) => [eventType, debugOnly("run_debug", "MCP application transport lifecycle remains in run details unless it produces an actionable failure.")])),
  ...Object.fromEntries(governanceEvents.map((eventType) => [eventType, folded("governance", "Authoritative task status, attention, and interaction records own this state." )])),
});

export const TASK_PROTOCOL_REQUEST_SURFACE_REGISTRY = Object.freeze({
  "runtime.permission": inline("runtime_request", "Task Page/Runner Protocol/Runtime requests", "Permission choices render on the runtime request card."),
  "runtime.input": inline("runtime_request", "Task Page/Runner Protocol/Runtime requests", "Structured runtime input renders on the runtime request card."),
  "issue_thread.request_confirmation": inline("interaction", "Task Page/Runner Protocol/Interactions", "Uses the production confirmation card."),
  "issue_thread.request_checkbox_confirmation": inline("interaction", "Task Page/Runner Protocol/Interactions", "Uses the production bounded checkbox card."),
  "issue_thread.request_item_verdicts": inline("interaction", "Task Page/Runner Protocol/Interactions", "Uses the production per-item verdict card."),
  "issue_thread.ask_user_questions": inline("interaction", "Task Page/Runner Protocol/Interactions", "Uses the production typed question controls."),
  "issue_thread.suggest_tasks": inline("interaction", "Task Page/Runner Protocol/Interactions", "Uses the production task suggestion tree."),
});

export const TASK_PROTOCOL_RESULT_DISPOSITION_REGISTRY = Object.freeze({
  done: "run_result",
  blocked: "run_result",
  needs_review: "run_result",
  yielded: "run_result",
} as const);

export const TASK_PROTOCOL_TURN_TERMINAL_REGISTRY = Object.freeze({
  completed: "run_terminal",
  failed: "run_terminal",
  interrupted: "run_terminal",
  cancelled: "run_terminal",
} as const);

export const TASK_PROTOCOL_RUN_TERMINAL_REGISTRY = Object.freeze({
  succeeded: "run_terminal",
  failed: "run_terminal",
  cancelled: "run_terminal",
} as const);
