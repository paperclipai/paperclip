export type RecoveryWorkClass = "status_only" | "normal_model";

export const STATUS_ONLY_RECOVERY_GUARD_CONTEXT = {
  recoveryIntent: "status_only",
  allowDeliverableWork: false,
  allowDocumentUpdates: false,
  resumeRequiresNormalModel: true,
} as const;

const RECOVERY_CONTEXT_KEYS = [
  // Retired model-profile fields are scrubbed from old queued contexts so an
  // upgrade cannot restore the removed execution path.
  "modelProfile",
  "paperclipModelProfile",
  "recoveryIntent",
  "allowDeliverableWork",
  "allowDocumentUpdates",
  "resumeRequiresNormalModel",
] as const;

type RecoveryContextKey = (typeof RECOVERY_CONTEXT_KEYS)[number];
type WithoutRecoveryContext<T> = Omit<T, RecoveryContextKey>;

export function scrubRecoveryContext<T extends Record<string, unknown>>(
  input: T,
): WithoutRecoveryContext<T> {
  const output: Record<string, unknown> = { ...input };
  for (const key of RECOVERY_CONTEXT_KEYS) delete output[key];
  return output as WithoutRecoveryContext<T>;
}

export function withRecoveryContext<T extends Record<string, unknown>>(
  input: T,
  workClass: "normal_model",
): WithoutRecoveryContext<T>;
export function withRecoveryContext<T extends Record<string, unknown>>(
  input: T,
  workClass: "status_only",
): WithoutRecoveryContext<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT;
export function withRecoveryContext<T extends Record<string, unknown>>(
  input: T,
  workClass: RecoveryWorkClass,
): WithoutRecoveryContext<T> | (WithoutRecoveryContext<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT) {
  const scrubbed = scrubRecoveryContext(input);
  return workClass === "status_only"
    ? { ...scrubbed, ...STATUS_ONLY_RECOVERY_GUARD_CONTEXT }
    : scrubbed;
}
