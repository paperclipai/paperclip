import type {
  WorkspaceOperation,
  WorkspaceReadiness,
  WorkspaceReadinessState,
  WorkspaceRuntimeService,
} from "@paperclipai/shared";
import { t } from "@/i18n";

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
    title: t("workspaces.accessState.repairFailed.title"),
    description: phase
      ? t("workspaces.accessState.repairFailed.descriptionWithPhase", { phase })
      : t("workspaces.accessState.repairFailed.description"),
    action: { kind: "view_logs", label: t("workspaces.accessState.actions.viewRepairLog") },
  };
}

function failedProvisionNotice(provision: WorkspaceOperation): WorkspaceAccessNotice {
  const phase = typeof provision.metadata?.seedFailurePhase === "string"
    ? provision.metadata.seedFailurePhase
    : null;
  return {
    title: t("workspaces.accessState.provisionFailed.title"),
    description: phase
      ? t("workspaces.accessState.provisionFailed.noticeDescriptionWithPhase", { phase })
      : t("workspaces.accessState.provisionFailed.noticeDescription"),
    action: { kind: "view_logs", label: t("workspaces.accessState.actions.viewProvisioningLog") },
  };
}

function handoffReasonCopy(): Record<string, string> {
  return {
    handoff_not_configured: t("workspaces.accessState.handoffReason.handoffNotConfigured"),
    no_board_identity: t("workspaces.accessState.handoffReason.noBoardIdentity"),
    runtime_not_running: t("workspaces.accessState.handoffReason.runtimeNotRunning"),
    runtime_url_unusable: t("workspaces.accessState.handoffReason.runtimeUrlUnusable"),
    workspace_not_ready: t("workspaces.accessState.handoffReason.workspaceNotReady"),
  };
}

function readinessFailureCopy(): Record<string, string> {
  return {
    database_unreachable: t("workspaces.accessState.readinessFailure.databaseUnreachable"),
    clone_data_missing: t("workspaces.accessState.readinessFailure.cloneDataMissing"),
    clone_data_unreadable: t("workspaces.accessState.readinessFailure.cloneDataUnreadable"),
    cloned_membership_missing: t("workspaces.accessState.readinessFailure.clonedMembershipMissing"),
    cloned_identity_unreadable: t("workspaces.accessState.readinessFailure.clonedIdentityUnreadable"),
    auth_handoff_not_configured: t("workspaces.accessState.readinessFailure.authHandoffNotConfigured"),
    seed_manifest_unreadable: t("workspaces.accessState.readinessFailure.seedManifestUnreadable"),
  };
}

/**
 * Human cause for a readiness rejection, preferring the specific recorded phase
 * over a generic sentence so the copy names what to fix.
 */
export function describeWorkspaceReadinessCause(
  failure: WorkspaceLoginHandoffFailureInfo | null | undefined,
): string | null {
  if (!failure) return null;
  const phase = describeSeedPhase(failure.readiness);
  const readinessCopy = readinessFailureCopy();
  if (phase && readinessCopy[phase]) return readinessCopy[phase];
  if (phase) return t("workspaces.accessState.cause.lastRecordedPhase", { phase });
  if (failure.detail && readinessCopy[failure.detail]) return readinessCopy[failure.detail];
  return handoffReasonCopy()[failure.reason] ?? null;
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
      title: t("workspaces.accessState.repairing.title"),
      description: phase
        ? t("workspaces.accessState.repairing.descriptionWithPhase", { phase })
        : t("workspaces.accessState.repairing.description"),
      action: { kind: "wait", label: t("workspaces.accessState.actions.repairInProgress") },
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
      title: t("workspaces.accessState.provisioning.title"),
      description: t("workspaces.accessState.provisioning.description"),
      action: { kind: "wait", label: t("workspaces.accessState.actions.provisioning") },
      handoffAvailable,
    };
  }
  if (provision?.status === "failed" && !provisionFailureWasSuperseded) {
    const seedPhase = typeof provision.metadata?.seedFailurePhase === "string"
      ? provision.metadata.seedFailurePhase
      : null;
    return {
      state: "failed",
      title: t("workspaces.accessState.provisionFailed.title"),
      description: seedPhase
        ? t("workspaces.accessState.provisionFailed.descriptionWithPhase", { phase: seedPhase })
        : t("workspaces.accessState.provisionFailed.description"),
      action: { kind: "repair", label: t("workspaces.accessState.actions.repairWorkspace") },
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
        title: t("workspaces.accessState.notRunning.title"),
        description: t("workspaces.accessState.notRunning.description"),
        action: { kind: "start", label: t("workspaces.accessState.actions.startWorkspace") },
        handoffAvailable,
      };
    }
    if (failure.reason === "workspace_not_ready" || failure.reason === "runtime_url_unusable") {
      const readinessState = failure.readiness?.state;
      const validating = readinessState === "validating" || readinessState === "provisioning";
      return {
        state: validating ? "validating" : "degraded",
        title: validating
          ? t("workspaces.accessState.validating.title")
          : t("workspaces.accessState.degraded.title"),
        description: [
          cause ?? t("workspaces.accessState.degraded.fallbackCause"),
          validating
            ? t("workspaces.accessState.degraded.validatingHint")
            : t("workspaces.accessState.degraded.repairHint"),
        ].join(" "),
        action: validating
          ? { kind: "wait", label: t("workspaces.accessState.actions.validating") }
          : { kind: "repair", label: t("workspaces.accessState.actions.repairWorkspace") },
        handoffAvailable,
      };
    }
    if (!handoffAvailable) {
      return {
        state: servingService ? "ready" : "degraded",
        title: servingService
          ? t("workspaces.accessState.ready.snapshotTitle")
          : t("workspaces.accessState.degraded.title"),
        description: cause ?? t("workspaces.accessState.ready.snapshotDescription"),
        action: servingService
          ? { kind: "open", label: t("workspaces.accessState.actions.openWorkspace") }
          : { kind: "start", label: t("workspaces.accessState.actions.startWorkspace") },
        handoffAvailable: false,
        secondaryNotice,
      };
    }
  }

  if (startingService) {
    return {
      state: "provisioning",
      title: t("workspaces.accessState.starting.title"),
      description: t("workspaces.accessState.starting.description"),
      action: { kind: "wait", label: t("workspaces.accessState.actions.starting") },
      handoffAvailable,
    };
  }

  if (servingService) {
    return {
      state: "ready",
      title: t("workspaces.accessState.ready.title"),
      description: t("workspaces.accessState.ready.description"),
      action: { kind: "open", label: t("workspaces.accessState.actions.openWorkspace") },
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
      title: t("workspaces.accessState.degraded.title"),
      description: cause
        ?? t("workspaces.accessState.degraded.unhealthyCause"),
      action: { kind: "repair", label: t("workspaces.accessState.actions.repairWorkspace") },
      handoffAvailable,
    };
  }

  return {
    state: "stopped",
    title: t("workspaces.accessState.notRunning.title"),
    description: t("workspaces.accessState.notRunning.description"),
    action: { kind: "start", label: t("workspaces.accessState.actions.startWorkspace") },
    handoffAvailable,
  };
}
