export const NATIVE_FAILED_BEFORE_PROVIDER_TURN_CODE = "native_failed_before_provider_turn";

export const FAILED_BEFORE_PROVIDER_TURN_KEY = "failedBeforeProviderTurn";
export const FAILED_BEFORE_PROVIDER_TURN_SCHEMA = "paperclip.failed-before-provider-turn.v1";

export type FailedBeforeProviderTurnProof = { source: "runner_ledger"; noProviderTurn: true; provenAt: string };

export type FailedBeforeProviderTurnRecord = {
  schema: typeof FAILED_BEFORE_PROVIDER_TURN_SCHEMA; cause: typeof NATIVE_FAILED_BEFORE_PROVIDER_TURN_CODE;
  proof: FailedBeforeProviderTurnProof;
};

export function readFailedBeforeProviderTurnRecord(profile: unknown): FailedBeforeProviderTurnRecord | null {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  const value = (profile as Record<string, unknown>)[FAILED_BEFORE_PROVIDER_TURN_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const proof = record.proof && typeof record.proof === "object" ? record.proof as Record<string, unknown> : {};
  return record.schema === FAILED_BEFORE_PROVIDER_TURN_SCHEMA && record.cause === NATIVE_FAILED_BEFORE_PROVIDER_TURN_CODE
    && proof.source === "runner_ledger" && proof.noProviderTurn === true && typeof proof.provenAt === "string"
    ? record as FailedBeforeProviderTurnRecord : null;
}

export class NativeFailedBeforeProviderTurnError extends Error {
  readonly code = NATIVE_FAILED_BEFORE_PROVIDER_TURN_CODE;
  readonly predecessorRunId = null;
  readonly proof: FailedBeforeProviderTurnProof = { source: "runner_ledger", noProviderTurn: true, provenAt: new Date().toISOString() };
  constructor(readonly providerLeaseId: string | null, cause: unknown) {
    super(`The computer could not be prepared before the agent started (${
      cause instanceof Error ? cause.message : String(cause)}). The task continues on a fresh computer.`, { cause });
    this.name = "NativeFailedBeforeProviderTurnError";
  }
}

export function findNativeFailedBeforeProviderTurn(error: unknown): NativeFailedBeforeProviderTurnError | null {
  const pending: unknown[] = [error];
  for (let seen = 0; pending.length > 0 && seen < 16; seen++) {
    const current = pending.shift();
    if (current instanceof NativeFailedBeforeProviderTurnError) return current;
    if (current instanceof AggregateError) pending.push(...current.errors);
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
  }
  return null;
}
