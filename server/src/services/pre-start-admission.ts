export type PreStartAdmissionMode = "observe" | "enforce";

export interface CapacityWindowSnapshot {
  /** Stable provider-defined window identifier. */
  key: string;
  /** Inclusive start of this quota window. */
  startsAt: Date;
  /** Exclusive reset boundary of this quota window. */
  resetsAt: Date;
  /** Units still available in this window. */
  remaining: number;
  /** Optional model scope. Null means provider-wide capacity. */
  model?: string | null;
}

export interface CapacitySnapshot {
  provider: string;
  /** Time the source actually observed the provider, not the cache read time. */
  observedAt: Date;
  windows: CapacityWindowSnapshot[];
}

export interface PreStartAdmissionSubject {
  companyId: string;
  agentId: string;
  issue: {
    id: string;
    identifier: string | null;
    title: string;
  } | null;
  issueId: string | null;
  runId: string;
  wakeupRequestId: string | null;
  provider: string;
  model: string | null;
}

export interface PreStartAdmissionDecision {
  allow: boolean;
  reason: string;
}

export interface PreStartAdmissionHook {
  /** Observe is the safe default: decisions are recorded but cannot stop a run. */
  mode?: PreStartAdmissionMode;
  /** Maximum accepted age of source telemetry. */
  maxSnapshotAgeMs: number;
  /** Reads existing telemetry only. It must not invoke a model/provider. */
  readCapacitySnapshot(
    subject: PreStartAdmissionSubject,
  ): Promise<CapacitySnapshot | null>;
  /** Atomically reserves capacity or vetoes. It must be idempotent by runId. */
  evaluate(input: {
    subject: PreStartAdmissionSubject;
    capacitySnapshot: CapacitySnapshot;
    activeWindow: CapacityWindowSnapshot;
  }): Promise<PreStartAdmissionDecision>;
}

let registeredPreStartAdmissionHook: PreStartAdmissionHook | null = null;

/**
 * Installs the process-wide host admission hook used by every heartbeat service.
 * Passing null restores the default observe-only/no-veto behavior.
 */
export function registerPreStartAdmissionHook(
  hook: PreStartAdmissionHook | null,
): void {
  registeredPreStartAdmissionHook = hook;
}

export function getPreStartAdmissionHook(): PreStartAdmissionHook | null {
  return registeredPreStartAdmissionHook;
}

export interface PreStartAdmissionOutcome extends PreStartAdmissionDecision {
  mode: PreStartAdmissionMode;
  enforced: boolean;
  reasonCode:
    | "allowed"
    | "hook_veto"
    | "telemetry_missing"
    | "telemetry_stale"
    | "capacity_window_missing"
    | "hook_error";
  capacitySnapshot: CapacitySnapshot | null;
  activeWindow: CapacityWindowSnapshot | null;
}

function finiteDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Selects the current window, preferring the newest model-specific window after a reset. */
export function selectActiveCapacityWindow(input: {
  snapshot: CapacitySnapshot;
  model: string | null;
  now: Date;
}): CapacityWindowSnapshot | null {
  const eligible = input.snapshot.windows.filter((window) => {
    if (!finiteDate(window.startsAt) || !finiteDate(window.resetsAt)) return false;
    if (!Number.isFinite(window.remaining) || window.remaining < 0) return false;
    if (window.startsAt.getTime() > input.now.getTime()) return false;
    if (window.resetsAt.getTime() <= input.now.getTime()) return false;
    return !window.model || window.model === input.model;
  });

  eligible.sort((left, right) => {
    const modelRank = Number(Boolean(right.model)) - Number(Boolean(left.model));
    if (modelRank !== 0) return modelRank;
    return right.startsAt.getTime() - left.startsAt.getTime();
  });
  return eligible[0] ?? null;
}

export async function evaluatePreStartAdmission(input: {
  hook: PreStartAdmissionHook;
  subject: PreStartAdmissionSubject;
  now?: Date;
}): Promise<PreStartAdmissionOutcome> {
  const mode = input.hook.mode ?? "observe";
  const enforced = mode === "enforce";
  const now = input.now ?? new Date();
  let snapshot: CapacitySnapshot | null = null;

  try {
    snapshot = await input.hook.readCapacitySnapshot(input.subject);
  } catch {
    return {
      allow: !enforced,
      enforced,
      mode,
      reason: "Capacity telemetry could not be read before run start.",
      reasonCode: "hook_error",
      capacitySnapshot: null,
      activeWindow: null,
    };
  }

  if (!snapshot || snapshot.provider !== input.subject.provider) {
    return {
      allow: !enforced,
      enforced,
      mode,
      reason: "Capacity telemetry is missing for the selected provider.",
      reasonCode: "telemetry_missing",
      capacitySnapshot: snapshot,
      activeWindow: null,
    };
  }

  const observedAtMs = snapshot.observedAt.getTime();
  const ageMs = now.getTime() - observedAtMs;
  if (
    !finiteDate(snapshot.observedAt) ||
    !Number.isFinite(input.hook.maxSnapshotAgeMs) ||
    input.hook.maxSnapshotAgeMs < 0 ||
    ageMs < 0 ||
    ageMs > input.hook.maxSnapshotAgeMs
  ) {
    return {
      allow: !enforced,
      enforced,
      mode,
      reason: "Capacity telemetry is stale at the pre-start boundary.",
      reasonCode: "telemetry_stale",
      capacitySnapshot: snapshot,
      activeWindow: null,
    };
  }

  const activeWindow = selectActiveCapacityWindow({
    snapshot,
    model: input.subject.model,
    now,
  });
  if (!activeWindow) {
    return {
      allow: !enforced,
      enforced,
      mode,
      reason: "Capacity telemetry has no current quota window.",
      reasonCode: "capacity_window_missing",
      capacitySnapshot: snapshot,
      activeWindow: null,
    };
  }

  try {
    const decision = await input.hook.evaluate({
      subject: input.subject,
      capacitySnapshot: snapshot,
      activeWindow,
    });
    return {
      allow: decision.allow || !enforced,
      enforced,
      mode,
      reason: decision.reason,
      reasonCode: decision.allow ? "allowed" : "hook_veto",
      capacitySnapshot: snapshot,
      activeWindow,
    };
  } catch {
    return {
      allow: !enforced,
      enforced,
      mode,
      reason: "Pre-start admission hook failed closed.",
      reasonCode: "hook_error",
      capacitySnapshot: snapshot,
      activeWindow,
    };
  }
}
