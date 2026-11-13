export const NATIVE_FAILED_BEFORE_PROVIDER_TURN_CODE = "native_failed_before_provider_turn";

export class NativeFailedBeforeProviderTurnError extends Error {
  readonly code = NATIVE_FAILED_BEFORE_PROVIDER_TURN_CODE;
  readonly predecessorRunId = null;
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
