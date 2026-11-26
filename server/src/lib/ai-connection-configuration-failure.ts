const reasons = [
  "ai_connection_responsible_user_missing",
  "ai_connection_default_missing",
  "ai_connection_missing",
  "ai_connection_incompatible",
  "ai_connection_unavailable",
  "ai_connection_credential_not_shared",
] as const;
export type AiConnectionConfigurationReason = typeof reasons[number];
const failures = new WeakMap<Error, AiConnectionConfigurationReason>();

/** Owned selection evidence shared with lifecycle policy, without HTTP dependencies. */
export function recordAiConnectionConfigurationFailure(error: Error, reason: AiConnectionConfigurationReason) {
  failures.set(error, reason);
}

/** Only owned producers supply this evidence; matching names or HTTP codes do not. */
export function readAiConnectionConfigurationFailure(error: unknown): AiConnectionConfigurationReason | null {
  return error instanceof Error ? failures.get(error) ?? null : null;
}

export function isAiConnectionConfigurationReason(value: unknown): value is AiConnectionConfigurationReason {
  return typeof value === "string" && reasons.some((reason) => reason === value);
}

/**
 * A run's `configurationIncomplete` result records an AI selection that an owned
 * producer rejected, not the preparation step's broad catch wrapper. The same
 * selection fails again on any host until its owner acts.
 */
export function isOwnedAiConnectionSelectionRejection(configurationIncomplete: unknown): boolean {
  if (configurationIncomplete === null || typeof configurationIncomplete !== "object" || Array.isArray(configurationIncomplete)) return false;
  const configuration = configurationIncomplete as Record<string, unknown>;
  return configuration.reason === "ai_connection_unavailable" && isAiConnectionConfigurationReason(configuration.selectionFailure);
}
