import { describe, expect, it } from "vitest";

import type { PrpEvent } from "../../../../src/protocol/replay-contract";
import {
  acceptLiveEvent,
  createLiveEventCursor,
} from "./use-live-console";

function event(sourceEventId: string): PrpEvent {
  return { sourceEventId } as PrpEvent;
}

describe("Live console reconnect cursor", () => {
  it("does not advance past an unseen event when replay delivers a duplicate", () => {
    const first = event("source:event-1");
    const second = event("source:event-2");
    const cursor = createLiveEventCursor([first], 1);

    expect(acceptLiveEvent(cursor, first)).toBe(false);
    expect(cursor.cursor).toBe(1);

    expect(acceptLiveEvent(cursor, second)).toBe(true);
    expect(cursor.cursor).toBe(2);
  });
});
