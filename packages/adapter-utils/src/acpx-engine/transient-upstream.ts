/**
 * Transport-level upstream failures that are safe to retry.
 *
 * An ACP turn that dies because the upstream HTTP/SSE stream was cut mid-flight
 * ("Connection closed mid-response", "socket hang up", ...) leaves the session
 * in an unknown state but does NOT indicate a permanent fault: the same prompt
 * usually succeeds on a fresh session. The ACPX engine used to report every
 * failed turn as `acpx_turn_failed`, which is a deterministic protocol error
 * and therefore never reached the heartbeat's bounded transient retry ladder —
 * one dropped connection killed the whole run with no recovery.
 *
 * The patterns below are deliberately narrow. Only unambiguous transport /
 * upstream-capacity signals qualify; a broad pattern would misclassify a
 * genuinely broken adapter as retryable and loop forever.
 */
const TRANSIENT_UPSTREAM_TRANSPORT_PATTERNS: readonly RegExp[] = [
  /connection\s+closed\s+mid[- ]response/i,
  /\bsocket\s+hang\s?up\b/i,
  /\beconnreset\b/i,
  /\bepipe\b/i,
  /connection\s+reset\s+by\s+peer/i,
  /premature(?:ly)?\s+clos(?:e|ed|ing)/i,
  /\boverloaded(?:_error)?\b/i,
  /\bserver\s+overloaded\b/i,
  /\bservice\s+unavailable\b/i,
  // A context-window refusal ("400 invalid params, context window exceeds
  // limit (2013)") is NOT a transport interruption: it is a property of the
  // accumulated conversation, and replaying the same context dies
  // identically. It therefore has its own error code and its own re-seed
  // path - see ./context-overflow.ts.
];

export type TransientUpstreamFailure = {
  errorCode: "acpx_transient_upstream";
  errorFamily: "transient_upstream";
};

/**
 * True when the message describes a transport-level upstream interruption
 * rather than a deterministic failure (auth, malformed request, refusal).
 */
export function isTransientUpstreamTransportFailure(message: unknown): boolean {
  if (typeof message !== "string") return false;
  const text = message.trim();
  if (!text) return false;
  return TRANSIENT_UPSTREAM_TRANSPORT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Classify an upstream transport interruption so the run is recorded as a
 * transient failure. The heartbeat reads `errorFamily` to decide whether to
 * schedule a bounded retry, and the issue-level recovery service uses
 * `errorCode` to size the continuation budget.
 */
export function classifyTransientUpstreamFailure(
  message: unknown,
): TransientUpstreamFailure | null {
  if (!isTransientUpstreamTransportFailure(message)) return null;
  return { errorCode: "acpx_transient_upstream", errorFamily: "transient_upstream" };
}
