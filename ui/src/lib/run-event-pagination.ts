import type { HeartbeatRunEvent } from "@paperclipai/shared";

export type RunEventCursor = number | "tail";
export const MAX_RETAINED_RUN_EVENTS = 1_000;
export const MAX_RETAINED_RUN_EVENT_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

export function runEventPageHasMore(page: readonly HeartbeatRunEvent[], pageSize: number): boolean {
  return page.at(-1)?.historyAfter ?? page.length >= pageSize;
}

export function nextRunEventCursor(after: RunEventCursor, page: readonly HeartbeatRunEvent[]): RunEventCursor {
  const last = page.at(-1);
  return last ? (after === "tail" ? last.seq : Math.max(after, last.seq)) : after;
}

// Keep a contiguous recent window. A single large event is retained intact so
// its final answer, tool result, or pending question cannot silently disappear.
export function retainEventTail(events: HeartbeatRunEvent[]) {
  let start = events.length;
  let bytes = 0;
  while (start > 0 && events.length - start < MAX_RETAINED_RUN_EVENTS) {
    const size = encoder.encode(JSON.stringify(events[start - 1])).byteLength;
    if (start < events.length && bytes + size > MAX_RETAINED_RUN_EVENT_BYTES) break;
    bytes += size;
    start -= 1;
  }
  return { events: start ? events.slice(start) : events, collapsed: start > 0 };
}

export function mergeRunEvents(previous: HeartbeatRunEvent[], incoming: HeartbeatRunEvent[]) {
  const seen = new Set(previous.map((event) => event.seq));
  return [...previous, ...incoming.filter((event) => {
    if (seen.has(event.seq)) return false;
    seen.add(event.seq);
    return true;
  })];
}
