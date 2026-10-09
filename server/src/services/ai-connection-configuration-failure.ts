import { unprocessable } from "../errors.js";

const reasons = [
  "ai_connection_responsible_user_missing",
  "ai_connection_default_missing",
  "ai_connection_missing",
  "ai_connection_incompatible",
  "ai_connection_unavailable",
] as const;
type AiConnectionConfigurationReason = typeof reasons[number];
const failures = new WeakMap<Error, AiConnectionConfigurationReason>();

/** Preserve the existing HTTP error while recording an explicit selection rejection. */
export function aiConnectionConfigurationFailure(
  reason: AiConnectionConfigurationReason,
  message: string,
  details: Record<string, unknown> = {},
) {
  const error = unprocessable(message, { ...details, code: reason });
  failures.set(error, reason);
  return error;
}

/** Only owned producers supply this evidence; matching names or HTTP codes do not. */
export function readAiConnectionConfigurationFailure(error: unknown): AiConnectionConfigurationReason | null {
  return error instanceof Error ? failures.get(error) ?? null : null;
}

export function isAiConnectionConfigurationReason(value: unknown): value is AiConnectionConfigurationReason {
  return typeof value === "string" && reasons.some((reason) => reason === value);
}
