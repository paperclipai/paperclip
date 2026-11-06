/**
 * Pure proofs over durable runner state that a bootstrap never reached
 * provider work. Restart recovery and the executor share them, so the claim
 * and the executor's own check accept exactly the same shapes.
 */

export const RUNNERD_CONTROL_PLANE_STATE_SCHEMAS: ReadonlySet<string> = new Set([
  "paperclip.runner.durable.control-plane-state.v1",
  "paperclip.runner.durable.control-plane-state.v2",
]);

const RUNNERD_BOOTSTRAP_COMMAND_TYPES = new Set(["run.prepare", "session.open"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The runner never connected, so every bootstrap command is still undelivered. */
export function runnerdStateIsUnconnectedBootstrap(state: Record<string, unknown>): boolean {
  const commands = Array.isArray(state.commands) ? state.commands.map(record) : [];
  const committedEvents = Array.isArray(state.committedEvents) ? state.committedEvents : [];
  return RUNNERD_CONTROL_PLANE_STATE_SCHEMAS.has(String(state.schema)) &&
    state.connectionCount === 0 && committedEvents.length === 0 &&
    commands.every(command => command.status === "pending" &&
      RUNNERD_BOOTSTRAP_COMMAND_TYPES.has(String(command.type)));
}

/**
 * A provider turn can start only after session.open completes and the
 * controller issues a turn command. A root whose controller journal stops
 * before that point (run.prepare may be acknowledged, session.open never is,
 * no event was committed or acknowledged) and whose runner journal emitted no
 * event either holds no provider work, so restart recovery may quarantine it
 * and bootstrap again. Any other shape stays fail-closed.
 *
 * `runnerJournal` is `undefined` when the runner journal is not on this host
 * (never written locally, or a remote runner), `null` when it is unreadable.
 */
export function runnerdStateIsIncompleteBootstrap(
  state: Record<string, unknown>,
  runnerJournal?: Record<string, unknown> | null,
): boolean {
  if (runnerdStateIsUnconnectedBootstrap(state)) return true;
  if (!RUNNERD_CONTROL_PLANE_STATE_SCHEMAS.has(String(state.schema))) return false;
  if (typeof state.connectionCount !== "number" || !Number.isSafeInteger(state.connectionCount) ||
      state.connectionCount < 0) return false;
  if (!Array.isArray(state.committedEvents) || state.committedEvents.length !== 0) return false;
  if (state.ackedSourceSeq !== 0) return false;
  if (state.warmTransition != null || state.completedWarmTransition != null ||
      state.stagedRunAttachment != null) return false;
  if (record(state.bootstrapHistory).adopted === true) return false;
  if (!Array.isArray(state.commands)) return false;
  const commands = state.commands.map(record);
  if (!commands.every(command => RUNNERD_BOOTSTRAP_COMMAND_TYPES.has(String(command.type)) &&
      (command.status === "pending" ||
        (command.type === "run.prepare" && command.status === "completed")))) return false;
  // The controller cannot see runner events that were emitted but never
  // committed. When the runner journal exists it must agree that none were.
  if (runnerJournal === undefined) return true;
  if (runnerJournal === null) return false;
  const processed = Object.values(record(runnerJournal.processedCommands)).map(record);
  return Array.isArray(runnerJournal.outbox) && runnerJournal.outbox.length === 0 &&
    runnerJournal.nextSourceSeq === 1 && runnerJournal.ackedSourceSeq === 0 &&
    processed.every(command => RUNNERD_BOOTSTRAP_COMMAND_TYPES.has(String(command.commandType)) &&
      (command.commandType === "run.prepare" || command.status !== "completed"));
}
