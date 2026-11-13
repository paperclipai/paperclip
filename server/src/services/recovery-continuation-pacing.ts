export const RECOVERY_CONTINUATIONS_PER_COMPANY_PER_PASS = 5;
export const RECOVERY_CONTINUATION_MAX_HOLD_MS = 5 * 60_000;
export const RECOVERY_CONTINUATION_DELIVERY_BOUND_MS = 15 * 60_000;
export const PENDING_CONTINUATION_BOUND_MS = RECOVERY_CONTINUATION_MAX_HOLD_MS + 2 * 60_000;

export function recoveryContinuationHeldSince(input: {
  evidence: Record<string, unknown>;
  resolvedAt: Date | null;
  updatedAt: Date;
}) {
  const recordedAt = Date.parse(String((input.evidence.freshContinuation as { recordedAt?: unknown } | undefined)?.recordedAt ?? ""));
  return Number.isFinite(recordedAt) ? recordedAt : (input.resolvedAt ?? input.updatedAt).getTime();
}
