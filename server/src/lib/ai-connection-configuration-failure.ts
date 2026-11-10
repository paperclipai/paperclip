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
