import type { PrpEvent } from "../protocol/replay-contract.js";

export interface ResolvableSteeringChip {
  expectedTurnId: string;
  status: "pending" | "acknowledged" | "rejected" | "failed";
  detail: string | null;
  /** Item id, or source event id, of the acknowledgement already bound to this chip. */
  acknowledgementKey?: string;
  /**
   * Acknowledgements at or before this source sequence were already in the log
   * when the chip was created. They belong to an earlier steer, including one
   * whose chip was not restored with the session.
   */
  afterSourceSeq?: number;
}

export function steeringAcknowledgementKey(event: Pick<PrpEvent, "itemId" | "sourceEventId">): string {
  return event.itemId ?? event.sourceEventId;
}

export function isSteeringAcknowledgement(event: PrpEvent): boolean {
  return (
    event.eventType === "item.completed" &&
    (event.payload as { kind?: string }).kind === "steering_acknowledgement"
  );
}

export function latestSteeringSourceSeq(events: readonly Pick<PrpEvent, "sourceSeq">[]): number {
  let latest = 0;
  for (const event of events) {
    if (event.sourceSeq !== undefined && event.sourceSeq > latest) latest = event.sourceSeq;
  }
  return latest;
}

function acknowledgementMatches(
  event: PrpEvent,
  chip: ResolvableSteeringChip,
  consumed: ReadonlySet<string>,
): boolean {
  const key = steeringAcknowledgementKey(event);
  if (consumed.has(key)) return false;
  if (event.turnId !== undefined && event.turnId !== chip.expectedTurnId) return false;
  if (chip.afterSourceSeq !== undefined && (event.sourceSeq ?? 0) <= chip.afterSourceSeq) return false;
  return true;
}

/**
 * Pair each pending chip with an acknowledgement for its own turn.
 * An acknowledgement already bound to an earlier chip is not reused, so a
 * chip that has already resolved cannot shift the next pending steer onto it.
 */
export function resolveSteeringChips<T extends ResolvableSteeringChip>(
  chips: readonly T[],
  events: readonly PrpEvent[],
): T[] {
  const needsPass = chips.some(
    (chip) =>
      chip.status === "pending" ||
      (chip.status === "acknowledged" && chip.acknowledgementKey === undefined),
  );
  if (!needsPass) return chips as T[];

  const acknowledged = events.filter(isSteeringAcknowledgement);
  const consumed = new Set<string>();
  let changed = false;

  const reserved = chips.map((chip) => {
    if (chip.acknowledgementKey !== undefined) {
      consumed.add(chip.acknowledgementKey);
      return chip;
    }
    if (chip.status !== "acknowledged") return chip;
    const match = acknowledged.find((event) => acknowledgementMatches(event, chip, consumed));
    if (match === undefined) return chip;
    const key = steeringAcknowledgementKey(match);
    consumed.add(key);
    changed = true;
    return { ...chip, acknowledgementKey: key };
  });

  const resolved = reserved.map((chip) => {
    if (chip.status !== "pending") return chip;
    const match = acknowledged.find((event) => acknowledgementMatches(event, chip, consumed));
    if (match === undefined) return chip;
    const key = steeringAcknowledgementKey(match);
    consumed.add(key);
    changed = true;
    return {
      ...chip,
      status: "acknowledged" as const,
      detail: null,
      acknowledgementKey: key,
    };
  });

  return changed ? resolved : (chips as T[]);
}
