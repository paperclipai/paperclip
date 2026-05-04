import { describe, expect, it } from "vitest";
import { PLACEHOLDER_COMMENT_PREFIXES, isPlaceholderCommentBody, stripMarkdown } from "../placeholder.js";

describe("placeholder comments", () => {
  it("ships the approved v2 prefix list", () => {
    expect(PLACEHOLDER_COMMENT_PREFIXES).toEqual([
      "acknowledg",
      "working on",
      "continuing",
      "stale",
      "pure self-comment",
      "heartbeat handled",
    ]);
  });

  it.each([
    "Ack",
    "Acknowledged, continuing.",
    "Working on the next step after this wake.",
    "Continuing with the planned route guard update.",
    "Stale wake with no new information.",
    "Pure self-comment to keep the issue warm.",
    "Heartbeat handled, no external context changed.",
    "There is no external context change since the previous wake.",
    "PR #4977 merged.",
    "**Ack**",
  ])("matches v2 placeholder body %j", (body) => {
    expect(isPlaceholderCommentBody(body)).toBe(true);
  });

  it.each([
    null,
    undefined,
    "Done: implemented the placeholder detector and verified the route guard.",
    "Parked. Investigating M2 dashboard outage with root-cause notes attached.",
    "Blocked by ELEAAA-457: waiting for CTO review on the upstream dependency.",
    "Done: implemented the placeholder detector.",
    "A real update with enough detail about tests, files changed, and remaining risk.",
    "Self-wake: implemented rate-limiting for ELEAAA-462 and verified all edge cases.",
  ])("rejects non-placeholder body %j", (body) => {
    expect(isPlaceholderCommentBody(body)).toBe(false);
  });

  it("strips markdown before applying the length threshold", () => {
    expect(stripMarkdown("**Ack**")).toBe("Ack");
    expect(stripMarkdown("[real update](https://example.com)")).toBe("real update");
    expect(isPlaceholderCommentBody("**Detailed implementation note with real verification context.**")).toBe(false);
  });
});
