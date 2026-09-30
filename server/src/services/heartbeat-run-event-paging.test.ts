import { describe, expect, it } from "vitest";
import { boundHeartbeatRunEventPage } from "./heartbeat-run-event-paging.js";

const event = (seq: number, payload: string) => ({ seq, payload });

describe("bounded heartbeat run event pages", () => {
  it("keeps the newest suffix in tail mode and exposes continuous cursors", () => {
    const page = boundHeartbeatRunEventPage({
      events: [event(1, "a"), event(2, "b"), event(3, "c")],
      direction: "tail",
      limit: 2,
      hasMoreBefore: false,
    });
    expect(page.map((row) => row.seq)).toEqual([2, 3]);
    expect(page[0].historyBefore).toBe(true);
    expect(page[1].historyAfter).toBe(false);
  });

  it("keeps the forward prefix when the JSON byte bound cuts a page", () => {
    const page = boundHeartbeatRunEventPage({
      events: [event(1, "a"), event(2, "b"), event(3, "c")],
      direction: "forward",
      limit: 3,
      maxJsonBytes: 45,
    });
    expect(page.map((row) => row.seq)).toEqual([1]);
    expect(page[0].historyAfter).toBe(true);
  });

  it("keeps the tail suffix when the JSON byte bound cuts a page", () => {
    const page = boundHeartbeatRunEventPage({
      events: [event(1, "a"), event(2, "b"), event(3, "c")],
      direction: "tail",
      limit: 3,
      maxJsonBytes: 45,
    });
    expect(page.map((row) => row.seq)).toEqual([3]);
    expect(page[0].historyBefore).toBe(true);
    expect(page[0].historyAfter).toBe(false);
  });

  it("returns one event even when that record alone exceeds the budget", () => {
    const page = boundHeartbeatRunEventPage({
      events: [event(1, "oversized".repeat(30))],
      direction: "forward",
      limit: 10,
      maxJsonBytes: 10,
    });
    expect(page).toHaveLength(1);
    expect(page[0].seq).toBe(1);
    expect(page[0].historyBefore).toBe(false);
    expect(page[0].historyAfter).toBe(false);
  });
});
