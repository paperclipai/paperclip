export const RECOVERY_MODEL_PROFILE_KEY = "cheap" as const;

export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
): T & { modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY } {
  return {
    ...input,
    modelProfile: RECOVERY_MODEL_PROFILE_KEY,
  };
}

export function recoveryAssigneeAdapterOverrides() {
  return { modelProfile: RECOVERY_MODEL_PROFILE_KEY };
}
