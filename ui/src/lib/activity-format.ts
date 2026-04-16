import type { MessageKey, MessageParams } from "@paperclipai/shared/i18n";
import type { Agent } from "@paperclipai/shared";

type ActivityDetails = Record<string, unknown> | null | undefined;
type Translate = (key: MessageKey, params?: MessageParams) => string;

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
  currentUserId?: string | null;
}

const ACTIVITY_ROW_VERB_KEYS: Partial<Record<string, MessageKey>> = {
  "issue.created": "activity.row.issue.created",
  "issue.updated": "activity.row.issue.updated",
  "issue.checked_out": "activity.row.issue.checkedOut",
  "issue.checkout_lock_adopted": "activity.row.issue.checkoutLockAdopted",
  "issue.released": "activity.row.issue.released",
  "issue.comment_added": "activity.row.issue.commentAdded",
  "issue.comment_cancelled": "activity.row.issue.commentCancelled",
  "issue.commented": "activity.row.issue.commented",
  "issue.attachment_added": "activity.row.issue.attachmentAdded",
  "issue.attachment_removed": "activity.row.issue.attachmentRemoved",
  "issue.document_created": "activity.row.issue.documentCreated",
  "issue.document_updated": "activity.row.issue.documentUpdated",
  "issue.document_deleted": "activity.row.issue.documentDeleted",
  "issue.document_restored": "activity.row.issue.documentRestored",
  "issue.work_product_created": "activity.row.issue.workProductCreated",
  "issue.work_product_updated": "activity.row.issue.workProductUpdated",
  "issue.work_product_deleted": "activity.row.issue.workProductDeleted",
  "issue.read_marked": "activity.row.issue.readMarked",
  "issue.read_unmarked": "activity.row.issue.readUnmarked",
  "issue.inbox_archived": "activity.row.issue.inboxArchived",
  "issue.inbox_unarchived": "activity.row.issue.inboxUnarchived",
  "issue.approval_linked": "activity.row.issue.approvalLinked",
  "issue.approval_unlinked": "activity.row.issue.approvalUnlinked",
  "issue.feedback_vote_saved": "activity.row.issue.feedbackVoteSaved",
  "issue.deleted": "activity.row.issue.deleted",
  "agent.created": "activity.row.agent.created",
  "agent.updated": "activity.row.agent.updated",
  "agent.paused": "activity.row.agent.paused",
  "agent.resumed": "activity.row.agent.resumed",
  "agent.terminated": "activity.row.agent.terminated",
  "agent.deleted": "activity.row.agent.deleted",
  "agent.key_created": "activity.row.agent.keyCreated",
  "agent.budget_updated": "activity.row.agent.budgetUpdated",
  "agent.runtime_session_reset": "activity.row.agent.runtimeSessionReset",
  "agent.skills_synced": "activity.row.agent.skillsSynced",
  "agent.config_rolled_back": "activity.row.agent.configRolledBack",
  "agent.hire_created": "activity.row.agent.hireCreated",
  "agent.permissions_updated": "activity.row.agent.permissionsUpdated",
  "agent.instructions_path_updated": "activity.row.agent.instructionsPathUpdated",
  "agent.instructions_bundle_updated": "activity.row.agent.instructionsBundleUpdated",
  "agent.instructions_file_updated": "activity.row.agent.instructionsFileUpdated",
  "agent.instructions_file_deleted": "activity.row.agent.instructionsFileDeleted",
  "agent.updated_from_join_replay": "activity.row.agent.updatedFromJoinReplay",
  "heartbeat.invoked": "activity.row.heartbeat.invoked",
  "heartbeat.cancelled": "activity.row.heartbeat.cancelled",
  "approval.created": "activity.row.approval.created",
  "approval.approved": "activity.row.approval.approved",
  "approval.rejected": "activity.row.approval.rejected",
  "approval.revision_requested": "activity.row.approval.revisionRequested",
  "approval.resubmitted": "activity.row.approval.resubmitted",
  "approval.comment_added": "activity.row.approval.commentAdded",
  "approval.requester_wakeup_queued": "activity.row.approval.requesterWakeupQueued",
  "approval.requester_wakeup_failed": "activity.row.approval.requesterWakeupFailed",
  "project.created": "activity.row.project.created",
  "project.updated": "activity.row.project.updated",
  "project.deleted": "activity.row.project.deleted",
  "project.workspace_created": "activity.row.project.workspaceCreated",
  "project.workspace_updated": "activity.row.project.workspaceUpdated",
  "project.workspace_deleted": "activity.row.project.workspaceDeleted",
  "goal.created": "activity.row.goal.created",
  "goal.updated": "activity.row.goal.updated",
  "goal.deleted": "activity.row.goal.deleted",
  "cost.reported": "activity.row.cost.reported",
  "cost.recorded": "activity.row.cost.recorded",
  "finance_event.reported": "activity.row.financeEvent.reported",
  "company.created": "activity.row.company.created",
  "company.imported": "activity.row.company.imported",
  "company.updated": "activity.row.company.updated",
  "company.branding_updated": "activity.row.company.brandingUpdated",
  "company.archived": "activity.row.company.archived",
  "company.budget_updated": "activity.row.company.budgetUpdated",
  "company.feedback_data_sharing_updated": "activity.row.company.feedbackDataSharingUpdated",
  "company.skill_created": "activity.row.company.skillCreated",
  "company.skill_file_updated": "activity.row.company.skillFileUpdated",
  "company.skills_imported": "activity.row.company.skillsImported",
  "company.skills_scanned": "activity.row.company.skillsScanned",
  "company.skill_deleted": "activity.row.company.skillDeleted",
  "company.skill_update_installed": "activity.row.company.skillUpdateInstalled",
  "label.created": "activity.row.label.created",
  "label.deleted": "activity.row.label.deleted",
  "secret.created": "activity.row.secret.created",
  "secret.rotated": "activity.row.secret.rotated",
  "secret.updated": "activity.row.secret.updated",
  "secret.deleted": "activity.row.secret.deleted",
  "asset.created": "activity.row.asset.created",
  "routine.created": "activity.row.routine.created",
  "routine.updated": "activity.row.routine.updated",
  "routine.trigger_created": "activity.row.routine.triggerCreated",
  "routine.trigger_updated": "activity.row.routine.triggerUpdated",
  "routine.trigger_deleted": "activity.row.routine.triggerDeleted",
  "routine.trigger_secret_rotated": "activity.row.routine.triggerSecretRotated",
  "routine.run_triggered": "activity.row.routine.runTriggered",
  "board_api_key.created": "activity.row.boardApiKey.created",
  "board_api_key.revoked": "activity.row.boardApiKey.revoked",
  "invite.created": "activity.row.invite.created",
  "invite.revoked": "activity.row.invite.revoked",
  "invite.openclaw_prompt_created": "activity.row.invite.openclawPromptCreated",
  "join.approved": "activity.row.join.approved",
  "join.rejected": "activity.row.join.rejected",
  "inbox.dismissed": "activity.row.inbox.dismissed",
  "instance.settings.general_updated": "activity.row.instanceSettings.generalUpdated",
  "instance.settings.experimental_updated": "activity.row.instanceSettings.experimentalUpdated",
  "budget.policy_upserted": "activity.row.budget.policyUpserted",
  "budget.soft_threshold_crossed": "activity.row.budget.softThresholdCrossed",
  "budget.hard_threshold_crossed": "activity.row.budget.hardThresholdCrossed",
  "budget.incident_resolved": "activity.row.budget.incidentResolved",
  "execution_workspace.updated": "activity.row.executionWorkspace.updated",
  "agent_api_key.claimed": "activity.row.agentApiKey.claimed",
  "hire_hook.succeeded": "activity.row.hireHook.succeeded",
  "hire_hook.failed": "activity.row.hireHook.failed",
  "hire_hook.error": "activity.row.hireHook.error",
};

const ISSUE_ACTIVITY_LABEL_KEYS: Partial<Record<string, MessageKey>> = {
  "issue.created": "activity.detail.issue.created",
  "issue.updated": "activity.detail.issue.updated",
  "issue.checked_out": "activity.detail.issue.checkedOut",
  "issue.released": "activity.detail.issue.released",
  "issue.comment_added": "activity.detail.issue.commentAdded",
  "issue.feedback_vote_saved": "activity.detail.issue.feedbackVoteSaved",
  "issue.attachment_added": "activity.detail.issue.attachmentAdded",
  "issue.attachment_removed": "activity.detail.issue.attachmentRemoved",
  "issue.document_created": "activity.detail.issue.documentCreated",
  "issue.document_updated": "activity.detail.issue.documentUpdated",
  "issue.document_deleted": "activity.detail.issue.documentDeleted",
  "issue.document_restored": "activity.detail.issue.documentRestored",
  "issue.work_product_created": "activity.detail.issue.workProductCreated",
  "issue.work_product_updated": "activity.detail.issue.workProductUpdated",
  "issue.work_product_deleted": "activity.detail.issue.workProductDeleted",
  "issue.read_marked": "activity.detail.issue.readMarked",
  "issue.read_unmarked": "activity.detail.issue.readUnmarked",
  "issue.inbox_archived": "activity.detail.issue.inboxArchived",
  "issue.inbox_unarchived": "activity.detail.issue.inboxUnarchived",
  "issue.approval_linked": "activity.detail.issue.approvalLinked",
  "issue.approval_unlinked": "activity.detail.issue.approvalUnlinked",
  "issue.deleted": "activity.detail.issue.deleted",
  "agent.created": "activity.detail.agent.created",
  "agent.updated": "activity.detail.agent.updated",
  "agent.paused": "activity.detail.agent.paused",
  "agent.resumed": "activity.detail.agent.resumed",
  "agent.terminated": "activity.detail.agent.terminated",
  "heartbeat.invoked": "activity.detail.heartbeat.invoked",
  "heartbeat.cancelled": "activity.detail.heartbeat.cancelled",
  "approval.created": "activity.detail.approval.created",
  "approval.approved": "activity.detail.approval.approved",
  "approval.rejected": "activity.detail.approval.rejected",
};

const ACTIVITY_ENTITY_TYPE_KEYS: Partial<Record<string, MessageKey>> = {
  issue: "activity.entityType.issue",
  agent: "activity.entityType.agent",
  project: "activity.entityType.project",
  goal: "activity.entityType.goal",
  approval: "activity.entityType.approval",
  company: "activity.entityType.company",
  heartbeat_run: "activity.entityType.heartbeatRun",
  routine: "activity.entityType.routine",
  routine_trigger: "activity.entityType.routineTrigger",
  routine_run: "activity.entityType.routineRun",
  execution_workspace: "activity.entityType.executionWorkspace",
  label: "activity.entityType.label",
  secret: "activity.entityType.secret",
  asset: "activity.entityType.asset",
  cost_event: "activity.entityType.costEvent",
  finance_event: "activity.entityType.financeEvent",
  budget_policy: "activity.entityType.budgetPolicy",
  budget_incident: "activity.entityType.budgetIncident",
  invite: "activity.entityType.invite",
  join_request: "activity.entityType.joinRequest",
  agent_api_key: "activity.entityType.agentApiKey",
  user: "activity.entityType.user",
  company_skill: "activity.entityType.companySkill",
  instance_settings: "activity.entityType.instanceSettings",
  plugin: "activity.entityType.plugin",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeActivityToken(value: string): string {
  return value
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function humanizeValue(value: unknown, t: Translate): string {
  if (typeof value !== "string") return String(value ?? t("common.none"));
  return value.replace(/_/g, " ");
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

function formatUserLabel(userId: string | null | undefined, currentUserId: string | null | undefined, t: Translate): string {
  if (!userId || userId === "local-board") return t("common.board");
  if (currentUserId && userId === currentUserId) return t("common.you");
  return `user ${userId.slice(0, 5)}`;
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions, t: Translate): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? t("activity.entityType.agent");
  }
  return formatUserLabel(participant.userId, options.currentUserId, t);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference, t: Translate): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return t("activity.issueReferenceFallback");
}

function translateAction(t: Translate, action: string, map: Partial<Record<string, MessageKey>>): string {
  const key = map[action];
  return key ? t(key) : humanizeActivityToken(action);
}

function formatIssueUpdatedVerb(details: ActivityDetails, t: Translate): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  if (details.status !== undefined) {
    const from = previous.status;
    return from
      ? t("activity.row.issue.updatedStatusFrom", {
        from: humanizeValue(from, t),
        to: humanizeValue(details.status, t),
      })
      : t("activity.row.issue.updatedStatusTo", { to: humanizeValue(details.status, t) });
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    return from
      ? t("activity.row.issue.updatedPriorityFrom", {
        from: humanizeValue(from, t),
        to: humanizeValue(details.priority, t),
      })
      : t("activity.row.issue.updatedPriorityTo", { to: humanizeValue(details.priority, t) });
  }
  return null;
}

function formatIssueUpdatedAction(details: ActivityDetails, t: Translate): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const parts: string[] = [];

  if (details.status !== undefined) {
    const from = previous.status;
    parts.push(
      from
        ? t("activity.detail.issue.updatedStatusFrom", {
          from: humanizeValue(from, t),
          to: humanizeValue(details.status, t),
        })
        : t("activity.detail.issue.updatedStatusTo", { to: humanizeValue(details.status, t) }),
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? t("activity.detail.issue.updatedPriorityFrom", {
          from: humanizeValue(from, t),
          to: humanizeValue(details.priority, t),
        })
        : t("activity.detail.issue.updatedPriorityTo", { to: humanizeValue(details.priority, t) }),
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    parts.push(details.assigneeAgentId || details.assigneeUserId
      ? t("activity.detail.issue.assigned")
      : t("activity.detail.issue.unassigned"));
  }
  if (details.title !== undefined) parts.push(t("activity.detail.issue.updatedTitle"));
  if (details.description !== undefined) parts.push(t("activity.detail.issue.updatedDescription"));

  return parts.length > 0 ? parts.join(t("activity.separator")) : null;
}

function formatStructuredIssueChange(input: {
  action: string;
  details: ActivityDetails;
  options: ActivityFormatOptions;
  forIssueDetail: boolean;
  t: Translate;
}): string | null {
  const { action, details, options, forIssueDetail, t } = input;
  if (!details) return null;

  if (action === "issue.blockers_updated") {
    const added = readIssueReferences(details, "addedBlockedByIssues").map((reference) => formatIssueReferenceLabel(reference, t));
    const removed = readIssueReferences(details, "removedBlockedByIssues").map((reference) => formatIssueReferenceLabel(reference, t));
    if (added.length > 0 && removed.length === 0) {
      return added.length === 1
        ? t(forIssueDetail ? "activity.detail.issue.blockersAddedOne" : "activity.row.issue.blockersAddedOne", { label: added[0] })
        : t(forIssueDetail ? "activity.detail.issue.blockersAddedMany" : "activity.row.issue.blockersAddedMany", { count: added.length });
    }
    if (removed.length > 0 && added.length === 0) {
      return removed.length === 1
        ? t(forIssueDetail ? "activity.detail.issue.blockersRemovedOne" : "activity.row.issue.blockersRemovedOne", { label: removed[0] })
        : t(forIssueDetail ? "activity.detail.issue.blockersRemovedMany" : "activity.row.issue.blockersRemovedMany", { count: removed.length });
    }
    return t(forIssueDetail ? "activity.detail.issue.blockersUpdated" : "activity.row.issue.blockersUpdated");
  }

  if (action === "issue.reviewers_updated" || action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, options, t));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, options, t));
    const keyPrefix = action === "issue.reviewers_updated"
      ? (forIssueDetail ? "activity.detail.issue.reviewers" : "activity.row.issue.reviewers")
      : (forIssueDetail ? "activity.detail.issue.approvers" : "activity.row.issue.approvers");

    if (added.length > 0 && removed.length === 0) {
      return added.length === 1
        ? t(`${keyPrefix}AddedOne` as MessageKey, { label: added[0] })
        : t(`${keyPrefix}AddedMany` as MessageKey, { count: added.length });
    }
    if (removed.length > 0 && added.length === 0) {
      return removed.length === 1
        ? t(`${keyPrefix}RemovedOne` as MessageKey, { label: removed[0] })
        : t(`${keyPrefix}RemovedMany` as MessageKey, { count: removed.length });
    }
    return t(`${keyPrefix}Updated` as MessageKey);
  }

  return null;
}

export function formatActivityVerb(
  t: Translate,
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedVerb = formatIssueUpdatedVerb(details, t);
    if (issueUpdatedVerb) return issueUpdatedVerb;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: false,
    t,
  });
  if (structuredChange) return structuredChange;

  return translateAction(t, action, ACTIVITY_ROW_VERB_KEYS);
}

export function formatIssueActivityAction(
  t: Translate,
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedAction = formatIssueUpdatedAction(details, t);
    if (issueUpdatedAction) return issueUpdatedAction;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: true,
    t,
  });
  if (structuredChange) return structuredChange;

  if (
    (action === "issue.document_created" || action === "issue.document_updated" || action === "issue.document_deleted") &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "document";
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${translateAction(t, action, ISSUE_ACTIVITY_LABEL_KEYS)} ${key}${title}`;
  }

  const issueLabel = ISSUE_ACTIVITY_LABEL_KEYS[action];
  if (issueLabel) return t(issueLabel);
  return translateAction(t, action, ACTIVITY_ROW_VERB_KEYS);
}

export function formatActivityEntityTypeLabel(t: Translate, entityType: string): string {
  const key = ACTIVITY_ENTITY_TYPE_KEYS[entityType];
  return key ? t(key) : humanizeActivityToken(entityType);
}
