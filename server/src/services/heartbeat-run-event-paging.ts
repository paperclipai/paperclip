export const HEARTBEAT_RUN_EVENT_PAGE_MAX_JSON_BYTES = 2 * 1024 * 1024;

export type HeartbeatRunEventPageDirection = "forward" | "tail";

/**
 * Applies the response-size bound after the route's redaction passes. The
 * caller supplies at most limit + 1 ordered rows and the existence of rows on
 * either side of the page. Forward pages keep their oldest prefix; tail pages
 * keep their newest suffix so the returned cursor can continue without gaps.
 */
export function boundHeartbeatRunEventPage<T extends { seq: number }>(input: {
  events: T[];
  limit: number;
  direction: HeartbeatRunEventPageDirection;
  hasMoreBefore?: boolean;
  hasMoreAfter?: boolean;
  maxJsonBytes?: number;
}): Array<T & { historyBefore?: boolean; historyAfter?: boolean }> {
  const maxJsonBytes = input.maxJsonBytes ?? HEARTBEAT_RUN_EVENT_PAGE_MAX_JSON_BYTES;
  const limit = Math.max(1, Math.min(1000, Math.floor(input.limit)));
  const candidates = input.direction === "tail"
    ? input.events.slice(-limit)
    : input.events.slice(0, limit);
  const hasLimitOverflow = input.events.length > limit;
  const baseBefore = Boolean(input.hasMoreBefore) || (input.direction === "tail" && hasLimitOverflow);
  const baseAfter = Boolean(input.hasMoreAfter) || (input.direction === "forward" && hasLimitOverflow);
  const ordered = input.direction === "tail" ? [...candidates].reverse() : candidates;
  const encoder = new TextEncoder();
  const picked: T[] = [];

  const serializeWithMarkers = (events: T[], byteCut: boolean) => {
    const before = baseBefore || (byteCut && input.direction === "tail");
    const after = baseAfter || (byteCut && input.direction === "forward");
    return events.map((event, index) => ({
      ...event,
      ...(index === 0 ? { historyBefore: before } : {}),
      ...(index === events.length - 1 ? { historyAfter: after } : {}),
    }));
  };

  // Reserve room for cursor markers and JSON punctuation. This avoids
  // repeatedly serializing a growing prefix while staying within the
  // approximate response-size budget.
  let estimatedBytes = 64;
  for (const event of ordered) {
    const eventBytes = encoder.encode(JSON.stringify(event)).byteLength;
    const proposalBytes = estimatedBytes + eventBytes + (picked.length > 0 ? 1 : 2);
    if (picked.length > 0 && proposalBytes > maxJsonBytes) break;
    // Always return at least one record, even when a single payload is larger
    // than the approximate response budget.
    picked.push(event);
    estimatedBytes = proposalBytes;
    if (proposalBytes > maxJsonBytes) break;
  }

  const byteCut = picked.length < candidates.length;
  const selected = input.direction === "tail" ? [...picked].reverse() : picked;
  return serializeWithMarkers(selected, byteCut);
}
