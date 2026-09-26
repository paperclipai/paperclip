import { describe, expect, it } from "vitest";
import { isConversationAdapter } from "./conversation-continuation.js";

describe("isConversationAdapter", () => {
  it("treats devin_local as a conversation adapter", () => {
    expect(isConversationAdapter("devin_local")).toBe(true);
  });

  it("does not treat process as a conversation adapter", () => {
    expect(isConversationAdapter("process")).toBe(false);
  });
});
