import type { DurableRecoveryCommittedEvent } from "../control-plane/prp-transport-types.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function providerTurnToolCallSourceSeq(
  events: readonly Pick<DurableRecoveryCommittedEvent, "sourceSeq" | "sourceEventId" | "eventType" | "envelope">[],
  sourceEventId: string,
): number | null {
  const index = events.findIndex(event => event.sourceEventId === sourceEventId);
  for (let at = index - 1; at >= 0; at -= 1) {
    if (events[at]!.eventType !== "turn.started") continue;
    return record(record(events[at]!.envelope.payload).payload).origin === "provider" ? events[index]!.sourceSeq : null;
  }
  return null;
}

const eventPayload = (event: Pick<DurableRecoveryCommittedEvent, "envelope">) => record(record(event.envelope.payload).payload);

const terminalEventTypes = new Set(["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"]);

export function providerTurnStartBefore(
  events: readonly Pick<DurableRecoveryCommittedEvent, "sourceSeq" | "eventType" | "envelope">[],
  sourceSeq: number,
): { turnId: string; payload: Record<string, unknown> } | null {
  const startAt = events.findLastIndex(event => event.sourceSeq < sourceSeq && event.eventType === "turn.started");
  if (startAt < 0) return null;
  const payload = eventPayload(events[startAt]!);
  const turnId = payload.providerTurnId;
  if (payload.origin !== "provider" || typeof turnId !== "string" || turnId.length === 0) return null;
  const terminal = events.slice(startAt + 1).find(event => terminalEventTypes.has(event.eventType));
  if (terminal && (terminal.sourceSeq < sourceSeq || eventPayload(terminal).providerTurnId !== turnId)) return null;
  return { turnId, payload };
}
