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
 * - the first userMessage item of a turn is that turn's own input. It reads
 *   every steer from earlier turns: the restart continuation carries them;
 * - every later userMessage item in the turn is one steered input entering
 *   the conversation. It reads the oldest unread steer of that turn. The
 *   provider can report it before the acknowledgement event, so a read with
 *   no unread steer waits for the next acknowledgement of that turn;
 * - turn.completed reads every steer so far: a provider drains pending input
 *   before it completes a turn.
 */
export function unreadSteeredMessageIds(events: Iterable<SteeringDeliveryEvent>): string[] {
  const unread: Array<{ id: string; turnId: string | null }> = [];
  const seen = new Set<string>();
  const inputs = new Map<string | null, number>();
  const earlyReads = new Map<string | null, number>();
  for (const event of events) {
    const turnId = event.turnId ?? null;
    if (event.eventType === "item.completed" && event.kind === "steering_acknowledgement") {
      const id = STEER_ITEM.exec(event.itemId ?? "")?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const early = earlyReads.get(turnId) ?? 0;
      if (early > 0) earlyReads.set(turnId, early - 1);
      else unread.push({ id, turnId });
    } else if (event.eventType === "item.started" && event.kind === "userMessage") {
      const count = (inputs.get(turnId) ?? 0) + 1;
      inputs.set(turnId, count);
      if (count === 1) {
        for (let index = unread.length - 1; index >= 0; index -= 1)
          if (unread[index]!.turnId !== turnId) unread.splice(index, 1);
        continue;
      }
      const index = unread.findIndex((entry) => entry.turnId === turnId);
      if (index >= 0) unread.splice(index, 1);
      else earlyReads.set(turnId, (earlyReads.get(turnId) ?? 0) + 1);
    } else if (event.eventType === "turn.completed") {
      unread.length = 0;
    }
  }
  return unread.map((entry) => entry.id);
}
