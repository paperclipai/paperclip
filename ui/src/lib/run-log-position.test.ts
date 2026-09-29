import { expect, it } from "vitest";
import { nextRunLogPosition, runLogHasMore } from "./run-log-position";

it("preserves an exact large cursor and knows a caught-up cursor is not another page", () => {
  expect(nextRunLogPosition("9007199254740992", { content: "🐙", cursor: "9007199254740996", hasMore: false })).toBe("9007199254740996");
  expect(runLogHasMore({ content: "", cursor: "9007199254740996", hasMore: false })).toBe(false);
  expect(runLogHasMore({ content: "x", cursor: "9007199254740996", hasMore: true })).toBe(true);
});
it("counts UTF-8 bytes only when an old server omits its cursor", () => {
  expect(nextRunLogPosition(4, { content: "🐙" })).toBe(8);
  expect(nextRunLogPosition(4, { content: "🐙", nextOffset: 10 })).toBe(10);
});
