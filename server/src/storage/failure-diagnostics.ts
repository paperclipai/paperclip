// Server-only, fixed-shape storage failure details for error reporting. The
// provider that owns the protocol normalizes them; reporting reads only this
// record and never the provider's error payload.

export type StorageFailureOperation =
  | "put_object"
  | "get_object"
  | "head_object"
  | "delete_object"
  | "create_multipart_upload"
  | "upload_part"
  | "complete_multipart_upload";

export interface StorageFailureDiagnostics {
  provider: "s3";
  operation: StorageFailureOperation;
  errorCode: string;
  httpStatus: number | null;
  requestId: string | null;
  attempts: number | null;
}

const recorded = new WeakMap<object, Readonly<StorageFailureDiagnostics>>();

/** Keep the first record: it names the call that actually failed. */
export function recordStorageFailure(error: unknown, diagnostics: StorageFailureDiagnostics): void {
  if (!error || typeof error !== "object" || recorded.has(error)) return;
  recorded.set(error, Object.freeze({ ...diagnostics }));
}

export function storageFailureDiagnosticsFor(error: unknown): Readonly<StorageFailureDiagnostics> | null {
  if (!error || typeof error !== "object") return null;
  return recorded.get(error) ?? null;
}
