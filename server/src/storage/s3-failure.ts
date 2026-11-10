import { recordStorageFailure, type StorageFailureOperation } from "./failure-diagnostics.js";
import { recordStorageRequest } from "./request-stats.js";

const ERROR_CODE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9+/=._-]{1,128}$/;

// Inspect data properties only. An SDK error can carry getters, request
// objects or provider XML; none of those are diagnostic payloads.
function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function matching(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function integerIn(value: unknown, min: number, max: number): number | null {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : null;
}

/** Record which S3 call failed and the provider's own correlation fields. */
function deadlineExpired(error: unknown, signal: AbortSignal | undefined) {
  return ownValue(error, "name") === "AbortError" && signal?.aborted === true
    && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
}

export function recordS3Failure(error: unknown, operation: StorageFailureOperation, signal?: AbortSignal): void {
  const metadata = ownValue(error, "$metadata");
  recordStorageFailure(error, {
    provider: "s3",
    operation,
    errorCode: deadlineExpired(error, signal) ? "TimeoutError"
      : matching(ownValue(error, "name"), ERROR_CODE) ?? matching(ownValue(error, "code"), ERROR_CODE) ?? "unknown",
    httpStatus: integerIn(ownValue(metadata, "httpStatusCode"), 100, 599),
    requestId: matching(ownValue(metadata, "requestId"), REQUEST_ID),
    attempts: integerIn(ownValue(metadata, "attempts"), 1, 100),
  });
}

/**
 * A GetObject body can fail after send() resolved, for example when the
 * socket resets mid-download. The response names the request; the stream
 * error's own code (ECONNRESET) names the failure better than its name.
 */
export function recordS3BodyFailure(error: unknown, response: unknown): void {
  const metadata = ownValue(response, "$metadata");
  recordStorageFailure(error, {
    provider: "s3",
    operation: "read_object_body",
    errorCode: matching(ownValue(error, "code"), ERROR_CODE) ?? matching(ownValue(error, "name"), ERROR_CODE) ?? "unknown",
    httpStatus: integerIn(ownValue(metadata, "httpStatusCode"), 100, 599),
    requestId: matching(ownValue(metadata, "requestId"), REQUEST_ID),
    attempts: integerIn(ownValue(metadata, "attempts"), 1, 100),
  });
}

export async function withS3FailureDiagnostics<T>(operation: StorageFailureOperation, send: () => Promise<T>,
  signal?: AbortSignal): Promise<T> {
  try {
    const result = await send();
    recordStorageRequest(result, false);
    return result;
  } catch (error) {
    recordStorageRequest(error, true);
    recordS3Failure(error, operation, signal);
    throw error;
  }
}
