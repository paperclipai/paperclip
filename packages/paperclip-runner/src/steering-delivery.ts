/** One durable run-log event, in persisted sequence order. */
export interface SteeringDeliveryEvent {
  eventType: string;
  turnId?: string | null;
  itemId?: string | null;
  kind?: string | null;
}

const STEER_ITEM = /:steer:(.+)$/;

/**
 * Steering messages a provider acknowledged but the model never read, oldest
 * first. A restart kills an in-flight turn before its next model step, and the
 * provider forgets acknowledged input it never recorded, so recovery must
 * deliver these again. The acknowledgement item id ends in `:steer:<id>`,
 * where `<id>` is the steered comment or interaction id; each id counts once.
 *
 * Read evidence, in run-log order:
 * - a userMessage item started in the acknowledged turn reads the oldest
 *   unread steer of that turn: the provider records each accepted steering
 *   input as one userMessage item when it enters the conversation;
 * - a userMessage item started in a later turn reads every steer from earlier
 *   turns: the restart continuation carries them as its input;
 * - turn.completed reads every steer so far: a provider drains pending input
 *   before it completes a turn.
 */
export function unreadSteeredMessageIds(events: Iterable<SteeringDeliveryEvent>): string[] {
  const unread: Array<{ id: string; turnId: string | null }> = [];
  const seen = new Set<string>();
  for (const event of events) {
    const turnId = event.turnId ?? null;
    if (event.eventType === "item.completed" && event.kind === "steering_acknowledgement") {
      const id = STEER_ITEM.exec(event.itemId ?? "")?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      unread.push({ id, turnId });
    } else if (event.eventType === "item.started" && event.kind === "userMessage") {
      const earlier = unread.filter((entry) => entry.turnId !== turnId);
      if (earlier.length > 0) {
        for (const entry of earlier) unread.splice(unread.indexOf(entry), 1);
      } else if (unread.length > 0) {
        unread.shift();
      }
    } else if (event.eventType === "turn.completed") {
      unread.length = 0;
    }
  }
  return unread.map((entry) => entry.id);
}
