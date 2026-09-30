import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { mergeRunEvents, retainEventTail, runEventPageHasMore } from "./run-event-pagination";
const row = (seq: number, message = ""): HeartbeatRunEvent => ({ seq, message } as HeartbeatRunEvent);

describe("retained run event window", () => {
  it("keeps a contiguous recent tail by count without mutating its input", () => {
    const events = Array.from({ length: 10_000 }, (_, index) => row(index + 1));
    const result = retainEventTail(events);
    expect(result.events).toHaveLength(1_000);
    expect(result.events[0].seq).toBe(9_001);
    expect(result.events.at(-1)?.seq).toBe(10_000);
    expect(result.collapsed).toBe(true);
    expect(events).toHaveLength(10_000);
  });
  it("bounds UTF-8 bytes and keeps an individually oversized final event intact", () => {
    const events = Array.from({ length: 10 }, (_, index) => row(index, "界".repeat(100_000)));
    const result = retainEventTail(events);
    expect(result.events).toHaveLength(6);
    expect(result.events[0].seq).toBe(4);
    const final = row(11, "x".repeat(3 * 1024 * 1024));
    expect(retainEventTail([...events, final]).events).toEqual([final]);
  });
  it("does not resurrect overlapping events and respects an explicit end marker", () => {
    expect(mergeRunEvents([row(1), row(2)], [row(2), row(3), row(3)]).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(runEventPageHasMore([{ ...row(1), historyAfter: false }], 1)).toBe(false);
    expect(runEventPageHasMore([{ ...row(1), historyAfter: true }], 1_000)).toBe(true);
  });
});
