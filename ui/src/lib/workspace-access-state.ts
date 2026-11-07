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
    get "title"() { return t("display:copy_cf05c4a1cce4"); },
    description: phase
      ? t("display:copy_0976c488fd52", { value0: phase })
      : t("display:copy_e618360cc1ea"),
    action: { kind: "view_logs", get "label"() { return t("display:copy_540a13ed17c0"); } },
  };
}

function failedProvisionNotice(provision: WorkspaceOperation): WorkspaceAccessNotice {
  const phase = typeof provision.metadata?.seedFailurePhase === "string"
    ? provision.metadata.seedFailurePhase
    : null;
  return {
    get "title"() { return t("display:copy_bc3f498e3bf2"); },
    description: phase
      ? t("display:copy_576be712e2f1", { value0: phase })
      : t("display:copy_b65ed98e7ef7"),
    action: { kind: "view_logs", get "label"() { return t("display:copy_cfb06ac4480c"); } },
  };
}

const HANDOFF_REASON_COPY: Record<string, string> = {
  get "handoff_not_configured"() { return t("display:copy_9b6f65bc9810"); },
  get "no_board_identity"() { return t("display:copy_b2da4b8a437c"); },
  get "runtime_not_running"() { return t("display:copy_c47219023fef"); },
  get "runtime_url_unusable"() { return t("display:copy_751a87ba90b0"); },
  get "workspace_not_ready"() { return t("display:copy_4f04d4515f14"); },
};

const READINESS_FAILURE_COPY: Record<string, string> = {
  get "database_unreachable"() { return t("display:copy_e436ca1722c0"); },
  get "clone_data_missing"() { return t("display:copy_d77c81e18c99"); },
  get "clone_data_unreadable"() { return t("display:copy_6222865ad6d8"); },
  get "cloned_membership_missing"() { return t("display:copy_33b46f85aec9"); },
  get "cloned_identity_unreadable"() { return t("display:copy_037b3ab896f3"); },
  get "auth_handoff_not_configured"() { return t("display:copy_b19927abddcd"); },
  get "seed_manifest_unreadable"() { return t("display:copy_877f1465c96d"); },
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
  if (phase) return t("display:copy_f41ab05dcc69", { value0: phase });
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
      get "title"() { return t("display:copy_5c8ce995c32e"); },
      description: phase
        ? t("display:copy_a52c118f2950", { value0: phase })
        : t("display:copy_1f2213b37f5f"),
      action: { kind: "wait", get "label"() { return t("display:copy_dd376b16c3a1"); } },
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
      get "title"() { return t("display:copy_1d243d0e2669"); },
      get "description"() { return t("display:copy_634ea5967357"); },
      action: { kind: "wait", get "label"() { return t("display:copy_3306224eaa75"); } },
      handoffAvailable,
    };
  }
  if (provision?.status === "failed" && !provisionFailureWasSuperseded) {
    const seedPhase = typeof provision.metadata?.seedFailurePhase === "string"
      ? provision.metadata.seedFailurePhase
      : null;
    return {
      state: "failed",
      get "title"() { return t("display:copy_bc3f498e3bf2"); },
      description: seedPhase
        ? t("display:copy_8566243b1b9b", { value0: seedPhase })
        : t("display:copy_eb47c6672d34"),
      action: { kind: "repair", get "label"() { return t("display:copy_a0d1b1860312"); } },
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
        get "title"() { return t("display:copy_ce47dd8815e3"); },
        get "description"() { return t("display:copy_3aea9d0f68e4"); },
        action: { kind: "start", get "label"() { return t("display:copy_5d565ada965e"); } },
        handoffAvailable,
      };
    }
    if (failure.reason === "workspace_not_ready" || failure.reason === "runtime_url_unusable") {
      const readinessState = failure.readiness?.state;
      const validating = readinessState === "validating" || readinessState === "provisioning";
      return {
        state: validating ? "validating" : "degraded",
        title: validating ? t("display:copy_332bb0b7db51") : t("display:copy_36c6e48e6831"),
        description: [
          cause ?? "The workspace is serving, but its clone did not pass the readiness contract.",
          validating ? t("display:copy_1515afd37536") : t("display:copy_b93213fd774c"),
        ].join(" "),
        action: validating
          ? { kind: "wait", get "label"() { return t("display:copy_c419ad45b1c0"); } }
          : { kind: "repair", get "label"() { return t("display:copy_a0d1b1860312"); } },
        handoffAvailable,
      };
    }
    if (!handoffAvailable) {
      return {
        state: servingService ? "ready" : "degraded",
        title: servingService ? t("display:copy_83c5c11bf68d") : t("display:copy_36c6e48e6831"),
        description: cause ?? t("display:copy_8ddac8ef1731"),
        action: servingService
          ? { kind: "open", get "label"() { return t("display:copy_257e64a4c9f5"); } }
          : { kind: "start", get "label"() { return t("display:copy_5d565ada965e"); } },
        handoffAvailable: false,
        secondaryNotice,
      };
    }
  }

  if (startingService) {
    return {
      state: "provisioning",
      get "title"() { return t("display:copy_52c99d9010c5"); },
      get "description"() { return t("display:copy_541af8de9d80"); },
      action: { kind: "wait", get "label"() { return t("display:copy_2e094a0cdf51"); } },
      handoffAvailable,
    };
  }

  if (servingService) {
    return {
      state: "ready",
      get "title"() { return t("display:copy_4345b3508c8a"); },
      get "description"() { return t("display:copy_ea9a23f0bd47"); },
      action: { kind: "open", get "label"() { return t("display:copy_257e64a4c9f5"); } },
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
      get "title"() { return t("display:copy_36c6e48e6831"); },
      description: cause
        ?? "The runtime is up but did not report a usable database, so Paperclip will not publish it as ready.",
      action: { kind: "repair", get "label"() { return t("display:copy_a0d1b1860312"); } },
      handoffAvailable,
    };
  }

  return {
    state: "stopped",
    get "title"() { return t("display:copy_ce47dd8815e3"); },
    get "description"() { return t("display:copy_3aea9d0f68e4"); },
    action: { kind: "start", get "label"() { return t("display:copy_5d565ada965e"); } },
    handoffAvailable,
  };
}
