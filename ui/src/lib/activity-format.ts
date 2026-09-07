import { i18n, t } from "@/i18n";
import type { Agent } from "@paperclipai/shared";
import { companyUserProfileDisplayLabel, type CompanyUserProfile } from "./company-members";
import { formatReviewPolicyValue } from "./review-policy";

type ActivityDetails = Record<string, unknown> | null | undefined;

type ActivityParticipant = {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
};

type ActivityIssueReference = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
};

interface ActivityFormatOptions {
  agentMap?: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  currentUserId?: string | null;
}

// Keep the original codes here: normalizing arbitrary plugin/user actions can
// collide with a built-in code (for example issue.read_marked / issue_read.marked).
// These labels supplement the existing detail-aware formatters below.
const LOCALIZED_FALLBACK_ACTIVITY_ACTIONS = new Set<string>([
  "agent.approved",
  "agent.budget_updated",
  "agent.config_rolled_back",
  "agent.deleted",
  "agent.hire_created",
  "agent.instructions_bundle_updated",
  "agent.instructions_file_deleted",
  "agent.instructions_file_updated",
  "agent.instructions_path_updated",
  "agent.key_created",
  "agent.key_revoked",
  "agent.permissions_updated",
  "agent.runtime_session_reset",
  "agent.skills_synced",
  "agent.updated_from_join_replay",
  "agent_api_key.claimed",
  "approval.comment_added",
  "approval.requester_wakeup_failed",
  "approval.requester_wakeup_queued",
  "approval.resubmitted",
  "approval.review_path_wakeup_failed",
  "approval.review_path_wakeup_queued",
  "approval.revision_requested",
  "asset.created",
  "audit.exported",
  "auth.agent_jwt_run_header_mismatch",
  "auth.agent_key_missing_responsible_user",
  "authorization.grants_updated_by_plugin",
  "authorization.policy_updated_by_plugin",
  "board_api_key.created",
  "board_api_key.revoked",
  "budget.hard_threshold_crossed",
  "budget.incident_resolved",
  "budget.policy_upserted",
  "budget.soft_threshold_crossed",
  "built_in_agent.duplicate_resolved",
  "built_in_agent.provision_requested",
  "built_in_agent.provisioned",
  "built_in_agent.reconcile",
  "built_in_agent.reset",
  "built_in_agent.routine_reconciled",
  "built_in_agent.routine_reset",
  "built_in_agent.routine_run_triggered",
  "built_in_agent.routine_schedule_disabled",
  "built_in_agent.routine_schedule_enabled",
  "case.document_annotation_comment_added",
  "case.document_annotation_remapped",
  "case.document_annotation_thread_created",
  "case.document_annotation_thread_reopened",
  "case.document_annotation_thread_resolved",
  "company.archived",
  "company.branding_updated",
  "company.budget_updated",
  "company.created",
  "company.feedback_data_sharing_updated",
  "company.imported",
  "company.onboarding_seed_applied",
  "company.reactivated",
  "company.skill_audited",
  "company.skill_catalog_installed",
  "company.skill_catalog_updated",
  "company.skill_comment_created",
  "company.skill_comment_deleted",
  "company.skill_comment_updated",
  "company.skill_created",
  "company.skill_deleted",
  "company.skill_file_deleted",
  "company.skill_file_updated",
  "company.skill_forked",
  "company.skill_policy_replaced",
  "company.skill_policy_reset",
  "company.skill_renamed",
  "company.skill_reset",
  "company.skill_starred",
  "company.skill_test_harness_issue_cleaned_up",
  "company.skill_test_input_created",
  "company.skill_test_input_deleted",
  "company.skill_test_input_updated",
  "company.skill_test_run_cancelled",
  "company.skill_test_run_completed",
  "company.skill_test_run_created",
  "company.skill_test_run_deleted",
  "company.skill_test_run_template_created",
  "company.skill_test_run_template_deleted",
  "company.skill_test_run_template_updated",
  "company.skill_unstarred",
  "company.skill_update_installed",
  "company.skill_updated",
  "company.skill_version_created",
  "company.skills_imported",
  "company.skills_scanned",
  "company.updated",
  "company_member.access_updated",
  "company_member.archived",
  "company_member.permissions_updated",
  "company_member.updated",
  "company_member.updated_by_plugin",
  "composio.child_created",
  "composio.service_connect_started",
  "composio.service_disconnected",
  "connection_grant.audience_replaced",
  "connection_grant.created",
  "connection_grant.delegated",
  "connection_grant.delegation_revoked",
  "connection_grant.revoked",
  "connection_grant.updated",
  "connection_installs.changed",
  "connection_token.denied",
  "connection_token.minted",
  "cost.recorded",
  "cost.reported",
  "decision.cancelled",
  "decision.created",
  "decision.decided",
  "decision.dismissed",
  "decision.effect_executed",
  "decision.effect_failed",
  "decision.effect_skipped",
  "decision.expired",
  "decision_queue.created",
  "decision_queue.seeded",
  "decision_queue.updated",
  "decision_queue_item.added",
  "decision_queue_item.removed",
  "decision_queue_item.seeded",
  "decision_retention.archived",
  "decision_retention.auto_archived",
  "decision_retention.keep_updated",
  "decision_retention.revived",
  "decision_training.created",
  "decision_training.deleted",
  "decision_training.exported",
  "decision_training.notes_updated",
  "decision_training.read",
  "decision_triage.updated",
  "environment.created",
  "environment.custom_image_setup.cancelled",
  "environment.custom_image_setup.finished",
  "environment.custom_image_setup.started",
  "environment.custom_image_template.disabled",
  "environment.custom_image_template.relinked",
  "environment.custom_image_template.rolled_back",
  "environment.custom_image_terminal_session_token.created",
  "environment.deleted",
  "environment.lease_acquired",
  "environment.lease_released",
  "environment.managed_provider_unavailable_archived",
  "environment.probed",
  "environment.probed_unsaved",
  "environment.updated",
  "execution_workspace.branch_reconciled",
  "execution_workspace.dirty_worktree_quarantined",
  "execution_workspace.issue_terminal_archived",
  "execution_workspace.issue_terminal_cleanup_failed",
  "execution_workspace.reopen_failed",
  "execution_workspace.reopen_unconsumed",
  "execution_workspace.reopened",
  "execution_workspace.runtime_repair",
  "execution_workspace.runtime_restart",
  "execution_workspace.runtime_run",
  "execution_workspace.runtime_start",
  "execution_workspace.runtime_stop",
  "execution_workspace.source_issue_reopened",
  "execution_workspace.updated",
  "execution_workspace.workspace_validation_quarantined",
  "external_object.refresh_requested",
  "external_object.status_changed",
  "finance_event.reported",
  "folder.created",
  "folder.deleted",
  "folder.item_moved",
  "folder.moved",
  "folder.personal_ensured",
  "folder.updated",
  "goal.created",
  "goal.deleted",
  "goal.updated",
  "heartbeat.cancel_failed",
  "heartbeat.runtime_request_resolution_queued",
  "heartbeat.watchdog_decision_recorded",
  "heartbeat.watchdog_snoozed",
  "hire_hook.error",
  "hire_hook.failed",
  "hire_hook.succeeded",
  "inbox.agent_policy_updated",
  "inbox.dismissed",
  "inbox.restored",
  "inbox.snoozed",
  "instance.settings.experimental_updated",
  "instance.settings.general_updated",
  "instance.settings.updated",
  "instance.task_drain.started",
  "instance.task_drain.stopped",
  "invite.created",
  "invite.created_by_plugin",
  "invite.openclaw_prompt_created",
  "invite.revoked",
  "invite.revoked_by_plugin",
  "issue.admin_force_release",
  "issue.approval_linked",
  "issue.approval_unlinked",
  "issue.approvers_updated",
  "issue.assignment_wakeup_requested",
  "issue.attachment.read",
  "issue.attribution_spoof_rejected",
  "issue.attribution_spoof_stripped",
  "issue.blockers_resolved_wake_emitted",
  "issue.blockers_updated",
  "issue.checkout_lock_adopted",
  "issue.child_created",
  "issue.comment.created",
  "issue.commented",
  "issue.connection_intent_connected",
  "issue.connection_intent_declined",
  "issue.cross_issue_influence_cap_rejected",
  "issue.cross_issue_influence_observed",
  "issue.disposition_repair_escalated",
  "issue.disposition_repair_fingerprint_reset",
  "issue.disposition_repair_resolved",
  "issue.disposition_repair_scheduled",
  "issue.document_annotation_comment_added",
  "issue.document_annotation_remapped",
  "issue.document_annotation_thread_created",
  "issue.document_annotation_thread_reopened",
  "issue.document_annotation_thread_resolved",
  "issue.document_restored",
  "issue.document_upserted",
  "issue.feedback_vote_saved",
  "issue.file_resource_availability",
  "issue.file_resource_availability_denied",
  "issue.file_resource_content_denied",
  "issue.file_resource_content_read",
  "issue.file_resource_download",
  "issue.file_resource_download_denied",
  "issue.file_resource_list",
  "issue.file_resource_list_denied",
  "issue.file_resource_resolve",
  "issue.file_resource_resolve_denied",
  "issue.inbox_archived",
  "issue.inbox_touched",
  "issue.inbox_unarchived",
  "issue.low_trust_output_promoted",
  "issue.productivity_review_continuation_held",
  "issue.productivity_review_created",
  "issue.productivity_review_updated",
  "issue.question_response_delivered",
  "issue.question_response_delivery_failed",
  "issue.queued_comment_steered",
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.relations.updated",
  "issue.review_path_recovery_queued",
  "issue.reviewers_updated",
  "issue.scheduled_retry_retry_now",
  "issue.stale_lock_cleared",
  "issue.status_decision_recorded",
  "issue.task_watchdog_fingerprint_reviewed",
  "issue.task_watchdog_followups_serialized",
  "issue.task_watchdog_triggered",
  "issue.tree_cancel_status_updated",
  "issue.tree_control_previewed",
  "issue.tree_hold_created",
  "issue.tree_hold_released",
  "issue.tree_hold_run_interrupt_failed",
  "issue.tree_hold_run_interrupted",
  "issue.tree_hold_wakeup_deferred",
  "issue.tree_restore_status_updated",
  "issue.tree_restore_wakeup_requested",
  "issue.watchdog_created",
  "issue.watchdog_removed",
  "issue.watchdog_updated",
  "issue.work_product_created",
  "issue.work_product_deleted",
  "issue.work_product_updated",
  "issue.workspace_preflight_blocked",
  "join.approved",
  "join.rejected",
  "join.request_replayed",
  "join.requested",
  "label.created",
  "label.deleted",
  "managed_agent_profile.upserted",
  "native.cancellation_dispatch_acknowledged",
  "native.cancellation_intent_recorded",
  "paperclip_cloud_connector.enrollment_completed",
  "paperclip_cloud_connector.enrollment_started",
  "pipeline.case_document_created",
  "pipeline.case_document_restored",
  "pipeline.case_document_updated",
  "pipeline.stage_automation_env_updated",
  "plugin.managed_agent.created",
  "plugin.managed_agent.pause_reason_backfilled",
  "plugin.managed_agent.reset",
  "plugin.managed_routine.created",
  "plugin.managed_routine.reset",
  "plugin.managed_routine.run_triggered",
  "plugin.managed_routine.updated",
  "plugin.managed_skill.reconciled",
  "plugin.managed_skill.reset",
  "project.created",
  "project.deleted",
  "project.updated",
  "project.workspace_created",
  "project.workspace_deleted",
  "project.workspace_runtime_restart",
  "project.workspace_runtime_run",
  "project.workspace_runtime_start",
  "project.workspace_runtime_stop",
  "project.workspace_updated",
  "provider_trace.capture_requested",
  "provider_trace.deleted",
  "provider_trace.downloaded",
  "provider_trace.expired",
  "provider_trace.frame_revealed",
  "provider_trace.metadata_listed",
  "provider_trace.redacted_viewed",
  "provider_trace.workspace_diffs_reprojected",
  "queue.created",
  "queue.seeded",
  "queue.updated",
  "queue_item.added",
  "queue_item.removed",
  "queue_item.seeded",
  "remote_agent_profile.upserted",
  "resource_membership.joined",
  "resource_membership.left",
  "resource_membership.starred",
  "resource_membership.unstarred",
  "routine.created",
  "routine.document_annotation_comment_added",
  "routine.document_annotation_remapped",
  "routine.document_annotation_thread_created",
  "routine.document_annotation_thread_reopened",
  "routine.document_annotation_thread_resolved",
  "routine.origin_cleared",
  "routine.origin_stamped",
  "routine.revision_created",
  "routine.revision_restored",
  "routine.run_skipped",
  "routine.run_triggered",
  "routine.trigger_created",
  "routine.trigger_deleted",
  "routine.trigger_secret_rotated",
  "routine.trigger_updated",
  "routine.updated",
  "runner.api_called",
  "secret.access.listed",
  "secret.binding.created",
  "secret.created",
  "secret.deleted",
  "secret.proposal.approved",
  "secret.proposal.created",
  "secret.proposal.denied",
  "secret.proposal.expired",
  "secret.proposal.rejected",
  "secret.proposal.withdrawn",
  "secret.remote_import.completed",
  "secret.remote_import.previewed",
  "secret.rotated",
  "secret.updated",
  "secret.value.read",
  "secret_provider_config.created",
  "secret_provider_config.default_set",
  "secret_provider_config.discovery_previewed",
  "secret_provider_config.health_checked",
  "secret_provider_config.removed",
  "secret_provider_config.updated",
  "sidebar_preferences.project_order_updated",
  "smoke_lab.fixtures_installed",
  "smoke_lab.reset",
  "smoke_lab.run_created",
  "smoke_lab.run_updated",
  "smoke_lab.services_started",
  "smoke_lab.services_stopped",
  "smoke_lab.step_recorded",
  "summary_slot.generate_requested",
  "summary_slot.write",
  "tool_access.approval_requested",
  "tool_access.approval_resolved",
  "tool_access.call_completed",
  "tool_access.call_denied",
  "tool_access.call_failed",
  "tool_access.call_started",
  "tool_access.discovery",
  "tool_access.invocation_created",
  "tool_access.policy_decision",
  "tool_access.rate_limited",
  "tool_access.runtime_started",
  "tool_access.runtime_stopped",
  "tool_access.session_revoked",
  "tool_access.trust_rule_created",
  "tool_access.trust_rule_revoked",
  "tool_access.trust_rule_used",
  "tool_action_request.created",
  "tool_action_request.resolved",
  "tool_app.connected",
  "tool_app.finished",
  "tool_app.oauth_access_finalized",
  "tool_app.oauth_connected",
  "tool_app.oauth_failed",
  "tool_app.reconnected",
  "tool_application.archived",
  "tool_application.created",
  "tool_application.deleted",
  "tool_application.updated",
  "tool_connection.actions_quarantined",
  "tool_connection.allowlist_changed",
  "tool_connection.app_connected",
  "tool_connection.app_paused",
  "tool_connection.app_resumed",
  "tool_connection.archived",
  "tool_connection.catalog_refresh",
  "tool_connection.catalog_refreshed",
  "tool_connection.created",
  "tool_connection.credential_resolution",
  "tool_connection.disconnected",
  "tool_connection.grant_added",
  "tool_connection.grant_audience_replaced",
  "tool_connection.grant_delegated",
  "tool_connection.grant_delegation_revoked",
  "tool_connection.grant_revoked",
  "tool_connection.health_check",
  "tool_connection.import_mcp_json_previewed",
  "tool_connection.install_access_extended",
  "tool_connection.installs_synced",
  "tool_connection.reconnected",
  "tool_connection.tested",
  "tool_connection.updated",
  "tool_connection.webhook_processed",
  "tool_example.installed",
  "tool_example.smoke_run",
  "tool_gateway.approval_requested",
  "tool_gateway.call_allowed",
  "tool_gateway.call_completed",
  "tool_gateway.call_deferred",
  "tool_gateway.call_denied",
  "tool_gateway.call_failed",
  "tool_gateway.discovery",
  "tool_gateway.elicitation_requested",
  "tool_gateway.runtime_mcp_delivery",
  "tool_gateway.session_created",
  "tool_gateway.session_rejected",
  "tool_gateway.session_revoked",
  "tool_policy.created",
  "tool_policy.deleted",
  "tool_policy.disabled",
  "tool_policy.duplicated",
  "tool_policy.reordered",
  "tool_policy.updated",
  "tool_profile.bound",
  "tool_profile.created",
  "tool_profile.deleted",
  "tool_profile.duplicated",
  "tool_profile.new_tools_reviewed",
  "tool_profile.unbound",
  "tool_profile.updated",
  "tool_profile_binding.created",
  "tool_profile_binding.deleted",
  "tool_profile_entry.created",
  "tool_profile_entry.deleted",
  "tool_profile_entry.updated",
  "tool_runtime_slot.operator_restarted",
  "tool_runtime_slot.operator_stopped",
  "tool_runtime_slot.started",
  "tool_runtime_slot.stopped",
  "tool_stdio_command_template.created",
  "tool_stdio_command_template.disabled",
  "tool_trust_rule.created",
  "tool_trust_rule.revoked",
  "triage.updated",
  "user_secret_definition.created",
  "user_secret_definition.deleted",
  "user_secret_value.created",
  "user_secret_value.deleted",
  "user_secret_value.rotated",
  "user_secret_value.updated",
  "workspace_login_handoff_issued",
  "workspace_runtime.exposure_reservation_drift",
]);

function formatFallbackActivityAction(action: string): string {
  const fallback = action.replace(/[._]/g, " ");
  if (!LOCALIZED_FALLBACK_ACTIVITY_ACTIONS.has(action)) return fallback;
  return t(`localizationActivityEvents.${action.replace(/\./g, "_")}`, { defaultValue: fallback });
}

const ACTIVITY_ROW_VERBS: Record<string, string> = {
  "issue.created": "localizationActivity.activity_row_verbs_issue_created",
  "issue.updated": "localizationActivity.activity_row_verbs_issue_updated",
  "issue.checked_out": "localizationActivity.activity_row_verbs_issue_checked_out",
  "issue.released": "localizationActivity.activity_row_verbs_issue_released",
  "issue.comment_added": "localizationActivity.activity_row_verbs_issue_comment_added",
  "issue.comment_cancelled": "localizationActivity.activity_row_verbs_issue_comment_cancelled",
  "issue.comment_deleted": "localizationActivity.activity_row_verbs_issue_comment_deleted",
  "issue.attachment_added": "localizationActivity.activity_row_verbs_issue_attachment_added",
  "issue.attachment_removed": "localizationActivity.activity_row_verbs_issue_attachment_removed",
  "issue.document_created": "localizationActivity.activity_row_verbs_issue_document_created",
  "issue.document_updated": "localizationActivity.activity_row_verbs_issue_document_updated",
  "issue.document_locked": "localizationActivity.activity_row_verbs_issue_document_locked",
  "issue.document_unlocked": "localizationActivity.activity_row_verbs_issue_document_unlocked",
  "issue.document_deleted": "localizationActivity.activity_row_verbs_issue_document_deleted",
  "issue.monitor_scheduled": "localizationActivity.activity_row_verbs_issue_monitor_scheduled",
  "issue.monitor_triggered": "localizationActivity.activity_row_verbs_issue_monitor_triggered",
  "issue.monitor_cleared": "localizationActivity.activity_row_verbs_issue_monitor_cleared",
  "issue.monitor_skipped": "localizationActivity.activity_row_verbs_issue_monitor_skipped",
  "issue.monitor_exhausted": "localizationActivity.activity_row_verbs_issue_monitor_exhausted",
  "issue.monitor_recovery_wake_queued": "localizationActivity.activity_row_verbs_issue_monitor_recovery_wake_queued",
  "issue.monitor_recovery_issue_created": "localizationActivity.activity_row_verbs_issue_monitor_recovery_issue_created",
  "issue.monitor_escalated_to_board": "localizationActivity.activity_row_verbs_issue_monitor_escalated_to_board",
  "issue.commented": "localizationActivity.activity_row_verbs_issue_commented",
  "issue.deleted": "localizationActivity.activity_row_verbs_issue_deleted",
  "issue.successful_run_handoff_required": "localizationActivity.activity_row_verbs_issue_successful_run_handoff_required",
  "issue.successful_run_handoff_resolved": "localizationActivity.activity_row_verbs_issue_successful_run_handoff_resolved",
  "issue.successful_run_handoff_escalated": "localizationActivity.activity_row_verbs_issue_successful_run_handoff_escalated",
  "issue.accepted_plan_decomposition_updated": "localizationActivity.activity_row_verbs_issue_accepted_plan_decomposition_updated",
  "issue.recovery_action_opened": "localizationActivity.activity_row_verbs_issue_recovery_action_opened",
  "issue.recovery_action_resolved": "localizationActivity.activity_row_verbs_issue_recovery_action_resolved",
  "issue.recovery_action_escalated": "localizationActivity.activity_row_verbs_issue_recovery_action_escalated",
  "agent.created": "localizationActivity.activity_row_verbs_agent_created",
  "agent.updated": "localizationActivity.activity_row_verbs_agent_updated",
  "agent.paused": "localizationActivity.activity_row_verbs_agent_paused",
  "agent.resumed": "localizationActivity.activity_row_verbs_agent_resumed",
  "agent.error_cleared": "localizationActivity.activity_row_verbs_agent_error_cleared",
  "agent.terminated": "localizationActivity.activity_row_verbs_agent_terminated",
  "agent.key_created": "localizationActivity.activity_row_verbs_agent_key_created",
  "agent.budget_updated": "localizationActivity.activity_row_verbs_agent_budget_updated",
  "agent.runtime_session_reset": "localizationActivity.activity_row_verbs_agent_runtime_session_reset",
  "heartbeat.invoked": "localizationActivity.activity_row_verbs_heartbeat_invoked",
  "heartbeat.cancelled": "localizationActivity.activity_row_verbs_heartbeat_cancelled",
  "heartbeat.output_stale_source_resolved": "localizationActivity.activity_row_verbs_heartbeat_output_stale_source_resolved",
  "heartbeat.output_stale_recovery_recursion_refused": "localizationActivity.activity_row_verbs_heartbeat_output_stale_recovery_recursion_refused",
  "approval.created": "localizationActivity.activity_row_verbs_approval_created",
  "approval.approved": "localizationActivity.activity_row_verbs_approval_approved",
  "approval.rejected": "localizationActivity.activity_row_verbs_approval_rejected",
  // Interaction outcomes (PAP-16506). An agent may now resolve one — including a
  // review of its own work — so these must read as outcomes in the feed instead
  // of falling through to the raw "issue thread interaction accepted" action id.
  // `details.interactionKind` sharpens the wording; see INTERACTION_OUTCOME_LABELS.
  "issue.thread_interaction_created": "localizationActivity.activity_row_verbs_issue_thread_interaction_created",
  "issue.thread_interaction_accepted": "localizationActivity.activity_row_verbs_issue_thread_interaction_accepted",
  "issue.thread_interaction_rejected": "localizationActivity.activity_row_verbs_issue_thread_interaction_rejected",
  "issue.thread_interaction_answered": "localizationActivity.activity_row_verbs_issue_thread_interaction_answered",
  "issue.thread_interaction_withdrawn": "localizationActivity.activity_row_verbs_issue_thread_interaction_withdrawn",
  "issue.thread_interaction_cancelled": "localizationActivity.activity_row_verbs_issue_thread_interaction_cancelled",
  "issue.thread_interaction_skipped": "localizationActivity.activity_row_verbs_issue_thread_interaction_skipped",
  "issue.thread_interaction_expired": "localizationActivity.activity_row_verbs_issue_thread_interaction_expired",
  "issue.thread_interaction_item_verdicts_submitted": "localizationActivity.activity_row_verbs_issue_thread_interaction_item_verdicts_submitted",
  "issue.stalled_review_decided": "localizationActivity.activity_row_verbs_issue_stalled_review_decided",
  "project.created": "localizationActivity.activity_row_verbs_project_created",
  "project.updated": "localizationActivity.activity_row_verbs_project_updated",
  "project.deleted": "localizationActivity.activity_row_verbs_project_deleted",
  "goal.created": "localizationActivity.activity_row_verbs_goal_created",
  "goal.updated": "localizationActivity.activity_row_verbs_goal_updated",
  "goal.deleted": "localizationActivity.activity_row_verbs_goal_deleted",
  "cost.reported": "localizationActivity.activity_row_verbs_cost_reported",
  "cost.recorded": "localizationActivity.activity_row_verbs_cost_recorded",
  "company.created": "localizationActivity.activity_row_verbs_company_created",
  "company.updated": "localizationActivity.activity_row_verbs_company_updated",
  "company.archived": "localizationActivity.activity_row_verbs_company_archived",
  "company.reactivated": "localizationActivity.activity_row_verbs_company_reactivated",
  "company.budget_updated": "localizationActivity.activity_row_verbs_company_budget_updated",
  "audit.exported": "localizationActivity.activity_row_verbs_audit_exported",
  "tool_app.connected": "localizationActivity.activity_row_verbs_tool_app_connected",
  "tool_app.oauth_connected": "localizationActivity.activity_row_verbs_tool_app_oauth_connected",
  "tool_app.oauth_failed": "localizationActivity.activity_row_verbs_tool_app_oauth_failed",
  "tool_app.oauth_access_finalized": "localizationActivity.activity_row_verbs_tool_app_oauth_access_finalized",
  "tool_app.finished": "localizationActivity.activity_row_verbs_tool_app_finished",
  "tool_app.reconnected": "localizationActivity.activity_row_verbs_tool_app_reconnected",
  "tool_connection.created": "localizationActivity.activity_row_verbs_tool_connection_created",
  "tool_connection.updated": "localizationActivity.activity_row_verbs_tool_connection_updated",
  "tool_connection.archived": "localizationActivity.activity_row_verbs_tool_connection_archived",
  "tool_connection.catalog_refresh": "localizationActivity.activity_row_verbs_tool_connection_catalog_refresh",
  "tool_connection.installs_synced": "localizationActivity.activity_row_verbs_tool_connection_installs_synced",
  "tool_connection.install_access_extended": "localizationActivity.activity_row_verbs_tool_connection_install_access_extended",
  "tool_connection.grant_audience_replaced": "localizationActivity.activity_row_verbs_tool_connection_grant_audience_replaced",
  "tool_connection.grant_added": "localizationActivity.activity_row_verbs_tool_connection_grant_added",
  "tool_connection.grant_revoked": "localizationActivity.activity_row_verbs_tool_connection_grant_revoked",
  "tool_connection.grant_delegated": "localizationActivity.activity_row_verbs_tool_connection_grant_delegated",
  "tool_connection.grant_delegation_revoked": "localizationActivity.activity_row_verbs_tool_connection_grant_delegation_revoked",
};

const ISSUE_ACTIVITY_LABELS: Record<string, string> = {
  "issue.created": "localizationActivity.issue_activity_labels_issue_created",
  "issue.updated": "localizationActivity.issue_activity_labels_issue_updated",
  "issue.checked_out": "localizationActivity.issue_activity_labels_issue_checked_out",
  "issue.released": "localizationActivity.issue_activity_labels_issue_released",
  "issue.comment_added": "localizationActivity.issue_activity_labels_issue_comment_added",
  "issue.comment_cancelled": "localizationActivity.issue_activity_labels_issue_comment_cancelled",
  "issue.comment_deleted": "localizationActivity.issue_activity_labels_issue_comment_deleted",
  "issue.feedback_vote_saved": "localizationActivity.issue_activity_labels_issue_feedback_vote_saved",
  "issue.attachment_added": "localizationActivity.issue_activity_labels_issue_attachment_added",
  "issue.attachment_removed": "localizationActivity.issue_activity_labels_issue_attachment_removed",
  "issue.document_created": "localizationActivity.issue_activity_labels_issue_document_created",
  "issue.document_updated": "localizationActivity.issue_activity_labels_issue_document_updated",
  "issue.document_locked": "localizationActivity.issue_activity_labels_issue_document_locked",
  "issue.document_unlocked": "localizationActivity.issue_activity_labels_issue_document_unlocked",
  "issue.document_deleted": "localizationActivity.issue_activity_labels_issue_document_deleted",
  "issue.monitor_scheduled": "localizationActivity.issue_activity_labels_issue_monitor_scheduled",
  "issue.monitor_triggered": "localizationActivity.issue_activity_labels_issue_monitor_triggered",
  "issue.monitor_cleared": "localizationActivity.issue_activity_labels_issue_monitor_cleared",
  "issue.monitor_skipped": "localizationActivity.issue_activity_labels_issue_monitor_skipped",
  "issue.monitor_exhausted": "localizationActivity.issue_activity_labels_issue_monitor_exhausted",
  "issue.monitor_recovery_wake_queued": "localizationActivity.issue_activity_labels_issue_monitor_recovery_wake_queued",
  "issue.monitor_recovery_issue_created": "localizationActivity.issue_activity_labels_issue_monitor_recovery_issue_created",
  "issue.monitor_escalated_to_board": "localizationActivity.issue_activity_labels_issue_monitor_escalated_to_board",
  "issue.deleted": "localizationActivity.issue_activity_labels_issue_deleted",
  "issue.successful_run_handoff_required": "localizationActivity.issue_activity_labels_issue_successful_run_handoff_required",
  "issue.successful_run_handoff_resolved": "localizationActivity.issue_activity_labels_issue_successful_run_handoff_resolved",
  "issue.successful_run_handoff_escalated": "localizationActivity.issue_activity_labels_issue_successful_run_handoff_escalated",
  "issue.cross_issue_influence_cap_rejected": "localizationActivity.issue_activity_labels_issue_cross_issue_influence_cap_rejected",
  "issue.cross_issue_influence_observed": "localizationActivity.issue_activity_labels_issue_cross_issue_influence_observed",
  "issue.attribution_spoof_rejected": "localizationActivity.issue_activity_labels_issue_attribution_spoof_rejected",
  "issue.recovery_action_opened": "localizationActivity.issue_activity_labels_issue_recovery_action_opened",
  "issue.recovery_action_resolved": "localizationActivity.issue_activity_labels_issue_recovery_action_resolved",
  "issue.recovery_action_escalated": "localizationActivity.issue_activity_labels_issue_recovery_action_escalated",
  "issue.accepted_plan_decomposition_updated": "localizationActivity.issue_activity_labels_issue_accepted_plan_decomposition_updated",
  "agent.created": "localizationActivity.issue_activity_labels_agent_created",
  "agent.updated": "localizationActivity.issue_activity_labels_agent_updated",
  "agent.paused": "localizationActivity.issue_activity_labels_agent_paused",
  "agent.resumed": "localizationActivity.issue_activity_labels_agent_resumed",
  "agent.error_cleared": "localizationActivity.issue_activity_labels_agent_error_cleared",
  "agent.terminated": "localizationActivity.issue_activity_labels_agent_terminated",
  "heartbeat.invoked": "localizationActivity.issue_activity_labels_heartbeat_invoked",
  "heartbeat.cancelled": "localizationActivity.issue_activity_labels_heartbeat_cancelled",
  "heartbeat.output_stale_source_resolved": "localizationActivity.issue_activity_labels_heartbeat_output_stale_source_resolved",
  "heartbeat.output_stale_recovery_recursion_refused": "localizationActivity.issue_activity_labels_heartbeat_output_stale_recovery_recursion_refused",
  "approval.created": "localizationActivity.issue_activity_labels_approval_created",
  "approval.approved": "localizationActivity.issue_activity_labels_approval_approved",
  "approval.rejected": "localizationActivity.issue_activity_labels_approval_rejected",
  "issue.thread_interaction_created": "localizationActivity.issue_activity_labels_issue_thread_interaction_created",
  "issue.thread_interaction_accepted": "localizationActivity.issue_activity_labels_issue_thread_interaction_accepted",
  "issue.thread_interaction_rejected": "localizationActivity.issue_activity_labels_issue_thread_interaction_rejected",
  "issue.thread_interaction_answered": "localizationActivity.issue_activity_labels_issue_thread_interaction_answered",
  "issue.thread_interaction_withdrawn": "localizationActivity.issue_activity_labels_issue_thread_interaction_withdrawn",
  "issue.thread_interaction_cancelled": "localizationActivity.issue_activity_labels_issue_thread_interaction_cancelled",
  "issue.thread_interaction_skipped": "localizationActivity.issue_activity_labels_issue_thread_interaction_skipped",
  "issue.thread_interaction_expired": "localizationActivity.issue_activity_labels_issue_thread_interaction_expired",
  "issue.thread_interaction_item_verdicts_submitted": "localizationActivity.issue_activity_labels_issue_thread_interaction_item_verdicts_submitted",
  "issue.stalled_review_decided": "localizationActivity.issue_activity_labels_issue_stalled_review_decided",
};

/**
 * `issue.stalled_review_decided` carries the verb the actor chose, so the line
 * names the verdict ("approved the review") rather than the generic action.
 * Mirrors `StalledReviewDecisionAction` in shared.
 */
const STALLED_REVIEW_DECISION_LABELS: Record<string, string> = {
  approve: "localizationActivity.stalled_review_decision_labels_approve",
  request_changes: "localizationActivity.stalled_review_decision_labels_request_changes",
  send_back: "localizationActivity.stalled_review_decision_labels_send_back",
};

/**
 * `issue.thread_interaction_accepted` / `_rejected` fire for *every* interaction
 * kind, not only for a review. A task suggestion or a question is accepted, not
 * approved, so the kind on the event picks the verb. Kinds absent from a map
 * keep the neutral "accepted the request" wording from the tables above, which
 * is also the fallback for an event that carries no kind.
 */
const INTERACTION_ACCEPTED_LABELS: Record<string, string> = {
  request_confirmation: "localizationActivity.interaction_accepted_labels_request_confirmation",
  request_checkbox_confirmation: "localizationActivity.interaction_accepted_labels_request_checkbox_confirmation",
  suggest_tasks: "localizationActivity.interaction_accepted_labels_suggest_tasks",
  ask_user_questions: "localizationActivity.interaction_accepted_labels_ask_user_questions",
};

const INTERACTION_REJECTED_LABELS: Record<string, string> = {
  request_confirmation: "localizationActivity.interaction_rejected_labels_request_confirmation",
  request_checkbox_confirmation: "localizationActivity.interaction_rejected_labels_request_checkbox_confirmation",
  suggest_tasks: "localizationActivity.interaction_rejected_labels_suggest_tasks",
  ask_user_questions: "localizationActivity.interaction_rejected_labels_ask_user_questions",
};

/**
 * Kind-aware wording for an interaction outcome, or `null` when the tables
 * above already say it well enough.
 */
function formatInteractionOutcomeLabel(action: string, details: ActivityDetails): string | null {
  const table = action === "issue.thread_interaction_accepted"
    ? INTERACTION_ACCEPTED_LABELS
    : action === "issue.thread_interaction_rejected"
      ? INTERACTION_REJECTED_LABELS
      : null;
  if (!table) return null;
  const kind = typeof details?.interactionKind === "string" ? details.interactionKind : null;
  return kind && table[kind] ? t(table[kind]) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? t("status.none"));
  return i18n.exists(`status.${value}`) ? t(`status.${value}`) : i18n.exists(`priority.${value}`) ? t(`priority.${value}`) : value.replace(/_/g, " ");
}

function isActivityParticipant(value: unknown): value is ActivityParticipant {
  const record = asRecord(value);
  if (!record) return false;
  return record.type === "agent" || record.type === "user";
}

function isActivityIssueReference(value: unknown): value is ActivityIssueReference {
  return asRecord(value) !== null;
}

function readParticipants(details: ActivityDetails, key: string): ActivityParticipant[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityParticipant);
}

function readIssueReferences(details: ActivityDetails, key: string): ActivityIssueReference[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityIssueReference);
}

function formatUserLabel(userId: string | null | undefined, options: ActivityFormatOptions = {}): string {
  if (!userId) return t("localizationActivity.board");
  const profile = options.userProfileMap?.get(userId);
  if (userId === "local-board") return companyUserProfileDisplayLabel(profile) ?? t("localizationAssigneeChrome.board");
  if (options.currentUserId && userId === options.currentUserId) return t("localizationActivity.you");
  if (profile) return companyUserProfileDisplayLabel(profile)!;
  return t("localizationActivity.userId", { id: userId.slice(0, 5) });
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? t("localizationActivity.agent");
  }
  return formatUserLabel(participant.userId, options);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return t("localizationActivity.task");
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function readStringArrayLength(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((entry) => typeof entry === "string" && entry.length > 0).length;
}

function formatAcceptedPlanDecompositionDetail(details: ActivityDetails): string | null {
  if (!details) return null;
  const status = typeof details.status === "string" ? details.status : null;
  const requested = readNumber(details.requestedChildCount);
  const totalChildren = readStringArrayLength(details.childIssueIds);
  const newlyCreated = readStringArrayLength(details.newlyCreatedChildIssueIds);
  const reused = Math.max(0, totalChildren - newlyCreated);
  const parts: string[] = [];
  if (newlyCreated > 0) parts.push(t("localizationActivity.decomposition_newlyCreated", { count: newlyCreated }));
  if (reused > 0) parts.push(t("localizationActivity.decomposition_reused", { count: reused }));
  if (parts.length === 0 && requested !== null) parts.push(t("localizationActivity.decomposition_requested", { count: requested }));
  const summary = parts.length > 0 ? parts.join(", ") : null;
  if (status === "completed" && summary) return t("localizationActivity.decompositionCompletedSummary", { summary });
  if (status === "completed") return t("localizationActivity.decompositionCompleted");
  if (status === "in_flight" && summary) return t("localizationActivity.decompositionInProgress", { summary });
  return summary;
}

function formatIssueUpdatedVerb(details: ActivityDetails): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  if (details.status !== undefined) {
    const from = previous.status;
    return from
      ? t("localizationActivity.changed_status_from_Verb", { from: humanizeValue(from), to: humanizeValue(details.status) })
      : t("localizationActivity.changed_status_Verb", { to: humanizeValue(details.status) });
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    return from
      ? t("localizationActivity.changed_priority_from_Verb", { from: humanizeValue(from), to: humanizeValue(details.priority) })
      : t("localizationActivity.changed_priority_Verb", { to: humanizeValue(details.priority) });
  }
  return null;
}

function formatAssigneeName(details: ActivityDetails, options: ActivityFormatOptions): string | null {
  if (!details) return null;
  const agentId = details.assigneeAgentId;
  const userId = details.assigneeUserId;
  if (typeof agentId === "string" && agentId) {
    return options.agentMap?.get(agentId)?.name ?? t("localizationActivity.agent");
  }
  if (typeof userId === "string" && userId) {
    return formatUserLabel(userId, options);
  }
  return null;
}

function formatIssueUpdatedAction(details: ActivityDetails, options: ActivityFormatOptions = {}): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const parts: string[] = [];

  if (details.status !== undefined) {
    const from = previous.status;
    parts.push(
      from
        ? t("localizationActivity.changed_status_from_Action", { from: humanizeValue(from), to: humanizeValue(details.status) })
        : t("localizationActivity.changed_status_Action", { to: humanizeValue(details.status) }),
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? t("localizationActivity.changed_priority_from_Action", { from: humanizeValue(from), to: humanizeValue(details.priority) })
        : t("localizationActivity.changed_priority_Action", { to: humanizeValue(details.priority) }),
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    const assigneeName = formatAssigneeName(details, options);
    parts.push(assigneeName ? t("localizationActivity.assignedResponsible", { name: assigneeName }) : t("localizationActivity.clearedResponsible"));
  }
  if (details.reviewPolicy !== undefined) {
    // `null` is the default ("anyone can approve"), so it must not read as
    // "changed the review policy to none" (PAP-16506).
    parts.push(t("localizationActivity.changedReviewPolicy", { policy: formatReviewPolicyValue(details.reviewPolicy) }));
  }
  if (details.title !== undefined) parts.push(t("localizationActivity.updatedTitle"));
  if (details.description !== undefined) parts.push(t("localizationActivity.updatedDescription"));

  return parts.length > 0 ? parts.join(", ") : null;
}

function formatStructuredIssueChange(input: {
  action: string;
  details: ActivityDetails;
  options: ActivityFormatOptions;
  forIssueDetail: boolean;
}): string | null {
  const details = input.details;
  if (!details) return null;
  const entity = input.action === "issue.blockers_updated" ? "blocker"
    : input.action === "issue.reviewers_updated" ? "reviewer"
    : input.action === "issue.approvers_updated" ? "approver" : null;
  if (!entity) return null;
  const added = entity === "blocker"
    ? readIssueReferences(details, "addedBlockedByIssues").map(formatIssueReferenceLabel)
    : readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
  const removed = entity === "blocker"
    ? readIssueReferences(details, "removedBlockedByIssues").map(formatIssueReferenceLabel)
    : readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
  const suffix = input.forIssueDetail ? "" : "Row";
  // Russian "one" also includes 21/101; only a literal single item may use its name instead of a count.
  if (added.length > 0 && removed.length === 0) {
    if (added.length === 1) return t(`localizationActivity.change_added_${entity}${suffix}Single`, { label: added[0] });
    return t(`localizationActivity.change_added_${entity}${suffix}`, { count: added.length });
  }
  if (removed.length > 0 && added.length === 0) {
    if (removed.length === 1) return t(`localizationActivity.change_removed_${entity}${suffix}Single`, { label: removed[0] });
    return t(`localizationActivity.change_removed_${entity}${suffix}`, { count: removed.length });
  }
  return t(`localizationActivity.change_updated_${entity}${suffix}`);
}

export function formatActivityVerb(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action.startsWith("tool_gateway.")) {
    const rawTool = typeof details?.tool === "string"
      ? details.tool
      : typeof details?.upstreamToolName === "string"
        ? details.upstreamToolName
        : t("localizationActivity.appAction");
    const tool = rawTool.replace(/[._-]+/g, " ");
    const isTest = details?.source === "test";
    if (action === "tool_gateway.call_completed") return t(`localizationActivity.toolCompleted_${isTest ? "test" : "use"}`, { tool });
    if (action === "tool_gateway.call_allowed") return t(`localizationActivity.toolAllowed_${isTest ? "test" : "use"}`, { tool });
    if (action === "tool_gateway.call_denied") return t("localizationActivity.toolDenied", { tool });
    if (action === "tool_gateway.approval_requested") return t("localizationActivity.toolRequested", { tool });
    if (action === "tool_gateway.session_created") return t("localizationActivity.appSessionCreated");
    if (action === "tool_gateway.session_rejected") return t("localizationActivity.appSessionRejected");
    if (action === "tool_gateway.discovery") return t("localizationActivity.appDiscovery");
  }

  if (action === "issue.updated") {
    const issueUpdatedVerb = formatIssueUpdatedVerb(details);
    if (issueUpdatedVerb) return issueUpdatedVerb;
  }

  if (action === "issue.stalled_review_decided") {
    const decision = typeof details?.action === "string" ? details.action : null;
    const label = decision && STALLED_REVIEW_DECISION_LABELS[decision] ? t(STALLED_REVIEW_DECISION_LABELS[decision]) : null;
    if (label) return t("localizationActivity.reviewOnEntity", { label });
  }

  const outcomeLabel = formatInteractionOutcomeLabel(action, details);
  if (outcomeLabel) return t("localizationActivity.reviewOnEntity", { label: outcomeLabel });

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: false,
  });
  if (structuredChange) return structuredChange;

  return ACTIVITY_ROW_VERBS[action] ? t(ACTIVITY_ROW_VERBS[action]) : formatFallbackActivityAction(action);
}

export function formatIssueActivityAction(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedAction = formatIssueUpdatedAction(details, options);
    if (issueUpdatedAction) return issueUpdatedAction;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: true,
  });
  if (structuredChange) return structuredChange;

  if (action === "issue.accepted_plan_decomposition_updated") {
    const detail = formatAcceptedPlanDecompositionDetail(details);
    if (detail) return detail;
  }

  if (action === "issue.stalled_review_decided") {
    const decision = typeof details?.action === "string" ? details.action : null;
    const label = decision && STALLED_REVIEW_DECISION_LABELS[decision] ? t(STALLED_REVIEW_DECISION_LABELS[decision]) : null;
    if (label) return label;
  }

  const outcomeLabel = formatInteractionOutcomeLabel(action, details);
  if (outcomeLabel) return outcomeLabel;

  if (action.startsWith("issue.monitor_") && details) {
    const serviceName = typeof details.serviceName === "string" && details.serviceName.trim()
      ? details.serviceName.trim()
      : null;
    const base = ISSUE_ACTIVITY_LABELS[action] ? t(ISSUE_ACTIVITY_LABELS[action]) : formatFallbackActivityAction(action);
    return serviceName ? t("localizationActivity.monitorService", { action: base, service: serviceName }) : base;
  }

  if (
    (
      action === "issue.document_created" ||
      action === "issue.document_updated" ||
      action === "issue.document_locked" ||
      action === "issue.document_unlocked" ||
      action === "issue.document_deleted"
    ) &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : t("localizationActivity.document");
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return t("localizationActivity.documentAction", { action: ISSUE_ACTIVITY_LABELS[action] ? t(ISSUE_ACTIVITY_LABELS[action]) : action, key, title });
  }

  return ISSUE_ACTIVITY_LABELS[action] ? t(ISSUE_ACTIVITY_LABELS[action]) : formatFallbackActivityAction(action);
}
