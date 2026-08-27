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

export type WorkspaceAccessState = {
  state: WorkspaceReadinessState;
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
    title: "Repair failed",
    description: phase
      ? `The repair stopped during ${phase}. The pre-repair backup was kept.`
      : "The repair stopped before the workspace became usable. The pre-repair backup was kept.",
    action: { kind: "view_logs", label: "View repair log" },
  };
}

function failedProvisionNotice(provision: WorkspaceOperation): WorkspaceAccessNotice {
  const phase = typeof provision.metadata?.seedFailurePhase === "string"
    ? provision.metadata.seedFailurePhase
    : null;
  return {
    title: "Database provisioning failed",
    description: phase
      ? `The earlier clone attempt failed during ${phase}. The workspace later became usable.`
      : "An earlier clone attempt failed, but the workspace later became usable.",
    action: { kind: "view_logs", label: "View provisioning log" },
  };
}

const HANDOFF_REASON_COPY: Record<string, string> = {
  handoff_not_configured:
    "This instance has no workspace login handoff configured, so opening the board falls back to snapshot-local credentials.",
  no_board_identity:
    "Your session has no cloned user to sign in as, so opening the board falls back to snapshot-local credentials.",
  runtime_not_running: "No healthy runtime service is publishing a URL for this workspace yet.",
  runtime_url_unusable: "The runtime row is publishing a URL Paperclip cannot open.",
  workspace_not_ready: "The cloned database is not ready to accept a login yet.",
};

const READINESS_FAILURE_COPY: Record<string, string> = {
  database_unreachable: "The isolated database is not answering.",
  clone_data_missing: "The clone restored no organization or issue rows.",
  clone_data_unreadable: "The cloned product tables could not be read.",
  cloned_membership_missing: "No cloned user has an active organization membership.",
  cloned_identity_unreadable: "The cloned identity tables could not be read.",
  auth_handoff_not_configured: "The workspace was started without a login handoff key.",
  seed_manifest_unreadable: "The seed manifest is unreadable, so the restore cannot be trusted.",
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
  if (phase) return `Last recorded phase: ${phase}.`;
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
      title: "Repairing workspace database",
      description: phase
        ? `Only the isolated database is replaced; the git worktree and your files are preserved. Current phase: ${phase}.`
        : "Only the isolated database is replaced; the git worktree and your files are preserved.",
      action: { kind: "wait", label: "Repair in progress" },
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
      title: "Provisioning database",
      description: "Restoring the isolated database clone for this workspace. This runs once before the first start.",
      action: { kind: "wait", label: "Provisioning" },
      handoffAvailable,
    };
  }
  if (provision?.status === "failed" && !provisionFailureWasSuperseded) {
    const seedPhase = typeof provision.metadata?.seedFailurePhase === "string"
      ? provision.metadata.seedFailurePhase
      : null;
    return {
      state: "failed",
      title: "Database provisioning failed",
      description: seedPhase
        ? `The clone failed during ${seedPhase}. Repairing replaces only the isolated database.`
        : "The clone did not finish, so this workspace has no usable database yet.",
      action: { kind: "repair", label: "Repair workspace" },
      handoffAvailable,
    };
  }

  // Readiness the control plane actually observed beats anything inferred from
  // runtime rows, because it is the only signal that looked inside the clone.
  const staleNotReadyFailure = failure?.reason === "workspace_not_ready" && readinessConfirmsServing;
  if (failure && !staleNotReadyFailure) {
    if (failure.reason === "runtime_not_running" && !servingService) {
      return {
        state: "provisioning",
        title: "Workspace is not running",
        description: "Start the workspace runtime to publish its board.",
        action: { kind: "start", label: "Start workspace" },
        handoffAvailable,
      };
    }
    if (failure.reason === "workspace_not_ready" || failure.reason === "runtime_url_unusable") {
      const readinessState = failure.readiness?.state;
      const validating = readinessState === "validating" || readinessState === "provisioning";
      return {
        state: validating ? "validating" : "degraded",
        title: validating ? "Validating clone" : "Workspace is degraded",
        description: [
          cause ?? "The workspace is serving, but its clone did not pass the readiness contract.",
          validating ? "Paperclip is still confirming the clone." : "One bounded repair replaces the isolated database.",
        ].join(" "),
        action: validating
          ? { kind: "wait", label: "Validating" }
          : { kind: "repair", label: "Repair workspace" },
        handoffAvailable,
      };
    }
    if (!handoffAvailable) {
      return {
        state: servingService ? "ready" : "degraded",
        title: servingService ? "Ready — snapshot-local sign-in" : "Workspace is degraded",
        description: cause ?? "Opening the board will ask for the credentials captured in this snapshot.",
        action: servingService
          ? { kind: "open", label: "Open workspace" }
          : { kind: "start", label: "Start workspace" },
        handoffAvailable: false,
        secondaryNotice,
      };
    }
  }

  if (servingService) {
    return {
      state: "ready",
      title: "Ready",
      description: "Opening the workspace signs you in to the cloned board without a password.",
      action: { kind: "open", label: "Open workspace" },
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
      title: "Workspace is degraded",
      description: cause
        ?? "The runtime is up but did not report a usable database, so Paperclip will not publish it as ready.",
      action: { kind: "repair", label: "Repair workspace" },
      handoffAvailable,
    };
  }

  return {
    state: "provisioning",
    title: "Workspace is not running",
    description: "Start the workspace runtime to publish its board.",
    action: { kind: "start", label: "Start workspace" },
    handoffAvailable,
  };
}
