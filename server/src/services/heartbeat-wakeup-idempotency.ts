export type IdempotentWakeupHit<TRun> = {
  run: TRun | null;
};

export type IdempotentWakeupDecision<TRun> =
  | { kind: "miss" }
  | { kind: "hit"; run: TRun | null };

export function normalizeWakeupIdempotencyKey(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveIdempotentWakeupHit<TRun>(
  hit: IdempotentWakeupHit<TRun> | null | undefined,
): IdempotentWakeupDecision<TRun> {
  if (!hit) return { kind: "miss" };
  return { kind: "hit", run: hit.run ?? null };
}

export const WAKEUP_IDEMPOTENCY_UNIQUE_INDEX = "agent_wakeup_requests_company_agent_idempotency_key_uq";

export function isWakeupIdempotencyConflict(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "23505") {
    const fields = [candidate.constraint, candidate.constraint_name, candidate.message];
    if (fields
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.includes(WAKEUP_IDEMPOTENCY_UNIQUE_INDEX))) {
      return true;
    }
  }
  if (candidate.cause && candidate.cause !== error) {
    return isWakeupIdempotencyConflict(candidate.cause, depth + 1);
  }
  return false;
}
