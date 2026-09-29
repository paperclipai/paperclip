import { describe, expect, it } from "vitest";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { mergeRunEvents, nextRunEventCursor, retainRunEventTail, runEventPageHasMore } from "./run-event-pagination";

function event(
  id: number | string,
  seq: number,
  eventEpoch: string,
  cursor = `e:${eventEpoch}:${seq}`,
): HeartbeatRunEvent {
  return {
    id, companyId: "company", runId: "run", agentId: "agent", seq,
    eventEpoch, cursor, eventType: "test", stream: null, level: null,
    color: null, message: null, payload: null, createdAt: new Date(0),
  };
}

describe("run event pagination", () => {
  it("keeps repeated epoch-local sequences in server arrival order", () => {
    const first = event("legacy-1", 1, "epoch-a");
    const rollover = event("event-b", 1, "epoch-b");
    const later = event("event-c", 2, "epoch-b");
    expect(mergeRunEvents([first], [rollover, later])).toEqual([first, rollover, later]);
  });

  it("deduplicates by stringified id or exact cursor without sorting the page", () => {
    const first = event(1, 7, "epoch-a");
    const duplicateId = event("1", 1, "epoch-b", "e:epoch-b:1");
    const duplicateCursor = event("other-id", 8, "epoch-a", first.cursor);
    const second = event("event-2", 1, "epoch-b");
    expect(mergeRunEvents([first], [duplicateId, duplicateCursor, second])).toEqual([first, second]);
  });

  it("advances with the opaque cursor and stops when the cursor repeats", () => {
    const current = "e:epoch-a:99";
    expect(nextRunEventCursor(current, [event("id", 1, "epoch-b")])).toBe("e:epoch-b:1");
    expect(nextRunEventCursor(current, [event("id", 99, "epoch-a", current)])).toBe(current);
    expect(nextRunEventCursor(0, [event("id", 4, "epoch-a", "")])).toBe("");
    expect(nextRunEventCursor(0, [{ ...event("legacy", 4, "legacy"), cursor: undefined }])).toBe(4);
  });

  it("uses the last-row byte-budget marker when deciding whether to load another page", () => {
    expect(runEventPageHasMore([{ historyAfter: true }], 1_000)).toBe(true);
    expect(runEventPageHasMore([{ historyAfter: false }], 1)).toBe(false);
    expect(runEventPageHasMore([{}], 1_000)).toBe(false);
    expect(runEventPageHasMore([{}, {}], 2)).toBe(true);
  });

  it("bounds retained events by serialized bytes and reports omitted history", () => {
    const events = [1, 2, 3].map((id) => ({
      ...event(`event-${id}`, id, "epoch"),
      payload: { body: "x".repeat(800_000) },
    }));
    const retained = retainRunEventTail(events);
    expect(retained.collapsed).toBe(true);
    expect(retained.events.map((row) => row.id)).toEqual(["event-2", "event-3"]);
  });
});
