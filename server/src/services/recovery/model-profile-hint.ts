export const RECOVERY_MODEL_PROFILE_KEY = "cheap" as const;

export type RecoveryModelProfileWorkClass = "status_only" | "status_only_same_model" | "normal_model";

export const STATUS_ONLY_RECOVERY_GUARD_CONTEXT = {
  recoveryIntent: "status_only",
  allowDeliverableWork: false,
  allowDocumentUpdates: false,
  resumeRequiresNormalModel: true,
} as const;

const RECOVERY_MODEL_PROFILE_HINT_KEYS = [
  "modelProfile",
  "paperclipModelProfile",
  "recoveryIntent",
  "allowDeliverableWork",
  "allowDocumentUpdates",
  "resumeRequiresNormalModel",
] as const;

type RecoveryModelProfileHintKey = (typeof RECOVERY_MODEL_PROFILE_HINT_KEYS)[number];
type WithoutRecoveryModelProfileHints<T> = Omit<T, RecoveryModelProfileHintKey>;

export function scrubRecoveryModelProfileHints<T extends Record<string, unknown>>(
  input: T,
): WithoutRecoveryModelProfileHints<T> {
  const output: Record<string, unknown> = { ...input };
  for (const key of RECOVERY_MODEL_PROFILE_HINT_KEYS) {
    delete output[key];
  }
  return output as WithoutRecoveryModelProfileHints<T>;
}

export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "normal_model",
): WithoutRecoveryModelProfileHints<T>;
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "status_only",
): WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT & {
  modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY;
};
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "status_only_same_model",
): WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT;
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: RecoveryModelProfileWorkClass,
):
  | WithoutRecoveryModelProfileHints<T>
  | (WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT)
  | (WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT & {
    modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY;
  }) {
  if (workClass === "normal_model") {
    return scrubRecoveryModelProfileHints(input);
  }

  // 2026-08-22 session-churn fix (operator budget directive): the successful-run
  // handoff fires after EVERY productive run that lacks a disposition — the
  // highest-frequency recovery-class wake in the fleet. Tagging it with the
  // "cheap" model profile flipped the session config fingerprint (modelProfile
  // AND merged adapterConfig categories) on every normal->handoff->normal
  // alternation: 326 session resets/day measured, each forcing the NEXT
  // productive run to rebuild its session and re-upload ~50K context as fresh
  // input. The one-turn saving from the cheap model was far smaller than the
  // reset cost it inflicted. "status_only_same_model" keeps the full
  // disposition-only guard context (no deliverable work, no document updates)
  // but leaves the model untouched so the task session survives. True
  // low-frequency recovery paths (monitor recovery, quota recovery) keep the
  // cheap profile via "status_only".
  if (workClass === "status_only_same_model") {
    return {
      ...scrubRecoveryModelProfileHints(input),
      ...STATUS_ONLY_RECOVERY_GUARD_CONTEXT,
    };
  }

  return {
    ...scrubRecoveryModelProfileHints(input),
    ...STATUS_ONLY_RECOVERY_GUARD_CONTEXT,
    modelProfile: RECOVERY_MODEL_PROFILE_KEY,
  };
}

export function recoveryAssigneeAdapterOverrides(_workClass: Extract<RecoveryModelProfileWorkClass, "status_only">) {
  return { modelProfile: RECOVERY_MODEL_PROFILE_KEY };
}
