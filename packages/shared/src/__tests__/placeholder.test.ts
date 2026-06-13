import { describe, expect, it } from "vitest";
import { DEFAULT_PLACEHOLDER_PATTERNS, isPlaceholderCommentBody } from "../placeholder.js";

describe("placeholder comments", () => {
  it("ships the approved 9-pattern default set", () => {
    expect(DEFAULT_PLACEHOLDER_PATTERNS).toHaveLength(9);
  });

  it.each([
    "Parked",
    "parked.",
    "  Parking  ",
    "Silent",
    "Silent.",
    "Silent exit",
    "silent exit.",
    "Self-wake waiting for review",
    "selfwake loop",
    "Done for this heartbeat",
    "Noop.",
    "Blocked",
    ".",
    "..",
    "...",
    "Heartbeat over",
    "Continuing.",
    "Working",
    "Idle",
    "Polling.",
  ])("matches default placeholder body %j", (body) => {
    expect(isPlaceholderCommentBody(body)).toBe(true);
  });

  it.each([
    "",
    "   ",
    null,
    undefined,
    "Done: implemented the placeholder detector.",
    "Parked. Investigating M2 dashboard outage.",
    "Blocked by ELEAAA-457: waiting for CTO review.",
    "Working on the failing test now.",
    "Parking lot update: route guard still needs a child issue.",
    "No operation performed because the API was unavailable.",
    "Continuing with implementation after reading the plan.",
    "Polling Paperclip would be wrong here, so I am exiting.",
    "Self-wake: implemented rate-limiting for ELEAAA-462 and verified all edge cases.",
    "Self-wake — actually pausing because the Redis pool is exhausted; investigating now",
    "....",
  ])("rejects non-placeholder body %j", (body) => {
    expect(isPlaceholderCommentBody(body)).toBe(false);
  });

  it("accepts an explicit regex set override", () => {
    expect(isPlaceholderCommentBody("ship it", [/^ship it$/i])).toBe(true);
    expect(isPlaceholderCommentBody("ship it")).toBe(false);
  });
});
