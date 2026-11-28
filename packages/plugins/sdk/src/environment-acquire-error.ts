import {
  ENVIRONMENT_ACQUIRE_ERROR_SCHEMA,
  ENVIRONMENT_CREATION_CLEANUP_SCHEMA,
  PluginEnvironmentAcquisitionError,
  PluginEnvironmentCreationCleanupError,
  environmentCreationCleanupErrorData,
  readEnvironmentAcquisitionDiagnostic,
} from "./environment-creation-cleanup.js";
import {
  providerErrorDiagnostic,
  sanitizeProviderErrorDiagnostic,
  type PluginEnvironmentResumeErrorDiagnostic,
} from "./environment-resume-error.js";

/**
 * Diagnostic evidence for a refused `environmentAcquireLease`: the provider's
 * HTTP status or a closed errno code. It crosses the worker RPC boundary as
 * structured error data because a JSON-RPC error carries only a message and a
 * numeric RPC code. Provider text and identifiers never cross. The host uses it
 * only to decide whether a bounded retry is worthwhile; ownership of any
 * provisional allocation stays with the creation-cleanup envelope.
 */
export type PluginEnvironmentAcquireErrorDiagnostic = PluginEnvironmentResumeErrorDiagnostic;

const SCHEMA = ENVIRONMENT_ACQUIRE_ERROR_SCHEMA;
const CLEANUP_SCHEMA = ENVIRONMENT_CREATION_CLEANUP_SCHEMA;

function field(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}

/**
 * Worker side: the RPC error data for a failed acquisition. A creation whose
 * cleanup could not be confirmed keeps its ownership envelope and adds the
 * status of the create call only, never of the compensating lookup or delete.
 */
export function environmentAcquireErrorData(error: unknown): unknown {
  const createError = error instanceof PluginEnvironmentCreationCleanupError ? error.errors[0] : error;
  const providerDiagnostic = providerErrorDiagnostic(createError);
  const cleanup = environmentCreationCleanupErrorData(error, true);
  if (cleanup && typeof cleanup === "object") {
    return providerDiagnostic ? { ...cleanup, providerDiagnostic } : cleanup;
  }
  const acquisitionDiagnostic = error instanceof PluginEnvironmentAcquisitionError
    ? readEnvironmentAcquisitionDiagnostic(error) : null;
  if (!providerDiagnostic && !acquisitionDiagnostic) return undefined;
  return {
    schema: SCHEMA,
    ...(providerDiagnostic ? { providerDiagnostic } : {}),
    ...(acquisitionDiagnostic ? { acquisitionDiagnostic } : {}),
  };
}

/** Host side: read and re-validate the provider diagnostic from an RPC error. */
export function readEnvironmentAcquireErrorDiagnostic(error: unknown): PluginEnvironmentAcquireErrorDiagnostic | null {
  const data = field(error, "data");
  const schema = field(data, "schema");
  if (schema !== SCHEMA && schema !== CLEANUP_SCHEMA) return null;
  const diagnostic = field(data, "providerDiagnostic");
  return sanitizeProviderErrorDiagnostic({ httpStatus: field(diagnostic, "httpStatus"), errorCode: field(diagnostic, "errorCode") });
}
