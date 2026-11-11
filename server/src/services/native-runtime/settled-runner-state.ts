/** A Runner that dies abruptly between turns never writes `suspended`; its
 * journal stays `ready` at the idle cut that release read. Only a cut with no
 * unacknowledged event and no unresolved command is restorable. */
export function isSettledReadyRunnerState(state: Record<string, unknown>): boolean {
  const commands = state.processedCommands;
  return state.schema === "paperclip.runner.durable.state.v1" && state.lifecycle === "ready" &&
    Array.isArray(state.outbox) && state.outbox.length === 0 && Number.isSafeInteger(state.nextSourceSeq) &&
    Number(state.nextSourceSeq) > 0 && state.ackedSourceSeq === Number(state.nextSourceSeq) - 1 &&
    state.pendingTerminalDelivery == null && state.pendingProviderCleanup == null && state.warmTransition == null &&
    commands !== null && typeof commands === "object" && !Array.isArray(commands) &&
    Object.values(commands).every(command => {
      const status = command !== null && typeof command === "object" ? (command as { status?: unknown }).status : undefined;
      return typeof status === "string" && status !== "" && status !== "pending" && status !== "indeterminate";
    });
}

const emptyIfPresent = (value: unknown) => value === undefined ||
  (Array.isArray(value) ? value.length === 0 : value !== null && typeof value === "object" && Object.keys(value).length === 0);

/** The Runner journal stays `ready` while a turn runs; only the provider
 * checkpoint records the active turn. A settled `ready` journal is between
 * turns only when this checkpoint has no active, ambiguous or unconfirmed turn
 * and nothing queued. An unknown checkpoint shape is never idle. */
export function isIdleProviderCheckpoint(state: Record<string, unknown>): boolean {
  return Array.isArray(state.pendingEvents) && state.pendingEvents.length === 0 &&
    emptyIfPresent(state.queuedEvents) && emptyIfPresent(state.pendingToolCalls) &&
    emptyIfPresent(state.pendingRuntimeRequests) && emptyIfPresent(state.ambiguousToolDeliveries) &&
    (state.activeProviderTurnId ?? null) === null && (state.activeTurnId ?? null) === null &&
    state.ambiguousTurnStartPending !== true && state.providerExitUnconfirmed !== true;
}
