import { describe, expect, it } from "vitest";
import { holdsPublishedResponse } from "./chat-github-response-comments.js";

const markers = "\n\n<!-- paperclip-pr-response:a -->\n<!-- paperclip-response:b -->\n<!-- paperclip-response-version:2026-11-23T00:00:00.000Z -->";
const final = "\n<!-- paperclip-response-state:final -->";

describe("holdsPublishedResponse", () => {
  it("protects a final review, even one that starts with a status sentence", () => {
    expect(holdsPublishedResponse(`## Review — 4/5\n\nLooks good.${markers}${final}`)).toBe(true);
    expect(holdsPublishedResponse(`This turn ended without publishing a final response. The fix landed later.${markers}${final}`)).toBe(true);
  });
  it("treats placeholders and status notices as replaceable", () => {
    expect(holdsPublishedResponse(`Working on this…${markers}`)).toBe(false);
    expect(holdsPublishedResponse(`Anything${markers}\n<!-- paperclip-response-kind:status -->${final}`)).toBe(false);
    expect(holdsPublishedResponse(`This turn ended without publishing a final response. See the Paperclip task for details.${markers}${final}`)).toBe(false);
    expect(holdsPublishedResponse(`Work is paused. Your request is saved. See the Paperclip task for details.${markers}`)).toBe(false);
  });
});
