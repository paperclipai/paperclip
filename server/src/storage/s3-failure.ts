import { recordStorageFailure, type StorageFailureOperation } from "./failure-diagnostics.js";

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
export function recordS3Failure(error: unknown, operation: StorageFailureOperation): void {
  const metadata = ownValue(error, "$metadata");
  recordStorageFailure(error, {
    provider: "s3",
    operation,
    errorCode: matching(ownValue(error, "name"), ERROR_CODE) ?? matching(ownValue(error, "code"), ERROR_CODE) ?? "unknown",
    httpStatus: integerIn(ownValue(metadata, "httpStatusCode"), 100, 599),
    requestId: matching(ownValue(metadata, "requestId"), REQUEST_ID),
    attempts: integerIn(ownValue(metadata, "attempts"), 1, 100),
  });
}

export async function withS3FailureDiagnostics<T>(operation: StorageFailureOperation, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    recordS3Failure(error, operation);
    throw error;
  }
}
