import { isRetryableEnvironmentErrorCode, isRetryableEnvironmentHttpStatus, JsonRpcCallError, PLUGIN_RPC_ERROR_CODES, readEnvironmentAcquireErrorDiagnostic, readEnvironmentAcquisitionDiagnostic } from "@paperclipai/plugin-sdk";
import type { ProviderFailure } from "@paperclipai/shared";
import { getEnvironmentAcquisitionDiagnostic } from "./environment-acquisition-diagnostics.js";

/**
 * Setup failure code for a lease acquisition that the environment provider
 * refused with a transient status (HTTP 408/425/429/5xx or a connection-level
 * errno), or that reached its own acquisition deadline, before any agent work
 * started. The run is retried with the bounded
 * bootstrap budget. A provisional allocation whose cleanup could not be
 * confirmed stays owned by its own creation record, which the cleanup
 * reconciler settles independently; every retry is a new creation attempt
 * with its own idempotent identity, so it can neither reuse nor leak it.
 */
export const ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE = "environment_provider_unavailable";

/**
 * `reason` names evidence that has neither a provider status nor a deadline:
 * the provider reported a provisional creation that did not finish, or a
 * control-plane database query failed while the lease was taken.
 */
type TransientLeaseFailureReason = "acquisition_incomplete" | "provider_start_failed" | "database_error";
type TransientProviderEvidence = { httpStatus?: number; errorCode?: string; acquisitionTimedOut?: true; reason?: TransientLeaseFailureReason };

function own(value: unknown, key: string): unknown {
  try {
    return value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  } catch { return undefined; }
}

/**
 * Read transient provider evidence from structured fields only: the validated
 * plugin RPC envelope, or the status/errno an in-process provider attached to
 * its error. An acquisition whose first failure was its own deadline is
 * transient too. Message text is never parsed.
 */
export function readTransientEnvironmentProviderFailure(error: unknown): TransientProviderEvidence | null {
  for (let cause = error, depth = 0; cause && depth < 5; cause = own(cause, "cause"), depth++) {
    const acquisition = readEnvironmentAcquisitionDiagnostic(cause);
    if (acquisition && acquisition.elapsedMs >= acquisition.budgetMs) return { acquisitionTimedOut: true };
    const envelope = readEnvironmentAcquireErrorDiagnostic(cause);
    const statusValue = envelope?.httpStatus ?? [own(cause, "status"), own(cause, "statusCode")]
      .find(value => Number.isInteger(value));
    const codeValue = envelope?.errorCode ?? own(cause, "code");
    const httpStatus = typeof statusValue === "number" && isRetryableEnvironmentHttpStatus(statusValue) ? statusValue : undefined;
    const errorCode = typeof codeValue === "string" && isRetryableEnvironmentErrorCode(codeValue) ? codeValue : undefined;
    if (httpStatus !== undefined || errorCode !== undefined) {
      return { ...(httpStatus !== undefined ? { httpStatus } : {}), ...(errorCode !== undefined ? { errorCode } : {}) };
    }
    // A definite non-transient status is authoritative for this layer.
    if (typeof statusValue === "number" && statusValue >= 400) return null;
  }
  return null;
}

/**
 * A sandbox creation that a request started directly (an interactive setup or
 * a login sandbox), refused by the provider with a transient status. Only the
 * worker's validated RPC envelope on the error itself counts: a wrapper means
 * that Paperclip failed afterwards, for example while recording cleanup, and
 * must still be reported. Ownership of a provisional allocation stays with its
 * creation-cleanup record; this only decides the HTTP answer.
 */
export function readTransientSandboxCreationRefusal(error: unknown): { message: string } | null {
  if (!(error instanceof JsonRpcCallError)) return null;
  const acquisition = readEnvironmentAcquisitionDiagnostic(error);
  const envelope = readEnvironmentAcquireErrorDiagnostic(error);
  const timedOut = acquisition !== null && acquisition.elapsedMs >= acquisition.budgetMs;
  const httpStatus = envelope?.httpStatus !== undefined && isRetryableEnvironmentHttpStatus(envelope.httpStatus) ? envelope.httpStatus : undefined;
  const errorCode = envelope?.errorCode !== undefined && isRetryableEnvironmentErrorCode(envelope.errorCode) ? envelope.errorCode : undefined;
  if (!timedOut && httpStatus === undefined && errorCode === undefined) return null;
  const evidence = httpStatus !== undefined ? ` (HTTP ${httpStatus})` : errorCode !== undefined ? ` (${errorCode})` : "";
  return { message: evidence === ""
    ? "The sandbox provider did not finish starting the sandbox in time. Try again in a few minutes."
    : `The sandbox provider was temporarily unavailable${evidence}. Try again in a few minutes.` };
}

/** A definite non-transient HTTP status anywhere on the chain is authoritative: retrying cannot change it. */
function definiteNonTransientStatus(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 5; cause = own(cause, "cause"), depth++) {
    const status = readEnvironmentAcquireErrorDiagnostic(cause)?.httpStatus
      ?? [own(cause, "status"), own(cause, "statusCode")].find(value => Number.isInteger(value));
    if (typeof status === "number" && status >= 400 && !isRetryableEnvironmentHttpStatus(status)) return true;
  }
  return false;
}

// postgres.js connection-level codes, and SQLSTATEs a repeated statement can
// pass: connection (08), insufficient resources (53), operator intervention
// (57P01-57P03, 57014 query cancelled or timed out), lock not available (55P03),
// serialization failure and deadlock (40001, 40P01). A deterministic SQL error
// (syntax, schema, constraint) is not retried.
const DATABASE_CONNECTION_CODES = new Set(["CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT"]);
const TRANSIENT_SQLSTATES = new Set(["57P01", "57P02", "57P03", "57014", "55P03", "40001", "40P01"]);

function transientDatabaseFailure(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 5; cause = own(cause, "cause"), depth++) {
    const code = own(cause, "code");
    if (typeof code !== "string") continue;
    if (DATABASE_CONNECTION_CODES.has(code)) return true;
    if (/^[0-9A-Z]{5}$/.test(code) && (code.startsWith("08") || code.startsWith("53") || TRANSIENT_SQLSTATES.has(code))) {
      // A five-character code is a SQLSTATE only on a database driver error.
      const name = own(cause, "name");
      if (name === "PostgresError" || name === "DatabaseError" || own(cause, "severity") !== undefined) return true;
    }
  }
  return false;
}

/**
 * Classify a failed lease acquisition for the bounded bootstrap retry. Lease
 * acquisition precedes any provider (agent) work by construction, and every
 * retry is a new creation attempt with its own idempotent identity, so a
 * failure is retried unless it carries a definite non-transient status. Only
 * structured evidence is read: the provider's status or errno, the validated
 * acquisition diagnostic the runtime recorded for this run, the plugin RPC
 * deadline, or a transient database driver code. Message text is never parsed.
 */
export function readTransientLeaseAcquisitionFailure(
  error: unknown,
  run: { id: string; companyId: string },
): TransientProviderEvidence | null {
  const provider = readTransientEnvironmentProviderFailure(error);
  if (provider) return provider;
  if (definiteNonTransientStatus(error)) return null;
  for (let cause = error, depth = 0; cause && depth < 5; cause = own(cause, "cause"), depth++) {
    const acquisition = getEnvironmentAcquisitionDiagnostic(cause, run);
    if (acquisition) {
      if (acquisition.elapsedMs >= acquisition.budgetMs) return { acquisitionTimedOut: true };
      return { reason: acquisition.phase === "create" && acquisition.providerState === "error" ? "provider_start_failed" : "acquisition_incomplete" };
    }
    if (cause instanceof JsonRpcCallError && cause.code === PLUGIN_RPC_ERROR_CODES.TIMEOUT) return { acquisitionTimedOut: true };
  }
  return transientDatabaseFailure(error) ? { reason: "database_error" } : null;
}

const REASON_LABELS: Record<TransientLeaseFailureReason, string> = {
  acquisition_incomplete: "sandbox creation did not finish",
  provider_start_failed: "the provider could not start the sandbox",
  database_error: "a database query failed while recording the lease",
};

function category(evidence: TransientProviderEvidence): ProviderFailure["category"] {
  if (evidence.httpStatus === 429) return "rate_limit";
  if (evidence.acquisitionTimedOut || evidence.httpStatus === 408 || evidence.httpStatus === 504
      || evidence.errorCode === "ETIMEDOUT" || evidence.errorCode === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  return "overloaded";
}

/** A lease acquisition the environment provider refused transiently. */
export class EnvironmentProviderUnavailableError extends Error {
  readonly code = ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly environmentId: string | null;
  readonly environmentName: string;
  /** Read by the setup-failure path and shown on the task as the reason. */
  readonly providerFailure: ProviderFailure;

  constructor(input: { environmentId?: string; environmentName: string; driver: string; evidence: TransientProviderEvidence; cause: unknown }) {
    const status = input.evidence.httpStatus !== undefined ? `HTTP ${input.evidence.httpStatus}`
      : input.evidence.errorCode ?? (input.evidence.reason ? REASON_LABELS[input.evidence.reason] : undefined);
    super(status
      ? `Environment provider for "${input.environmentName}" was temporarily unavailable (${status}).`
      : `Environment provider for "${input.environmentName}" did not finish starting the sandbox in time.`, { cause: input.cause });
    this.name = "EnvironmentProviderUnavailableError";
    this.httpStatus = input.evidence.httpStatus ?? null;
    this.errorCode = input.evidence.errorCode ?? null;
    this.environmentId = input.environmentId ?? null;
    this.environmentName = input.environmentName;
    const providerCode = input.evidence.errorCode ?? (input.evidence.httpStatus === undefined ? input.evidence.reason : undefined);
    this.providerFailure = {
      schema: "paperclip.provider-failure.v1",
      provider: /^[a-zA-Z0-9_.:/-]{1,80}$/.test(input.driver) ? input.driver : "environment",
      phase: "startup",
      category: category(input.evidence),
      message: (status
        ? `The provider for "${input.environmentName}" was temporarily unavailable while Paperclip was starting it (${status}). `
        : `The sandbox for "${input.environmentName}" did not finish starting in time. `)
        + "No agent work had started. Paperclip keeps retrying automatically until the provider is back; if it stays unavailable for 30 minutes, use Retry once it is available.",
      ...(input.evidence.httpStatus !== undefined ? { httpStatus: input.evidence.httpStatus } : {}),
      ...(providerCode !== undefined ? { providerCode } : {}),
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
