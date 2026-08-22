import { describe, expect, it } from "vitest";

import { classifyRisk, isGmailToolPermanentlyBlocked } from "./tool-access.js";

describe("Gmail tool governance", () => {
  it("allows reviewed reads and draft creation while keeping delivery and destructive actions blocked", () => {
    expect(isGmailToolPermanentlyBlocked({ name: "search_threads" })).toBe(false);
    expect(isGmailToolPermanentlyBlocked({ name: "get_message" })).toBe(false);
    expect(classifyRisk({ name: "create_draft" }, "gmail")).toBe("write");
    expect(isGmailToolPermanentlyBlocked({ name: "create_draft" })).toBe(false);

    expect(isGmailToolPermanentlyBlocked({ name: "send_message" })).toBe(true);
    expect(isGmailToolPermanentlyBlocked({ name: "trash_thread" })).toBe(true);
    expect(isGmailToolPermanentlyBlocked({ name: "mark_as_spam" })).toBe(true);
    expect(isGmailToolPermanentlyBlocked({ name: "update_labels" })).toBe(true);
  });
});
