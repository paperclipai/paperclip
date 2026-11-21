import { describe, expect, it } from "vitest";
import { boundLatestHistory, historyHitIsFresh, patchHistoryMessages, reconcileFetchedHistory, removeHistoryMessages } from "../src/history-slice.js";
import {
  issueRefFromPath,
  isNearBottom,
  mergeThreadMessages,
  oldestNumericId,
  sameThreadTop,
  shiftFeedRange,
  slideFeedRange,
  tailFeedRange,
} from "../src/ui/inbox-model.js";

describe("thread loading", () => {
  it("keeps older messages and appends new ones once", () => {
    const merged = mergeThreadMessages(
      [
        { id: "2", at: "2020-01-02T00:00:00.000Z" },
        { id: "3", at: "2020-01-03T00:00:00.000Z" },
      ],
      [
        { id: "1", at: "2020-01-01T00:00:00.000Z" },
        { id: "2", at: "2020-01-02T00:00:00.000Z" },
        { id: "4", at: "2020-01-04T00:00:00.000Z" },
      ],
    );
    expect(merged.map((message) => message.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("orders same-second messages by numeric telegram id", () => {
    const at = "2020-01-02T00:00:00.000Z";
    expect(mergeThreadMessages(
      [{ id: "100", at }],
      [{ id: "99", at }],
    ).map((message) => message.id)).toEqual(["99", "100"]);
    expect(patchHistoryMessages(
      [],
      [
        { id: "100", direction: "in", text: "later", at },
        { id: "99", direction: "in", text: "earlier", at },
      ],
    ).map((message) => message.id)).toEqual(["99", "100"]);
  });

  it("uses the oldest numeric message as the next page cursor", () => {
    expect(oldestNumericId([{ id: "10" }, { id: "2" }, { id: "note" }])).toBe("2");
    expect(oldestNumericId([{ id: "note" }])).toBeNull();
  });

  it("stays at the bottom only when the reader is already there", () => {
    expect(isNearBottom(100, 200, 80)).toBe(true);
    expect(isNearBottom(0, 500, 80)).toBe(false);
  });

  it("reads the open dialog from the host pathname", () => {
    expect(issueRefFromPath("BMC", "/BMC/telegram-inbox/AND-2")).toBe("AND-2");
    expect(issueRefFromPath("BMC", "/BMC/telegram-inbox")).toBe("");
    expect(issueRefFromPath("BMC", "/BMC/telegram-inbox/AND-2/extra")).toBe("AND-2");
  });

  it("keeps a cached feed when a poll has the same top message", () => {
    expect(sameThreadTop([{ id: "2" }, { id: "9" }], [{ id: "8" }, { id: "9" }])).toBe(true);
    expect(sameThreadTop([{ id: "9" }], [{ id: "10" }])).toBe(false);
    expect(sameThreadTop([], [{ id: "10" }])).toBe(false);
    expect(sameThreadTop(
      [{ id: "9", text: "old" }],
      [{ id: "9", text: "edited" }],
    )).toBe(false);
  });

  it("windows a long feed around the visible message and shifts it when older pages prepend", () => {
    expect(tailFeedRange(40)).toBeNull();
    expect(tailFeedRange(50)).toEqual({ start: 10, end: 50 });
    const stable = { start: 10, end: 50 };
    expect(slideFeedRange(80, 20, stable)).toBe(stable);
    expect(slideFeedRange(80, 12, { start: 10, end: 40 })).toEqual({ start: 4, end: 36 });
    expect(shiftFeedRange({ start: 0, end: 40 }, 40)).toEqual({ start: 0, end: 80 });
    expect(shiftFeedRange({ start: 10, end: 40 }, 40)).toEqual({ start: 50, end: 80 });
  });

  it("keeps the latest history slice and patches it in place", () => {
    expect(historyHitIsFresh("", 0, 60_000)).toBe(true);
    expect(historyHitIsFresh("20", 0, 59_000)).toBe(true);
    expect(historyHitIsFresh("20", 0, 60_000)).toBe(false);
    const patched = patchHistoryMessages(
      [{ id: "2", direction: "in", text: "old", at: "2020-01-02T00:00:00.000Z" }],
      [{ id: "2", direction: "in", text: "edited", at: "2020-01-02T00:00:00.000Z", forward: { name: "Анна" } }],
    );
    expect(patched).toEqual([
      { id: "2", direction: "in", text: "edited", at: "2020-01-02T00:00:00.000Z", forward: { name: "Анна" } },
    ]);
    expect(removeHistoryMessages(patched, ["2"])).toEqual([]);
  });

  it("drops cached ids below a fetched latest page and bounds the slice", () => {
    const bubble = (id: string, at: string) => ({ id, direction: "in" as const, text: id, at });
    const previous = [
      bubble("1", "2020-01-01T00:00:01.000Z"),
      bubble("40", "2020-01-01T00:00:02.000Z"),
      bubble("90", "2020-01-01T00:00:03.000Z"),
      bubble("note", "2020-01-01T00:00:04.000Z"),
    ];
    const fetched = [bubble("81", "2020-01-01T00:00:05.000Z"), bubble("82", "2020-01-01T00:00:06.000Z")];
    expect(reconcileFetchedHistory(previous, fetched).map((message) => message.id)).toEqual(["90", "note", "81", "82"]);
    expect(reconcileFetchedHistory(previous, [], [bubble("7", "2020-01-01T00:00:07.000Z")]).map((message) => message.id)).toEqual(["7"]);
    const long = Array.from({ length: 50 }, (_, index) => bubble(String(index + 1), `2020-01-01T00:01:${String(index).padStart(2, "0")}.000Z`));
    const bounded = boundLatestHistory(long);
    expect(bounded).toHaveLength(40);
    expect(bounded[0]?.id).toBe("11");
    expect(bounded.at(-1)?.id).toBe("50");
  });
});
