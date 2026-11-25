import { NativeSessionCloseUnrecoverableError } from "../../vendor/paperclip-runner/index.js";

/**
 * Closed labels for a native execution failure after its result was accepted.
 * The labels explain the failure; they grant no finalization or retry authority.
 */
export const NATIVE_POST_RESULT_FAILURE_CATEGORIES = [
  "io_not_found", "io_permission_denied", "io_failure", "runner_settlement_incomplete", "execution_failure",
] as const;

export type NativePostResultFailureCategory = typeof NATIVE_POST_RESULT_FAILURE_CATEGORIES[number];

export type NativePostResultFailureDiagnostic = Readonly<{
  stage: "post_result_execution";
  category: NativePostResultFailureCategory;
  resultAlreadyAccepted: true;
}>;

function closeUnrecoverable(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    if (current instanceof NativeSessionCloseUnrecoverableError) return true;
    if (current instanceof AggregateError && current.errors.some(item => item instanceof NativeSessionCloseUnrecoverableError)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Classify the execution error whose failure write an accepted result prevented. */
export function nativePostResultFailureCategory(error: unknown): NativePostResultFailureCategory {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === "ENOENT" ? "io_not_found"
    : code === "EACCES" || code === "EPERM" ? "io_permission_denied"
    : code === "EIO" ? "io_failure"
    // The runner kept the result but did not prove a durable suspension before
    // shutdown. This is not an ownership loss.
    : closeUnrecoverable(error) ? "runner_settlement_incomplete"
    : "execution_failure";
}

/** Read the diagnostic from an error or its causes; only the closed labels pass. */
export function readNativePostResultFailureDiagnostic(error: unknown): NativePostResultFailureDiagnostic | null {
  for (let current = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const diagnostic = (current as { diagnostic?: unknown }).diagnostic;
    if (!diagnostic || typeof diagnostic !== "object") continue;
    const { stage, category, resultAlreadyAccepted } = diagnostic as Record<string, unknown>;
    if (stage === "post_result_execution" && resultAlreadyAccepted === true
      && (NATIVE_POST_RESULT_FAILURE_CATEGORIES as readonly unknown[]).includes(category)) {
      return { stage, category: category as NativePostResultFailureCategory, resultAlreadyAccepted };
    }
  }
  return null;
}
