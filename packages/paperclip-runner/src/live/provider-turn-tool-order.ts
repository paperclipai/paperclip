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
