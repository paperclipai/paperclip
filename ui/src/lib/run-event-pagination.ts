import type { HeartbeatRunEvent } from "@paperclipai/shared";

export type RunEventCursor = number | string;
export const MAX_RETAINED_RUN_EVENT_COUNT = 2_000;
export const MAX_RETAINED_RUN_EVENT_BYTES = 2 * 1024 * 1024;

/** The last row may indicate that a byte budget shortened an otherwise full page. */
export function runEventPageHasMore(
  page: readonly { historyAfter?: boolean }[],
  pageSize: number,
): boolean {
  const last = page.at(-1);
  return last?.historyAfter ?? page.length >= pageSize;
}

export function retainRunEventTail(events: HeartbeatRunEvent[]) {
  let start = Math.max(0, events.length - MAX_RETAINED_RUN_EVENT_COUNT);
  let bytes = events.slice(start).reduce((total, event) => total + JSON.stringify(event).length, 0);
  while (start < events.length - 1 && bytes > MAX_RETAINED_RUN_EVENT_BYTES) {
    bytes -= JSON.stringify(events[start]!).length;
    start += 1;
  }
  return { events: start ? events.slice(start) : events, collapsed: start > 0 };
}

/** Advance with the exact server cursor, falling back to the legacy local seq. */
export function nextRunEventCursor(
  current: RunEventCursor,
  page: readonly HeartbeatRunEvent[],
): RunEventCursor {
  const last = page.at(-1);
  if (!last) return current;
  const next = last.cursor ?? last.seq;
  return next === current ? current : next;
}

/** Merge in arrival order; seq is epoch-local and is never an identity. */
export function mergeRunEvents(
  previous: HeartbeatRunEvent[],
  incoming: readonly HeartbeatRunEvent[],
  limit = Number.POSITIVE_INFINITY,
): HeartbeatRunEvent[] {
  if (incoming.length === 0) return previous as HeartbeatRunEvent[];
  const ids = new Set(previous.map((event) => String(event.id)));
  const cursors = new Set(previous.flatMap((event) => event.cursor ? [event.cursor] : []));
  const next = [...previous];
  let added = false;
  for (const event of incoming) {
    const id = String(event.id);
    if (ids.has(id) || (event.cursor !== undefined && cursors.has(event.cursor))) continue;
    ids.add(id);
    if (event.cursor !== undefined) cursors.add(event.cursor);
    next.push(event);
    added = true;
  }
  if (!added) return previous;
  return next.length > limit ? next.slice(next.length - limit) : next;
}
