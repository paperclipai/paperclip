import { describe, expect, it } from "vitest";

import type { PrpEvent } from "../protocol/replay-contract.js";
import {
  acceptRunnerStreamEvent,
  createRunnerStreamCursor,
  takeFreshStreamEvents,
} from "./use-runner-console.js";

function event(sourceEventId: string): PrpEvent {
  return { sourceEventId } as PrpEvent;
}

describe("runner console reconnect", () => {
  it("drops a socket event from a stale generation and does not advance the cursor", () => {
    const cursor = createRunnerStreamCursor();
    const first = event("source-1");

    expect(acceptRunnerStreamEvent(cursor, first, 2, 1)).toBe(false);
    expect(cursor.cursor).toBe(0);
    expect(cursor.seenSourceEventIds.size).toBe(0);

    expect(acceptRunnerStreamEvent(cursor, first, 2, 2)).toBe(true);
    expect(acceptRunnerStreamEvent(cursor, first, 2, 2)).toBe(true);
    expect(cursor.cursor).toBe(2);
    expect(cursor.seenSourceEventIds.size).toBe(1);
  });

  it("forgets source ids outside the retained ring", () => {
    const cursor = createRunnerStreamCursor();
    for (let index = 0; index < 4096; index += 1) {
      expect(acceptRunnerStreamEvent(cursor, event(`source-${index}`), 1, 1)).toBe(true);
    }
    expect(cursor.seenSourceEventIds.has("source-0")).toBe(true);
    expect(acceptRunnerStreamEvent(cursor, event("source-4096"), 1, 1)).toBe(true);
    expect(cursor.seenSourceEventIds.has("source-0")).toBe(false);
    expect(cursor.seenSourceEventIds.size).toBe(4096);
  });

  it("keeps the server cursor when a replay page repeats events the socket already accepted", () => {
    const cursor = createRunnerStreamCursor([event("source-1")], 1);
    const fresh = takeFreshStreamEvents(
      cursor,
      [event("source-1"), event("source-2")],
      4097,
      3,
      3,
    );

    expect(fresh.map((entry) => entry.sourceEventId)).toEqual(["source-2"]);
    expect(cursor.cursor).toBe(4097);

    const duplicatePage = takeFreshStreamEvents(
      createRunnerStreamCursor(),
      [event("source-9"), event("source-9")],
      2,
      1,
      1,
    );
    expect(duplicatePage.map((entry) => entry.sourceEventId)).toEqual(["source-9", "source-9"]);
    expect(takeFreshStreamEvents(cursor, [event("source-2")], 4097, 4, 3)).toEqual([]);
    expect(cursor.cursor).toBe(4097);
  });
});
