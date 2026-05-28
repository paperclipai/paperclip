import { describe, expect, it } from "vitest";
import { InMemoryConversationStore } from "../store.js";

describe("InMemoryConversationStore", () => {
  it("preserves platform recipient identity separately from paperclip identity", async () => {
    const store = new InMemoryConversationStore();

    const mapping = await store.create({
      platform: "telegram",
      platformUserId: "tg-user-123",
      platformConversationId: "tg-convo-456",
      threadId: null,
      paperclipIssueId: "issue-789",
      paperclipCompanyId: "company-abc",
      paperclipUserId: "paperclip-user-def",
    });

    expect(mapping.platformUserId).toBe("tg-user-123");
    expect(mapping.paperclipUserId).toBe("paperclip-user-def");

    const byIssue = await store.findByIssueId("issue-789");
    expect(byIssue?.platformUserId).toBe("tg-user-123");
    expect(byIssue?.paperclipUserId).toBe("paperclip-user-def");
  });
});
