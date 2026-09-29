import { DurableAuthorityStoreError } from "../../vendor/paperclip-runner/index.js";

/** Classify machine-readable backend conditions, never exception text. This
 * does not establish rollback: the controller must separately read and compare
 * its exact durable generation before allowing any same-owner retry. */
export function classifyNativeAuthorityStorageError(error: unknown): unknown {
  if (error instanceof DurableAuthorityStoreError) return error;
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
    const detail = cause as { code?: unknown; name?: unknown; cause?: unknown };
    if (detail instanceof DurableAuthorityStoreError) return detail;
    // PostgreSQL: disk_full, out_of_memory, too_many_connections. The latter
    // two can reject admission without exhausting persistent storage.
    if (["53100", "53200", "53300", "ENOSPC", "EDQUOT"].includes(String(detail.code))) {
      return new DurableAuthorityStoreError("storage_pressure", "authority storage capacity is temporarily unavailable");
    }
    // Preserve an unavailable/indeterminate disposition for connection loss,
    // read-only storage and shutdown. A successful COMMIT reply may be lost.
    if (["25006", "57P01", "57P02", "57P03", "08000", "08003", "08006", "08007", "08P01", "EROFS", "EIO", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"].includes(String(detail.code))) {
      return new DurableAuthorityStoreError("storage_unavailable", "authority storage operation could not be confirmed");
    }
    cause = detail.cause;
  }
  return error;
}
