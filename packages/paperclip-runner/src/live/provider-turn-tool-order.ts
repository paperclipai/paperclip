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

const terminalEventTypes = new Set(["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"]);

export function providerTurnStartBefore(
  events: readonly Pick<DurableRecoveryCommittedEvent, "sourceSeq" | "eventType" | "envelope">[],
  sourceSeq: number,
): { turnId: string; payload: Record<string, unknown> } | null {
  let expected = sourceSeq - 1;
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at]!;
    if (event.sourceSeq >= sourceSeq) continue;
    if (event.sourceSeq !== expected-- || terminalEventTypes.has(event.eventType)) return null;
    if (event.eventType !== "turn.started") continue;
    const payload = record(record(event.envelope.payload).payload);
    return payload.origin === "provider" && typeof payload.providerTurnId === "string" && payload.providerTurnId.length > 0
      ? { turnId: payload.providerTurnId, payload } : null;
  }
  return null;
}
