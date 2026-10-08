/** Server-local provenance of a failure at a remote connection boundary. */
export type RemoteConnectionFailureReason = "connection_refused" | "dns_failure" | "network_unreachable"
  | "connection_reset" | "connection_timeout" | "tls_failure";
type Reason = RemoteConnectionFailureReason;
const failures = new WeakMap<Error, Reason>();

export function markRemoteConnectionFailure<T extends Error>(error: T, reason: Reason): T {
  failures.set(error, reason);
  return error;
}

export function readRemoteConnectionFailure(error: unknown): Reason | null {
  return error instanceof Error ? failures.get(error) ?? null : null;
}

const transportReasons: Readonly<Record<string, Reason>> = {
  ECONNREFUSED: "connection_refused",
  ENOTFOUND: "dns_failure",
  ENODATA: "dns_failure",
  EAI_AGAIN: "dns_failure",
  EHOSTUNREACH: "network_unreachable",
  ENETUNREACH: "network_unreachable",
  ECONNRESET: "connection_reset",
  EPIPE: "connection_reset",
  UND_ERR_SOCKET: "connection_reset",
  ETIMEDOUT: "connection_timeout",
  UND_ERR_CONNECT_TIMEOUT: "connection_timeout",
  UND_ERR_HEADERS_TIMEOUT: "connection_timeout",
  UND_ERR_BODY_TIMEOUT: "connection_timeout",
  CERT_HAS_EXPIRED: "tls_failure",
  CERT_NOT_YET_VALID: "tls_failure",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls_failure",
  SELF_SIGNED_CERT_IN_CHAIN: "tls_failure",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls_failure",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "tls_failure",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls_failure",
};

export function classifyRemoteConnectionError(value: unknown, depth = 0): Reason | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return null;
  const error = value as Record<string, unknown>;
  if (error.name === "AbortError") return null;
  const reason = typeof error.code === "string" && Object.hasOwn(transportReasons, error.code)
    ? transportReasons[error.code]!
    : null;
  if (error.code !== undefined && !reason) return null;
  if (error.errors !== undefined) {
    if (!Array.isArray(error.errors) || error.errors.length === 0 || error.errors.length > 8) return null;
    const reasons = error.errors.map((child) => classifyRemoteConnectionError(child, depth + 1));
    const first = reasons[0];
    return first && reasons.every((child) => child === first) && (!reason || reason === first) ? first : null;
  }
  if (reason) return reason;
  return error.cause !== undefined ? classifyRemoteConnectionError(error.cause, depth + 1) : null;
}
