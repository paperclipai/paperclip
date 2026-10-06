import { t } from "@/i18n";
import type {
  WorkspaceOperation,
  WorkspaceReadiness,
  WorkspaceReadinessState,
  WorkspaceRuntimeService,
} from "@paperclipai/shared";

/**
 * Derives the workspace access state the UI shows (PAP-17572).
 *
 * The board cannot read a cloned workspace's protected health directly, so state
 * comes from three server-side facts it *can* see: the live runtime rows, the
 * workspace operation log, and the readiness the control plane reported when it
 * last tried to mint a login handoff.
 *
 * Every state carries one concrete next action. The failure this replaces was a
 * generic "Load failed" (or worse, a green badge) that told an operator nothing
 * about whether to wait, start, repair, or read a log.
 */

export type WorkspaceAccessActionKind =
  | "open"
  | "start"
  | "repair"
  | "view_logs"
  /** Nothing to do but wait for a running operation. */
  | "wait";

export type WorkspaceAccessAction = {
  kind: WorkspaceAccessActionKind;
  label: string;
};

export type WorkspaceAccessNotice = {
  title: string;
  description: string;
  action: WorkspaceAccessAction;
};

export type WorkspaceAccessDisplayState = WorkspaceReadinessState | "stopped";

export type WorkspaceAccessState = {
  state: WorkspaceAccessDisplayState;
  title: string;
  description: string;
  action: WorkspaceAccessAction;
  /** True when a password-independent handoff is the expected way in. */
  handoffAvailable: boolean;
  /** A non-blocking historical failure that is still useful to inspect. */
  secondaryNotice?: WorkspaceAccessNotice;
};

/** What the control plane said the last time a handoff was requested. */
export type WorkspaceLoginHandoffFailureInfo = {
  reason: string;
  detail?: string | null;
  readiness?: WorkspaceReadiness | null;
};

function latestOperation(operations: WorkspaceOperation[], phase: WorkspaceOperation["phase"]) {
  return operations.find((operation) => operation.phase === phase) ?? null;
}

function describeSeedPhase(readiness: WorkspaceReadiness | null | undefined): string | null {
  if (!readiness?.failurePhase && !readiness?.seedPhase) return null;
  return readiness.failurePhase ?? readiness.seedPhase ?? null;
}

function timestampMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function failedRepairNotice(repair: WorkspaceOperation): WorkspaceAccessNotice {
  const phase = typeof repair.metadata?.repairPhase === "string" ? repair.metadata.repairPhase : null;
  return {
    get ["title"]() { return t("localizationWorkspaces.ui_Repair_failed"); },
    description: phase
      ? t("localizationWorkspaces.repairPhase", { phase })
      : t("localizationWorkspaces.access_The_repair_stopped_before_the_workspace_became_usable_The_pre_repair_backup_was_kept_"),
    action: { kind: "view_logs", get ["label"]() { return t("localizationWorkspaces.ui_View_repair_log"); } },
  };
}

function failedProvisionNotice(provision: WorkspaceOperation): WorkspaceAccessNotice {
  const phase = typeof provision.metadata?.seedFailurePhase === "string"
    ? provision.metadata.seedFailurePhase
    : null;
  return {
    get ["title"]() { return t("localizationWorkspaces.ui_Database_provisioning_failed"); },
    description: phase
      ? t("localizationWorkspaces.earlierClonePhase", { phase })
      : t("localizationWorkspaces.access_An_earlier_clone_attempt_failed_but_the_workspace_later_became_usable_"),
    action: { kind: "view_logs", get ["label"]() { return t("localizationWorkspaces.ui_View_provisioning_log"); } },
  };
}

const HANDOFF_REASON_COPY: Record<string, string> = {
  get handoff_not_configured() { return t("localizationWorkspaces.access_This_instance_has_no_workspace_login_handoff_configured_so_opening_the_board_falls_back_to"); },
  get no_board_identity() { return t("localizationWorkspaces.access_Your_session_has_no_cloned_user_to_sign_in_as_so_opening_the_board_falls_back_to_snapshot_"); },
  get runtime_not_running() { return t("localizationWorkspaces.access_No_healthy_runtime_service_is_publishing_a_URL_for_this_workspace_yet_"); },
  get runtime_url_unusable() { return t("localizationWorkspaces.access_The_runtime_row_is_publishing_a_URL_Paperclip_cannot_open_"); },
  get workspace_not_ready() { return t("localizationWorkspaces.access_The_cloned_database_is_not_ready_to_accept_a_login_yet_"); },
};

const READINESS_FAILURE_COPY: Record<string, string> = {
  get database_unreachable() { return t("localizationWorkspaces.access_The_isolated_database_is_not_answering_"); },
  get clone_data_missing() { return t("localizationWorkspaces.access_The_clone_restored_no_organization_or_issue_rows_"); },
  get clone_data_unreadable() { return t("localizationWorkspaces.access_The_cloned_product_tables_could_not_be_read_"); },
  get cloned_membership_missing() { return t("localizationWorkspaces.access_No_cloned_user_has_an_active_organization_membership_"); },
  get cloned_identity_unreadable() { return t("localizationWorkspaces.access_The_cloned_identity_tables_could_not_be_read_"); },
  get auth_handoff_not_configured() { return t("localizationWorkspaces.access_The_workspace_was_started_without_a_login_handoff_key_"); },
  get seed_manifest_unreadable() { return t("localizationWorkspaces.access_The_seed_manifest_is_unreadable_so_the_restore_cannot_be_trusted_"); },
};

/**
 * Human cause for a readiness rejection, preferring the specific recorded phase
 * over a generic sentence so the copy names what to fix.
 */
export function describeWorkspaceReadinessCause(
  failure: WorkspaceLoginHandoffFailureInfo | null | undefined,
): string | null {
  if (!failure) return null;
  const phase = describeSeedPhase(failure.readiness);
  if (phase && READINESS_FAILURE_COPY[phase]) return READINESS_FAILURE_COPY[phase];
  if (phase) return t("localizationWorkspaces.lastPhase", { phase });
  if (failure.detail && READINESS_FAILURE_COPY[failure.detail]) return READINESS_FAILURE_COPY[failure.detail];
  return HANDOFF_REASON_COPY[failure.reason] ?? null;
}

export function resolveWorkspaceAccessState(input: {
  runtimeServices: WorkspaceRuntimeService[] | null | undefined;
  operations: WorkspaceOperation[] | null | undefined;
  handoffFailure?: WorkspaceLoginHandoffFailureInfo | null;
}): WorkspaceAccessState {
  const operations = input.operations ?? [];
  const runtimeServices = input.runtimeServices ?? [];
  const repair = latestOperation(operations, "workspace_repair");
  const provision =
    latestOperation(operations, "workspace_seed")
    ?? latestOperation(operations, "workspace_runtime_provision")
    ?? latestOperation(operations, "workspace_provision");
  const failure = input.handoffFailure ?? null;
  const cause = describeWorkspaceReadinessCause(failure);
  const handoffAvailable = failure?.reason !== "handoff_not_configured" && failure?.reason !== "no_board_identity";
  const servingService = runtimeServices.find(
    (service) => service.status === "running" && service.healthStatus === "healthy" && service.url,
  );
  const startingService = runtimeServices.find(
    (service) => service.status === "provisioning" || service.status === "starting",
  );
  const repairFinishedAt = timestampMs(repair?.finishedAt);
  const servingServiceStartedAt = timestampMs(servingService?.startedAt);
  const provisionFinishedAt = timestampMs(provision?.finishedAt);
  const readinessConfirmsServing = Boolean(servingService && failure?.readiness?.state === "ready");
  const runtimeStartedAfterRepair = repairFinishedAt !== null
    && servingServiceStartedAt !== null
    && repairFinishedAt < servingServiceStartedAt;
  const repairFailureWasSuperseded = repair?.status === "failed" && Boolean(
    servingService
    && (readinessConfirmsServing || runtimeStartedAfterRepair),
  );
  const successfulRepairFinishedAt = repair?.status === "succeeded"
    ? timestampMs(repair.finishedAt)
    : null;
  // A failed seed is historical once the workspace is demonstrably serving,
  // or once a later repair has replaced and revalidated that database.
  const provisionFailureWasSuperseded = provision?.status === "failed" && Boolean(
    servingService
    || (
      provisionFinishedAt !== null
      && successfulRepairFinishedAt !== null
      && provisionFinishedAt < successfulRepairFinishedAt
    ),
  );
  const secondaryNotice = repair?.status === "failed" && repairFailureWasSuperseded
    ? failedRepairNotice(repair)
    : provision?.status === "failed" && provisionFailureWasSuperseded
      ? failedProvisionNotice(provision)
      : undefined;

  // A live repair outranks everything: it is already changing the answer.
  if (repair?.status === "running") {
    const phase = typeof repair.metadata?.repairPhase === "string" ? repair.metadata.repairPhase : null;
    return {
      state: "repairing",
      get ["title"]() { return t("localizationWorkspaces.ui_Repairing_workspace_database"); },
      description: phase
        ? t("localizationWorkspaces.repairPreservesFiles", { phase })
        : t("localizationWorkspaces.access_Only_the_isolated_database_is_replaced_the_git_worktree_and_your_files_are_preserved_"),
      action: { kind: "wait", get ["label"]() { return t("localizationWorkspaces.ui_Repair_in_progress"); } },
      handoffAvailable,
    };
  }
  if (repair?.status === "failed" && !repairFailureWasSuperseded) {
    const notice = failedRepairNotice(repair);
    return {
      state: "failed",
      ...notice,
      handoffAvailable,
    };
  }

  if (provision?.status === "running") {
    return {
      state: "provisioning",
      get ["title"]() { return t("localizationWorkspaces.ui_Provisioning_database"); },
      get ["description"]() { return t("localizationWorkspaces.ui_Restoring_the_isolated_database_clone_for_this_workspace_This_runs_once_before_the_first_start_"); },
      action: { kind: "wait", get ["label"]() { return t("localizationWorkspaces.ui_Provisioning"); } },
      handoffAvailable,
    };
  }
  if (provision?.status === "failed" && !provisionFailureWasSuperseded) {
    const seedPhase = typeof provision.metadata?.seedFailurePhase === "string"
      ? provision.metadata.seedFailurePhase
      : null;
    return {
      state: "failed",
      get ["title"]() { return t("localizationWorkspaces.ui_Database_provisioning_failed"); },
      description: seedPhase
        ? t("localizationWorkspaces.cloneFailedPhase", { phase: seedPhase })
        : t("localizationWorkspaces.access_The_clone_did_not_finish_so_this_workspace_has_no_usable_database_yet_"),
      action: { kind: "repair", get ["label"]() { return t("localizationWorkspaces.ui_Repair_workspace"); } },
      handoffAvailable,
    };
  }

  // Readiness the control plane actually observed beats anything inferred from
  // runtime rows, because it is the only signal that looked inside the clone.
  const staleNotReadyFailure = failure?.reason === "workspace_not_ready" && readinessConfirmsServing;
  if (failure && !staleNotReadyFailure) {
    if (failure.reason === "runtime_not_running" && !servingService && !startingService) {
      return {
        state: "stopped",
        get ["title"]() { return t("localizationWorkspaces.ui_Workspace_is_not_running"); },
        get ["description"]() { return t("localizationWorkspaces.ui_Start_the_workspace_runtime_to_publish_its_board_"); },
        action: { kind: "start", get ["label"]() { return t("localizationWorkspaces.ui_Start_workspace"); } },
        handoffAvailable,
      };
    }
    if (failure.reason === "workspace_not_ready" || failure.reason === "runtime_url_unusable") {
      const readinessState = failure.readiness?.state;
      const validating = readinessState === "validating" || readinessState === "provisioning";
      return {
        state: validating ? "validating" : "degraded",
        title: validating ? t("localizationWorkspaces.access_Validating_clone") : t("localizationWorkspaces.access_Workspace_is_degraded"),
        description: [
          cause ?? t("localizationWorkspaces.access_The_workspace_is_serving_but_its_clone_did_not_pass_the_readiness_contract_"),
          validating ? t("localizationWorkspaces.access_Paperclip_is_still_confirming_the_clone_") : t("localizationWorkspaces.access_One_bounded_repair_replaces_the_isolated_database_"),
        ].join(" "),
        action: validating
          ? { kind: "wait", get ["label"]() { return t("localizationWorkspaces.ui_Validating"); } }
          : { kind: "repair", get ["label"]() { return t("localizationWorkspaces.ui_Repair_workspace"); } },
        handoffAvailable,
      };
    }
    if (!handoffAvailable) {
      return {
        state: servingService ? "ready" : "degraded",
        title: servingService ? t("localizationWorkspaces.access_Ready_snapshot_local_sign_in") : t("localizationWorkspaces.access_Workspace_is_degraded"),
        description: cause ?? t("localizationWorkspaces.access_Opening_the_board_will_ask_for_the_credentials_captured_in_this_snapshot_"),
        action: servingService
          ? { kind: "open", get ["label"]() { return t("localizationWorkspaces.ui_Open_workspace"); } }
          : { kind: "start", get ["label"]() { return t("localizationWorkspaces.ui_Start_workspace"); } },
        handoffAvailable: false,
        secondaryNotice,
      };
    }
  }

  if (startingService) {
    return {
      state: "provisioning",
      get ["title"]() { return t("localizationWorkspaces.ui_Workspace_is_starting"); },
      get ["description"]() { return t("localizationWorkspaces.ui_Paperclip_is_starting_the_workspace_runtime_and_waiting_for_its_board_URL_"); },
      action: { kind: "wait", get ["label"]() { return t("localizationWorkspaces.ui_Starting_workspace"); } },
      handoffAvailable,
    };
  }

  if (servingService) {
    return {
      state: "ready",
      get ["title"]() { return t("localizationWorkspaces.ui_Ready"); },
      get ["description"]() { return t("localizationWorkspaces.ui_Opening_the_workspace_signs_you_in_to_the_cloned_board_without_a_password_"); },
      action: { kind: "open", get ["label"]() { return t("localizationWorkspaces.ui_Open_workspace"); } },
      handoffAvailable,
      secondaryNotice,
    };
  }

  const unhealthyService = runtimeServices.find(
    (service) => service.status === "running" && service.healthStatus !== "healthy",
  );
  if (unhealthyService) {
    return {
      state: "degraded",
      get ["title"]() { return t("localizationWorkspaces.ui_Workspace_is_degraded"); },
      description: cause
        ?? t("localizationWorkspaces.access_The_runtime_is_up_but_did_not_report_a_usable_database_so_Paperclip_will_not_publish_it_as"),
      action: { kind: "repair", get ["label"]() { return t("localizationWorkspaces.ui_Repair_workspace"); } },
      handoffAvailable,
    };
  }

  return {
    state: "stopped",
    get ["title"]() { return t("localizationWorkspaces.ui_Workspace_is_not_running"); },
    get ["description"]() { return t("localizationWorkspaces.ui_Start_the_workspace_runtime_to_publish_its_board_"); },
    action: { kind: "start", get ["label"]() { return t("localizationWorkspaces.ui_Start_workspace"); } },
    handoffAvailable,
  };
}
