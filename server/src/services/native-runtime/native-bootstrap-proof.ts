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

/** Events a runner commits while opening a provider session, before any turn. */
const SESSION_OPEN_EVENT_TYPES = new Set([
  "harness.ready",
  "session.started",
  "session.resumed",
  "session.updated",
  "session.capabilities.updated",
  "session.goal.snapshot",
]);

/**
 * A remote controller record whose runner opened its provider session but was
 * never sent a turn. Only the controller issues turn commands, and it writes
 * each one to this record before sending it, so a record holding just
 * run.prepare and session.open, with every committed event a session-open
 * event and every committed event accounted for, proves no provider turn,
 * tool call or result exists. Use only where the controller record is the
 * complete authority (a remote runner after its controller's lease expired).
 */
export function runnerdStateHasNoProviderTurn(state: Record<string, unknown>): boolean {
  if (runnerdStateIsIncompleteBootstrap(state)) return true;
  if (!RUNNERD_CONTROL_PLANE_STATE_SCHEMAS.has(String(state.schema))) return false;
  if (typeof state.connectionCount !== "number" || !Number.isSafeInteger(state.connectionCount) ||
      state.connectionCount < 0) return false;
  if (state.warmTransition != null || state.completedWarmTransition != null ||
      state.stagedRunAttachment != null) return false;
  if (record(state.bootstrapHistory).adopted === true) return false;
  if (!Array.isArray(state.commands) || !Array.isArray(state.committedEvents)) return false;
  const commands = state.commands.map(record);
  if (!commands.every(command => RUNNERD_BOOTSTRAP_COMMAND_TYPES.has(String(command.type)) &&
      (command.status === "pending" || command.status === "completed"))) return false;
  const events = state.committedEvents.map(record);
  // Every event since the first must still be here, in order, so none is hidden.
  if (typeof state.ackedSourceSeq !== "number" || !Number.isSafeInteger(state.ackedSourceSeq) ||
      state.ackedSourceSeq < 0 || state.ackedSourceSeq > events.length) return false;
  return events.every((event, index) => event.sourceSeq === index + 1 &&
    SESSION_OPEN_EVENT_TYPES.has(String(event.eventType)));
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
  if (!commands.every(command => preOpenCommandIsSafe(command.type, command.status))) return false;
  // The controller cannot see runner events that were emitted but never
  // committed. When the runner journal exists it must agree that none were.
  if (runnerJournal === undefined) return true;
  if (runnerJournal === null) return false;
  const processed = Object.values(record(runnerJournal.processedCommands)).map(record);
  return Array.isArray(runnerJournal.outbox) && runnerJournal.outbox.length === 0 &&
    runnerJournal.nextSourceSeq === 1 && runnerJournal.ackedSourceSeq === 0 &&
    processed.every(command => preOpenCommandIsSafe(command.commandType, command.status));
}

/** Runner process lifecycle commands a graceful drain sends; none reaches the provider. */
const RUNNER_LIFECYCLE_COMMAND_TYPES = new Set(["runner.drain", "runner.suspend", "runner.shutdown"]);

/**
 * Before any provider session exists: run.prepare may have completed,
 * session.open may be pending or have failed (no session was handed back),
 * and a drain may have sent runner lifecycle commands in any state.
 */
function preOpenCommandIsSafe(type: unknown, status: unknown): boolean {
  if (type === "run.prepare") return status === "pending" || status === "completed";
  if (type === "session.open") return status === "pending" || status === "failed";
  return RUNNER_LIFECYCLE_COMMAND_TYPES.has(String(type));
}

/** Commands that manage the runner process or read session state; none sends provider input. */
const RUNNER_MAINTENANCE_COMMAND_TYPES = new Set([
  "runner.drain", "runner.suspend", "runner.shutdown", "session.snapshot", "session.goal.get",
]);

/** Events a runner emits while opening a fresh session or managing its own process, before any turn. */
const PRE_TURN_EVENT_TYPES = new Set([
  "session.starting", "session.started", "session.capabilities.updated", "session.goal.snapshot",
  "harness.starting", "harness.ready", "harness.diagnostic",
  "runner.connected", "runner.disconnected", "runner.reconnected", "runner.diagnostic", "runner.backpressure",
  "runner.drain", "runner.draining", "runner.suspending", "runner.suspended", "runner.shutdown", "runner.stopped",
]);

/** Collects every recorded process and process-group id so each can be proven gone. */
function collectRecordedProcessIds(value: unknown, into: Array<{ id: unknown; group: boolean }>, depth = 0): boolean {
  if (depth > 10) return false;
  if (Array.isArray(value)) return value.every(entry => collectRecordedProcessIds(entry, into, depth + 1));
  if (!value || typeof value !== "object") return true;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "processId" || key === "pid") into.push({ id: entry, group: false });
    else if (key === "processGroupId") { if (entry !== null) into.push({ id: entry, group: true }); }
    else if (!collectRecordedProcessIds(entry, into, depth + 1)) return false;
  }
  return true;
}

function prpEventType(event: Record<string, unknown>): string {
  return String(event.eventType ?? record(record(event.envelope).payload).eventType);
}

export type OpenedSessionProofOptions = {
  /** True only when the runner and its provider processes ran on this host. */
  localProcesses: boolean;
  /** Whether a recorded process (or process-group) id has definitely exited. */
  processGone: (id: unknown, group: boolean) => boolean;
};

/**
 * A drain or restart can land after session.open started a fresh provider
 * session but before the controller issued any turn. That root holds an
 * empty provider session and no provider work, so recovery may quarantine it
 * and bootstrap again when all of these hold:
 *
 * - controller commands are run.prepare and session.open (both completed, the
 *   session freshly started rather than a resumed conversation) plus runner
 *   maintenance only;
 * - every committed event and every event left in the runner outbox is
 *   session setup or runner lifecycle, and compaction left no gap;
 * - the runner journal is present and processed no other command; and
 * - the session's provider process and every other recorded process id has
 *   exited on this host.
 *
 * Remote runners stay fail-closed here: their process ids belong to another host.
 */
export function runnerdStateIsOpenedSessionBeforeTurn(
  state: Record<string, unknown>,
  runnerJournal: Record<string, unknown> | null | undefined,
  options: OpenedSessionProofOptions,
): boolean {
  if (!options.localProcesses || !runnerJournal) return false;
  if (!RUNNERD_CONTROL_PLANE_STATE_SCHEMAS.has(String(state.schema))) return false;
  if (state.warmTransition != null || state.completedWarmTransition != null ||
      state.stagedRunAttachment != null) return false;
  if (record(state.bootstrapHistory).adopted === true) return false;
  if (!Array.isArray(state.commands) || !Array.isArray(state.committedEvents)) return false;
  const commands = state.commands.map(record);
  const prepares = commands.filter(command => command.type === "run.prepare");
  const opens = commands.filter(command => command.type === "session.open");
  if (prepares.length !== 1 || prepares[0]!.status !== "completed") return false;
  if (opens.length !== 1 || opens[0]!.status !== "completed") return false;
  if (!commands.every(command => RUNNERD_BOOTSTRAP_COMMAND_TYPES.has(String(command.type)) ||
      RUNNER_MAINTENANCE_COMMAND_TYPES.has(String(command.type)))) return false;
  const opened = record(record(opens[0]!.result).result);
  if (opened.status !== "started" || typeof opened.processId !== "number") return false;

  const committed = state.committedEvents.map(record);
  if (state.ackedSourceSeq !== committed.length ||
      !committed.every((event, index) => event.sourceSeq === index + 1)) return false;
  if (!Array.isArray(runnerJournal.outbox)) return false;
  const outbox = runnerJournal.outbox.map(record);
  if (![...committed, ...outbox].every(event => PRE_TURN_EVENT_TYPES.has(prpEventType(event)))) return false;
  const processed = Object.values(record(runnerJournal.processedCommands)).map(record);
  if (!processed.every(command => RUNNERD_BOOTSTRAP_COMMAND_TYPES.has(String(command.commandType)) ||
      RUNNER_MAINTENANCE_COMMAND_TYPES.has(String(command.commandType)))) return false;

  const ids: Array<{ id: unknown; group: boolean }> = [{ id: opened.processId, group: false }];
  if (!collectRecordedProcessIds([...committed, ...outbox, ...processed.map(command => command.result)], ids)) {
    return false;
  }
  return ids.every(({ id, group }) => options.processGone(id, group));
}
