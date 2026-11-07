import { readEnvironmentAcquireErrorDiagnostic } from "@paperclipai/plugin-sdk";
import type { ProviderFailure } from "@paperclipai/shared";

/**
 * Setup failure code for a lease acquisition that the environment provider
 * refused with a transient status (HTTP 408/425/429/5xx or a connection-level
 * errno) before any agent work started. The run is retried with the bounded
 * bootstrap budget. A provisional allocation whose cleanup could not be
 * confirmed stays owned by its own creation record, which the cleanup
 * reconciler settles independently; every retry is a new creation attempt
 * with its own idempotent identity, so it can neither reuse nor leak it.
 */
export const ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE = "environment_provider_unavailable";

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
// Connection-level failures only. ENOTFOUND (a wrong host) and ABORT_ERR (our
// own cancellation) are excluded: retrying cannot repair either.
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

type TransientProviderEvidence = { httpStatus?: number; errorCode?: string };

function own(value: unknown, key: string): unknown {
  try {
    return value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  } catch { return undefined; }
}

/**
 * Read transient provider evidence from structured fields only: the validated
 * plugin RPC envelope, or the status/errno an in-process provider attached to
 * its error. Message text is never parsed.
 */
export function readTransientEnvironmentProviderFailure(error: unknown): TransientProviderEvidence | null {
  for (let cause = error, depth = 0; cause && depth < 5; cause = own(cause, "cause"), depth++) {
    const envelope = readEnvironmentAcquireErrorDiagnostic(cause);
    const statusValue = envelope?.httpStatus ?? [own(cause, "status"), own(cause, "statusCode")]
      .find(value => Number.isInteger(value));
    const codeValue = envelope?.errorCode ?? own(cause, "code");
    const httpStatus = typeof statusValue === "number" && TRANSIENT_HTTP_STATUSES.has(statusValue) ? statusValue : undefined;
    const errorCode = typeof codeValue === "string" && TRANSIENT_ERROR_CODES.has(codeValue) ? codeValue : undefined;
    if (httpStatus !== undefined || errorCode !== undefined) {
      return { ...(httpStatus !== undefined ? { httpStatus } : {}), ...(errorCode !== undefined ? { errorCode } : {}) };
    }
    // A definite non-transient status is authoritative for this layer.
    if (typeof statusValue === "number" && statusValue >= 400) return null;
  }
  return null;
}

function category(evidence: TransientProviderEvidence): ProviderFailure["category"] {
  if (evidence.httpStatus === 429) return "rate_limit";
  if (evidence.httpStatus === 408 || evidence.httpStatus === 504
      || evidence.errorCode === "ETIMEDOUT" || evidence.errorCode === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  return "overloaded";
}

/** A lease acquisition the environment provider refused transiently. */
export class EnvironmentProviderUnavailableError extends Error {
  readonly code = ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  /** Read by the setup-failure path and shown on the task as the reason. */
  readonly providerFailure: ProviderFailure;

  constructor(input: { environmentName: string; driver: string; evidence: TransientProviderEvidence; cause: unknown }) {
    const status = input.evidence.httpStatus !== undefined ? `HTTP ${input.evidence.httpStatus}` : input.evidence.errorCode!;
    super(`Environment provider for "${input.environmentName}" was temporarily unavailable (${status}).`, { cause: input.cause });
    this.name = "EnvironmentProviderUnavailableError";
    this.httpStatus = input.evidence.httpStatus ?? null;
    this.errorCode = input.evidence.errorCode ?? null;
    this.providerFailure = {
      schema: "paperclip.provider-failure.v1",
      provider: /^[a-zA-Z0-9_.:/-]{1,80}$/.test(input.driver) ? input.driver : "environment",
      phase: "startup",
      category: category(input.evidence),
      message: `The provider for "${input.environmentName}" was temporarily unavailable while Paperclip was starting it (${status}). `
        + "No agent work had started. Paperclip retries automatically; if those retries are used up, use Retry once the provider is available.",
      ...(input.evidence.httpStatus !== undefined ? { httpStatus: input.evidence.httpStatus } : {}),
      ...(input.evidence.errorCode !== undefined ? { providerCode: input.evidence.errorCode } : {}),
      retryability: "transient",
    };
  }
}

/** Find a transient provider refusal through the orchestrator's error wrappers. */
export function findEnvironmentProviderUnavailableError(error: unknown): EnvironmentProviderUnavailableError | null {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (cause instanceof EnvironmentProviderUnavailableError) return cause;
  }
  return null;
}
