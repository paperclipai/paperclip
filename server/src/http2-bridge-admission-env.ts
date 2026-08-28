import {
  resolveHttp2BridgeAdmissionCaps,
  resolveMaxLiveHttp2BridgeSessions,
  resolveMaxParallelHttp2BridgeRequests,
  type Http2BridgeAdmissionCapOverrideRejectionReporter,
  type Http2BridgeAdmissionCaps,
  type Http2BridgeAdmissionPairRejectionReporter,
} from "@paperclipai/adapter-utils/http2-bridge-admission";

/**
 * Resolve the parallel-stream admission cap from the raw operator override
 * string. The host reads the override from
 * PAPERCLIP_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS.
 *
 * This helper distinguishes an absent variable from a present blank value. An
 * absent variable is `undefined`. The helper then uses the documented default
 * and does not report a rejection. A present variable is a string, even when
 * the string holds only whitespace. The helper sends every present string
 * through `Number`, so a blank or whitespace-only value becomes `0`. The
 * numeric validation in {@link resolveMaxParallelHttp2BridgeRequests} rejects
 * `0`, reports it through `onRejectedOverride`, and returns the safe default.
 * So a present blank value is visible as invalid instead of silent as absent.
 *
 * `Number` ignores surrounding whitespace, so a valid value with surrounding
 * spaces still parses. The reporter receives only the parsed number, never
 * the raw string, so no operator-supplied text reaches a log line.
 */
export function resolveMaxParallelHttp2BridgeRequestsFromEnv(
  rawOverride: string | undefined,
  onRejectedOverride?: Http2BridgeAdmissionCapOverrideRejectionReporter,
): number {
  return resolveMaxParallelHttp2BridgeRequests(
    rawOverride === undefined ? undefined : Number(rawOverride),
    onRejectedOverride,
  );
}

/**
 * Resolve the live-session admission cap from the raw operator override
 * string. The host reads the override from
 * PAPERCLIP_MAX_LIVE_HTTP2_BRIDGE_SESSIONS. Same present-versus-absent
 * behavior as {@link resolveMaxParallelHttp2BridgeRequestsFromEnv}.
 */
export function resolveMaxLiveHttp2BridgeSessionsFromEnv(
  rawOverride: string | undefined,
  onRejectedOverride?: Http2BridgeAdmissionCapOverrideRejectionReporter,
): number {
  return resolveMaxLiveHttp2BridgeSessions(
    rawOverride === undefined ? undefined : Number(rawOverride),
    onRejectedOverride,
  );
}

/**
 * Resolve one admission cap pair from the two raw operator override strings.
 *
 * {@link resolveHttp2BridgeAdmissionCaps} runs the two per-field resolvers
 * without a rejection reporter, so a per-field rejection would stay silent if
 * this helper only called that function. This helper runs each per-field
 * resolver itself first, with `onRejectedOverride` bound, so a rejected
 * PAPERCLIP_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS or
 * PAPERCLIP_MAX_LIVE_HTTP2_BRIDGE_SESSIONS value always reports through
 * `onRejectedOverride` exactly once. It then passes the two resolved numbers
 * into {@link resolveHttp2BridgeAdmissionCaps}, which reruns the same
 * per-field checks on two already-valid numbers (harmless) and then applies
 * the joint budget rule. A pair that fails the joint rule reports through
 * `onRejectedPair` and returns both defaults; the host never keeps one
 * operator value and one default from a refused pair.
 */
export function resolveHttp2BridgeAdmissionCapsFromEnv(
  rawParallel: string | undefined,
  rawSessions: string | undefined,
  onRejectedOverride?: Http2BridgeAdmissionCapOverrideRejectionReporter,
  onRejectedPair?: Http2BridgeAdmissionPairRejectionReporter,
): Http2BridgeAdmissionCaps {
  const maxParallel = resolveMaxParallelHttp2BridgeRequestsFromEnv(rawParallel, onRejectedOverride);
  const maxSessions = resolveMaxLiveHttp2BridgeSessionsFromEnv(rawSessions, onRejectedOverride);
  return resolveHttp2BridgeAdmissionCaps({ maxParallel, maxSessions }, onRejectedPair);
}
