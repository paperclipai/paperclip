import type { PrpEvent } from "../protocol/replay-contract.js";
import type {
  SessionItemSnapshot,
  SessionSnapshot,
} from "../reducer/session-reducer.js";
import type { GoalOperation, RunnerCapabilities } from "./protocol.js";

/**
 * A projection of reducer state plus the canonical events that produced it.
 * It never stores anything the protocol did not send, so a replayed session
 * and a live session with the same events project identically.
 */
export type TranscriptRole =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "steering"
  | "interrupt"
  | "goal"
  | "lineage"
  | "system";

export interface TranscriptItemEntry {
  kind: "item";
  key: string;
  position: number;
  role: TranscriptRole;
  item: SessionItemSnapshot;
  interrupted: boolean;
  streaming: boolean;
  toolName: string | null;
  input: string | null;
  output: string | null;
  failure: string | null;
  debugEvents?: readonly TranscriptDebugEvent[];
}

export interface TranscriptDebugEvent {
  source: string;
  sourceSeq: number;
  sourceEventId: string;
  eventType: string;
  emittedAt: string;
  turnId: string | null;
  itemId: string | null;
  payload: unknown;
}

export interface TranscriptUserEntry {
  kind: "user";
  key: string;
  position: number;
  turnId: string | null;
  text: string;
}

export interface TranscriptRequestEntry {
  kind: "request";
  key: string;
  position: number;
  requestId: string;
  requestKind: string;
  type: string;
  prompt: string;
  status: "pending" | "resolved" | "expired" | "cancelled";
  actions: string[];
  details: Record<string, unknown>;
  resolvedAction: string | null;
  resolvedAt: string | null;
  turnId: string | null;
}

export interface TranscriptTurnEntry {
  kind: "turn";
  key: string;
  position: number;
  turnId: string | null;
  state: "completed" | "failed" | "interrupted" | "cancelled";
  detail: string;
}

export interface TranscriptDiagnosticEntry {
  kind: "diagnostic";
  key: string;
  position: number;
  message: string;
  code: string | null;
}

export type TranscriptEntry =
  | TranscriptItemEntry
  | TranscriptUserEntry
  | TranscriptRequestEntry
  | TranscriptTurnEntry
  | TranscriptDiagnosticEntry;

const TOOL_KINDS = new Set([
  "commandExecution",
  "command_execution",
  "fileChange",
  "file_change",
  "mcpToolCall",
  "tool",
  "webSearch",
  "patchApply",
  "plan",
  "planUpdate",
  "update_plan",
]);

const ASSISTANT_KINDS = new Set(["agentMessage", "assistant", "assistantMessage", "message"]);

export function transcriptRole(kind: string): TranscriptRole {
  if (kind === "reasoning") return "reasoning";
  if (ASSISTANT_KINDS.has(kind)) return "assistant";
  if (TOOL_KINDS.has(kind)) return "tool";
  if (kind === "steering_acknowledgement") return "steering";
  if (kind === "interrupt_acknowledgement") return "interrupt";
  if (kind === "goal" || kind === "goal_cleared") return "goal";
  if (kind === "thread_lineage") return "lineage";
  return "system";
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function payloadText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface ItemFacts {
  interrupted: boolean;
  toolName: string | null;
  input: string | null;
  output: string | null;
  failure: string | null;
  terminal: boolean;
  debugEvents: TranscriptDebugEvent[];
}

function displayValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && value.length > 0) return value.map(String).join(" ");
  if (value !== null && typeof value === "object") return JSON.stringify(value, null, 2);
  return null;
}

function collectItemFacts(events: readonly PrpEvent[]): Map<string, ItemFacts> {
  const facts = new Map<string, ItemFacts>();
  for (const event of events) {
    if (event.itemId === undefined || !event.eventType.startsWith("item.")) continue;
    const payload = payloadRecord(event.payload);
    const current = facts.get(event.itemId) ?? {
      interrupted: false,
      toolName: null,
      input: null,
      output: null,
      failure: null,
      terminal: false,
      debugEvents: [],
    };
    const providerItem = payloadRecord(payload.item);
    const providerUpdate = payloadRecord(payload.update);
    if (payload.interrupted === true || payload.status === "interrupted") {
      current.interrupted = true;
    }
    current.toolName = payloadText(payload.toolName)
      ?? displayValue(providerItem.command)
      ?? payloadText(providerItem.name)
      ?? current.toolName;
    current.input = payloadText(payload.input)
      ?? displayValue(providerItem.command)
      ?? displayValue(providerItem.arguments)
      ?? current.input;
    current.output = payloadText(payload.output)
      ?? payloadText(providerItem.aggregatedOutput)
      ?? payloadText(providerUpdate.output)
      ?? current.output;
    if (event.eventType === "item.failed") {
      current.failure = payloadText(payload.message) ?? "The item failed.";
    }
    if (event.eventType === "item.completed" || event.eventType === "item.failed") {
      current.terminal = true;
    }
    current.debugEvents.push({
      source: typeof event.source === "string" ? event.source : "unknown",
      sourceSeq: event.sourceSeq,
      sourceEventId: event.sourceEventId,
      eventType: event.eventType,
      emittedAt: event.emittedAt,
      turnId: event.turnId ?? null,
      itemId: event.itemId ?? null,
      payload: event.payload,
    });
    facts.set(event.itemId, current);
  }
  return facts;
}

/**
 * Builds the submit body a request kind actually accepts. Elicitation answers
 * travel as `content` and user-input answers as `answers`; the runner validates
 * both against the request kind, so sending the wrong one fails closed rather
 * than resolving the request with an empty response.
 */
export function runtimeRequestSubmission(
  requestKind: string,
  answer: string,
): Record<string, unknown> {
  if (requestKind === "elicitation") {
    return { action: "submit", content: { answer } };
  }
  return { action: "submit", answers: { answer: { answers: [answer] } } };
}

function requestActions(details: unknown): string[] {
  const record = payloadRecord(details);
  return Array.isArray(record.actions)
    ? record.actions.filter((action): action is string => typeof action === "string")
    : [];
}

/**
 * Builds the ordered transcript. Order comes from the reducer timeline, which
 * is authoritative; nothing is re-sorted client-side.
 */
export function buildTranscript(
  snapshot: SessionSnapshot,
  events: readonly PrpEvent[],
): TranscriptEntry[] {
  const facts = collectItemFacts(events);
  const items = new Map(snapshot.items.map((item) => [item.itemId, item]));
  const seenItems = new Set<string>();
  const entries: TranscriptEntry[] = [];
  const eventsById = new Map(events.map((event) => [event.sourceEventId, event]));

  for (const timelineEntry of snapshot.timeline) {
    const event = eventsById.get(timelineEntry.sourceEventId);
    const payload = payloadRecord(event?.payload);
    const position = timelineEntry.position;

    if (timelineEntry.eventType === "turn.submitted") {
      entries.push({
        kind: "user",
        key: `user:${timelineEntry.sourceEventId}`,
        position,
        turnId: typeof payload.turnId === "string" ? payload.turnId : null,
        text: payloadText(payload.text) ?? "(no message text in the canonical event)",
      });
      continue;
    }

    if (
      ["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(
        timelineEntry.eventType,
      )
    ) {
      const state = timelineEntry.eventType.split(".").at(-1) as TranscriptTurnEntry["state"];
      entries.push({
        kind: "turn",
        key: `turn:${timelineEntry.sourceEventId}`,
        position,
        turnId: typeof payload.turnId === "string" ? payload.turnId : null,
        state,
        detail:
          payloadText(payload.message) ??
          payloadText(payload.reason) ??
          timelineEntry.summary,
      });
      continue;
    }

    if (timelineEntry.eventType === "runtime_request.created") {
      const request = payloadRecord(payload.request ?? payload);
      const requestId = typeof request.requestId === "string" ? request.requestId : "";
      const projected = snapshot.requests.find(
        (candidate) => candidate.requestId === requestId,
      );
      const resolution = events.find(
        (candidate) =>
          candidate.eventType.startsWith("runtime_request.") &&
          candidate.eventType !== "runtime_request.created" &&
          payloadRecord(candidate.payload).requestId === requestId,
      );
      entries.push({
        kind: "request",
        key: `request:${requestId}`,
        position,
        requestId,
        requestKind: typeof request.requestKind === "string" ? request.requestKind : "runtime",
        type: typeof request.type === "string" ? request.type : "runtime",
        prompt: payloadText(request.prompt) ?? "Runtime request",
        status: (projected?.status ?? "pending") as TranscriptRequestEntry["status"],
        actions: requestActions(request),
        details: payloadRecord(request.details),
        resolvedAction: payloadText(payloadRecord(resolution?.payload).action),
        resolvedAt: resolution?.emittedAt ?? null,
        turnId: typeof request.turnId === "string" ? request.turnId : null,
      });
      continue;
    }

    if (
      timelineEntry.eventType === "harness.diagnostic" ||
      timelineEntry.eventType === "runner.diagnostic"
    ) {
      entries.push({
        kind: "diagnostic",
        key: `diagnostic:${timelineEntry.sourceEventId}`,
        position,
        message: payloadText(payload.message) ?? timelineEntry.summary,
        code: payloadText(payload.code),
      });
      continue;
    }

    const itemId = timelineEntry.itemId;
    if (itemId === undefined || seenItems.has(itemId)) continue;
    const item = items.get(itemId);
    if (item === undefined) continue;
    seenItems.add(itemId);
    const itemFacts = facts.get(itemId);
    entries.push({
      kind: "item",
      key: `item:${itemId}`,
      position,
      role: transcriptRole(item.kind),
      item,
      interrupted: itemFacts?.interrupted ?? false,
      streaming: item.status === "running" && itemFacts?.terminal !== true,
      toolName: itemFacts?.toolName ?? null,
      input: itemFacts?.input ?? null,
      output: itemFacts?.output ?? null,
      failure: itemFacts?.failure ?? null,
      debugEvents: itemFacts?.debugEvents ?? [],
    });
  }

  return entries;
}

export type ComposerState =
  | "idle"
  | "submitting"
  | "active-turn"
  | "interrupting"
  | "disconnected"
  | "terminal";

export interface ComposerStateInput {
  connection: "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "terminal";
  submitting: boolean;
  interrupting: boolean;
  activeTurnId: string | null;
  sessionState: SessionSnapshot["sessionState"];
}

/** One state machine with exactly one visible primary action. */
export function composerState(input: ComposerStateInput): ComposerState {
  if (input.sessionState === "closed" || input.sessionState === "failed") return "terminal";
  if (input.connection === "disconnected" || input.connection === "reconnecting") {
    return "disconnected";
  }
  if (input.interrupting) return "interrupting";
  if (input.activeTurnId !== null) return "active-turn";
  if (input.submitting) return "submitting";
  return "idle";
}

export interface GoalOperationAvailability {
  operation: GoalOperation;
  enabled: boolean;
  reason: string | null;
}

const GOAL_UNSUPPORTED_FALLBACK =
  "Goal operations unsupported: this app-server does not advertise the goals capability";

/**
 * Capability gating for the goal menu. An unsupported verb is disabled with
 * the exact upstream diagnostic — never hidden and never emulated.
 */
export function goalAvailability(
  capabilities: RunnerCapabilities,
  goalStatus: string | null,
): GoalOperationAvailability[] {
  const unsupported = capabilities.unsupported ?? [];
  if (capabilities.goals !== true) {
    const reason = unsupported[0] ?? GOAL_UNSUPPORTED_FALLBACK;
    return (["set", "get", "pause", "resume", "clear"] as GoalOperation[]).map((operation) => ({
      operation,
      enabled: false,
      reason,
    }));
  }
  return (["set", "get", "pause", "resume", "clear"] as GoalOperation[]).map((operation) => {
    if (operation === "set") return { operation, enabled: true, reason: null };
    if (goalStatus === null) {
      return {
        operation,
        enabled: false,
        reason: "No goal is set on this thread yet.",
      };
    }
    if (operation === "pause" && goalStatus !== "active") {
      return { operation, enabled: false, reason: `The goal is already ${goalStatus}.` };
    }
    if (operation === "resume" && goalStatus === "active") {
      return { operation, enabled: false, reason: "The goal is already active." };
    }
    return { operation, enabled: true, reason: null };
  });
}

export interface CapabilityRow {
  name: string;
  supported: boolean;
  diagnostic: string | null;
}

export function capabilityRows(capabilities: RunnerCapabilities): CapabilityRow[] {
  const unsupported = capabilities.unsupported ?? [];
  const rows: Array<[string, boolean | undefined]> = [
    ["steer", capabilities.steering],
    ["interrupt", capabilities.interruption],
    ["resume", capabilities.resume],
    ["runtime requests", capabilities.runtimeRequestResolution],
    ["runtime request handoff", capabilities.runtimeRequestHandoff],
    ["goals", capabilities.goals],
    ["child threads", capabilities.threadLineage],
    ["structured result", capabilities.structuredResult],
    ["typed events", capabilities.typedEvents],
    ["usage", capabilities.usage],
  ];
  return rows.map(([name, supported]) => ({
    name,
    supported: supported === true,
    diagnostic:
      supported === true
        ? null
        : (unsupported.find((entry) => entry.toLowerCase().includes(name.split(" ")[0]!)) ??
          `${name} is not advertised by this app-server`),
  }));
}
