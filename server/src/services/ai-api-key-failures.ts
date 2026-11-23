export const AI_KEY_VERIFICATION_FAILURES = {
  rejected: { code: "ai_connection_api_key_rejected", message: "The provider rejected this API key." },
  billing: { code: "ai_connection_billing_required", message: "The provider account for this API key has no credit or billing set up. Add credit with the provider, then try again." },
  rateLimited: { code: "ai_connection_rate_limited", message: "The provider is limiting requests for this account right now. Wait a minute, then try again." },
  unavailable: { code: "ai_connection_provider_unavailable", message: "The provider is having problems right now. Try again in a few minutes." },
  timeout: { code: "ai_connection_verification_timeout", message: "The provider did not answer in time. Try again." },
  unreachable: { code: "ai_connection_provider_unreachable", message: "Paperclip could not reach the provider. Check this server's network connection, then try again." },
  failed: { code: "ai_connection_verification_failed", message: "The provider could not verify this account. Try again." },
} as const;

export type AiKeyVerificationFailure = keyof typeof AI_KEY_VERIFICATION_FAILURES;

const VERIFICATION_FAILURE_CODES: ReadonlySet<string> = new Set(Object.values(AI_KEY_VERIFICATION_FAILURES).map(failure => failure.code));

export function isAiKeyVerificationFailureCode(code: unknown): code is (typeof AI_KEY_VERIFICATION_FAILURES)[AiKeyVerificationFailure]["code"] {
  return typeof code === "string" && VERIFICATION_FAILURE_CODES.has(code);
}
