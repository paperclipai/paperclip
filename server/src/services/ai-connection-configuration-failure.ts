import { forbidden, unprocessable } from "../errors.js";
import { recordAiConnectionConfigurationFailure, type AiConnectionConfigurationReason } from "../lib/ai-connection-configuration-failure.js";
export { readAiConnectionConfigurationFailure, isAiConnectionConfigurationReason } from "../lib/ai-connection-configuration-failure.js";

type CredentialAccessFailure = { connectionName: string; grantId?: string };
const credentialAccessFailures = new WeakMap<Error, CredentialAccessFailure>();

/** Preserve the existing HTTP error while recording an explicit selection rejection. */
export function aiConnectionConfigurationFailure(
  reason: AiConnectionConfigurationReason,
  message: string,
  details: Record<string, unknown> = {},
) {
  const error = unprocessable(message, { ...details, code: reason });
  recordAiConnectionConfigurationFailure(error, reason);
  return error;
}

/** A verified active user lacks this credential's human sharing permission. */
export function aiConnectionCredentialNotSharedFailure(context?: CredentialAccessFailure) {
  const error = forbidden("This credential is not shared with the responsible user");
  recordAiConnectionConfigurationFailure(error, "ai_connection_credential_not_shared");
  if (context) credentialAccessFailures.set(error, { ...context });
  return error;
}

/** Display metadata only, kept off the public 403 response and free of secret material. */
export function readAiCredentialAccessFailure(error: unknown): CredentialAccessFailure | null {
  return error instanceof Error ? credentialAccessFailures.get(error) ?? null : null;
}
