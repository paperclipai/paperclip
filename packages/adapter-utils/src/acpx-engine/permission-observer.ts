import type { AcpPermissionDecision, AcpPermissionRequest } from "acpx/runtime";

/**
 * Observation-only hook into the ACP permission handoff. It never answers a
 * request. It records receipt and settlement in the run log so an operator
 * can tell a stalled handoff from a normal wait.
 *
 * Every emitted field passes through a closed enumeration or a bounded
 * scalar. The module never forwards the raw ACP frame, the tool input, or
 * any other free-form payload.
 */

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The agent process is untrusted. It picks how many permission requests it
// sends, so the observer must cap its own memory and log volume against that
// input. Each run gets its own budget: every counter below lives inside the
// observer closure, not at module scope.
//
// The ledger, the "observed" count, the "settled" count, and the "unsettled"
// count each get a separate budget of 256, instead of one shared budget. A
// diagnostic event class must never share a budget with an event class that
// the agent drives. "acpx.permission_settled" fires once for each tool call
// the agent completes, so a normal long run can spend a shared budget before
// the run ends. "acpx.permission_unsettled" is the one signal this observer
// exists to produce: it tells an operator that a handoff stalled. A shared
// budget would let a normal run silence that signal at the exact time it
// matters most. Four separate budgets keep each event class reachable no
// matter how the agent spends the others.
const MAX_LEDGER_ENTRIES = 256;
const MAX_OBSERVED_EVENTS = 256;
const MAX_SETTLED_EVENTS = 256;
const MAX_UNSETTLED_EVENTS = 256;

export const PERMISSION_OBSERVER_METHODS = ["session/request_permission"] as const;
export type PermissionObserverMethod = (typeof PERMISSION_OBSERVER_METHODS)[number] | "unknown";

export const PERMISSION_OBSERVER_TOOL_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
] as const;
export type PermissionObserverToolKind = (typeof PERMISSION_OBSERVER_TOOL_KINDS)[number] | "unknown";

// "requested" is not part of the raw ACP tool-call status enum. The observer
// assigns it itself, at receipt, before any tool-call status update arrives.
export const PERMISSION_OBSERVER_STAGES = ["requested", "pending", "in_progress", "completed", "failed"] as const;
export type PermissionObserverStage = (typeof PERMISSION_OBSERVER_STAGES)[number] | "unknown";

// A settlement outcome is always one of the two terminal tool-call statuses.
export const PERMISSION_OBSERVER_OUTCOMES = ["completed", "failed"] as const;
export type PermissionObserverOutcome = (typeof PERMISSION_OBSERVER_OUTCOMES)[number] | "unknown";

export const PERMISSION_OBSERVER_TRANSPORTS = ["local", "ssh", "sandbox"] as const;
export type PermissionObserverTransport = (typeof PERMISSION_OBSERVER_TRANSPORTS)[number] | "unknown";

export const PERMISSION_OBSERVER_PERMISSION_MODES = ["approve-all", "approve-reads", "deny-all"] as const;
export type PermissionObserverPermissionMode = (typeof PERMISSION_OBSERVER_PERMISSION_MODES)[number] | "unknown";

function mapClosedEnum<const T extends readonly string[]>(allowed: T, value: unknown): T[number] | "unknown" {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  return "unknown";
}

export function mapPermissionObserverMethod(value: unknown): PermissionObserverMethod {
  return mapClosedEnum(PERMISSION_OBSERVER_METHODS, value);
}

export function mapPermissionObserverToolKind(value: unknown): PermissionObserverToolKind {
  return mapClosedEnum(PERMISSION_OBSERVER_TOOL_KINDS, value);
}

function mapPermissionObserverToolCallStatus(value: unknown): PermissionObserverStage {
  return mapClosedEnum(PERMISSION_OBSERVER_STAGES, value);
}

export function mapPermissionObserverOutcome(value: unknown): PermissionObserverOutcome {
  return mapClosedEnum(PERMISSION_OBSERVER_OUTCOMES, value);
}

export function mapPermissionObserverTransport(value: unknown): PermissionObserverTransport {
  return mapClosedEnum(PERMISSION_OBSERVER_TRANSPORTS, value);
}

export function mapPermissionObserverPermissionMode(value: unknown): PermissionObserverPermissionMode {
  return mapClosedEnum(PERMISSION_OBSERVER_PERMISSION_MODES, value);
}

/**
 * Cap and type-guard a correlation identifier before it enters the log
 * payload. Paperclip keeps this value in the local run log only; it never
 * forwards it to an external sink.
 */
function capIdentifier(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  return value.length > MAX_IDENTIFIER_LENGTH ? value.slice(0, MAX_IDENTIFIER_LENGTH) : value;
}

function boundedAgeMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(Math.round(ms), MAX_AGE_MS);
}

interface PermissionLedgerEntry {
  sessionId: string;
  toolCallId: string;
  openedAtMs: number;
  toolKind: PermissionObserverToolKind;
  lastStage: PermissionObserverStage;
}

/** A minimal, structural view of the tool-call event the engine already consumes. */
export interface PermissionObserverToolCallEvent {
  toolCallId?: string;
  status?: string;
}

export interface PermissionObserverLogEvent {
  type:
    | "acpx.permission_observed"
    | "acpx.permission_settled"
    | "acpx.permission_unsettled"
    | "acpx.permission_observer_truncated";
  [key: string]: unknown;
}

export interface AcpPermissionObserverOptions {
  /**
   * Starts the durable log write. The observer never awaits this on the
   * permission critical path — call it and return, do not `await` it inside
   * `handlePermissionRequest`.
   */
  emitLog: (event: PermissionObserverLogEvent) => void;
  /** The engine's effective permission mode for this run. */
  permissionMode: unknown;
  /** The run's execution transport. */
  transport: unknown;
  now?: () => number;
}

export interface AcpPermissionObserver {
  /**
   * The `onPermissionRequest` hook. Always resolves to `undefined`: it never
   * answers, approves, denies, or maps a request to an option. Every branch,
   * including an internal error, resolves to `undefined` and never throws.
   */
  handlePermissionRequest: (
    request: AcpPermissionRequest,
    hookCtx: { signal: AbortSignal },
  ) => Promise<AcpPermissionDecision | undefined>;
  /**
   * Feed a `tool_call` runtime event so the ledger can close a matching open
   * entry once its status turns terminal. Call this for every such event on
   * the current session; the ledger uses the pair (sessionId, toolCallId) as
   * the entry's key.
   */
  noteToolCallEvent: (sessionId: string | undefined, event: PermissionObserverToolCallEvent) => void;
  /**
   * Emit one `acpx.permission_unsettled` event per entry still open. Call
   * this once, at run finalization. Not on the permission critical path.
   * `emitLog` returns `void`, so this call awaits no log write.
   */
  finalizeRun: () => Promise<void>;
}

export function createAcpPermissionObserver(options: AcpPermissionObserverOptions): AcpPermissionObserver {
  const now = options.now ?? Date.now;
  const ledger = new Map<string, PermissionLedgerEntry>();
  const permissionMode = mapPermissionObserverPermissionMode(options.permissionMode);
  const transport = mapPermissionObserverTransport(options.transport);

  // Per-run budget state. Each counter tracks a cumulative count of emitted
  // events, not the live ledger size, so an agent cannot reset a counter by
  // opening and settling requests in a loop (the churn case).
  let observedEventCount = 0;
  let settledEventCount = 0;
  let unsettledEventCount = 0;
  let suppressedLedgerEntries = 0;
  let suppressedObservedEvents = 0;
  let suppressedSettledEvents = 0;
  let suppressedUnsettledEvents = 0;
  let hasFinalized = false;

  const ledgerKey = (sessionId: string, toolCallId: string) => sessionId + "\u0000" + toolCallId;

  const handlePermissionRequest: AcpPermissionObserver["handlePermissionRequest"] = async (request) => {
    try {
      const rawSessionId = request?.sessionId;
      const rawToolCallId = request?.raw?.toolCall?.toolCallId;
      const sessionId = capIdentifier(rawSessionId);
      const toolCallId = capIdentifier(rawToolCallId);
      const toolKind = mapPermissionObserverToolKind(request?.inferredKind);
      // A ledger entry can only settle later if it opens with a real session
      // identifier and a real tool-call identifier. Open it only then, so a
      // missing field never produces an entry that can never close.
      if (typeof rawSessionId === "string" && typeof rawToolCallId === "string") {
        const key = ledgerKey(sessionId, toolCallId);
        if (!ledger.has(key)) {
          if (ledger.size < MAX_LEDGER_ENTRIES) {
            // The ledger entry always opens as "requested": the observer has
            // not yet seen a settlement for this tool call, whatever status
            // the permission request itself carried.
            ledger.set(key, {
              sessionId,
              toolCallId,
              openedAtMs: now(),
              toolKind,
              lastStage: "requested",
            });
          } else {
            suppressedLedgerEntries += 1;
          }
        }
      }
      // Count every emission against the budget, not the live ledger size, so
      // an agent cannot refill the budget by settling old requests.
      if (observedEventCount < MAX_OBSERVED_EVENTS) {
        observedEventCount += 1;
        options.emitLog({
          type: "acpx.permission_observed",
          sessionId,
          toolCallId,
          method: mapPermissionObserverMethod("session/request_permission"),
          toolKind,
          stage: "requested",
          permissionMode,
          transport,
        });
      } else {
        // Emit nothing, not even a reduced event: that keeps every
        // attacker-controlled identifier out of the log once the budget runs
        // out.
        suppressedObservedEvents += 1;
      }
    } catch {
      // The observer is diagnostic only. An internal error here must never
      // affect the permission handoff, so every failure resolves the same
      // way as a normal observation: `undefined`.
    }
    return undefined;
  };

  const noteToolCallEvent: AcpPermissionObserver["noteToolCallEvent"] = (sessionIdInput, event) => {
    try {
      const sessionId = capIdentifier(sessionIdInput);
      const toolCallId = capIdentifier(event?.toolCallId);
      const key = ledgerKey(sessionId, toolCallId);
      const entry = ledger.get(key);
      if (!entry) return;
      const stage = mapPermissionObserverToolCallStatus(event?.status);
      if (stage === "unknown") return;
      entry.lastStage = stage;
      const outcome = mapPermissionObserverOutcome(event?.status);
      if (outcome === "unknown") return;
      // Delete the entry (freeing the ledger memory) even when the settled
      // budget below is spent: the ledger must not hold a settled entry just
      // because the observer could not log its settlement.
      ledger.delete(key);
      if (settledEventCount < MAX_SETTLED_EVENTS) {
        settledEventCount += 1;
        options.emitLog({
          type: "acpx.permission_settled",
          sessionId: entry.sessionId,
          toolCallId: entry.toolCallId,
          outcome,
          ageMs: boundedAgeMs(now() - entry.openedAtMs),
        });
      } else {
        suppressedSettledEvents += 1;
      }
    } catch {
      // Diagnostic only; never let a logging failure surface into the event
      // loop that drains the turn's tool-call events.
    }
  };

  const finalizeRun: AcpPermissionObserver["finalizeRun"] = async () => {
    // The engine's settle step can call finalizeRun more than one time for
    // the same run. Only the first call may drain the ledger and emit the
    // summary event; every later call is a no-op.
    if (hasFinalized) return;
    hasFinalized = true;

    const openEntries = [...ledger.values()];
    ledger.clear();
    for (const entry of openEntries) {
      if (unsettledEventCount < MAX_UNSETTLED_EVENTS) {
        unsettledEventCount += 1;
        options.emitLog({
          type: "acpx.permission_unsettled",
          sessionId: entry.sessionId,
          toolCallId: entry.toolCallId,
          stage: entry.lastStage,
          ageMs: boundedAgeMs(now() - entry.openedAtMs),
        });
      } else {
        suppressedUnsettledEvents += 1;
      }
    }
    // Emit one summary event for the whole run, and only when the observer
    // suppressed something. It carries only the four counters and the type
    // field: no session identifier, no tool-call identifier, and no other
    // agent-controlled value.
    if (
      suppressedLedgerEntries > 0 ||
      suppressedObservedEvents > 0 ||
      suppressedSettledEvents > 0 ||
      suppressedUnsettledEvents > 0
    ) {
      options.emitLog({
        type: "acpx.permission_observer_truncated",
        suppressedLedgerEntries,
        suppressedObservedEvents,
        suppressedSettledEvents,
        suppressedUnsettledEvents,
      });
    }
  };

  return { handlePermissionRequest, noteToolCallEvent, finalizeRun };
}
