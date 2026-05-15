import { describe, expect, it } from "vitest";

import { createMobileChatStore } from "./chat-store.js";

describe("createMobileChatStore", () => {
  it("records outgoing user messages with deterministic timestamps", () => {
    const now = new Date("2026-05-16T00:00:00.000Z");
    const store = createMobileChatStore({ now: () => now });

    const message = store.createUserMessage("Check Her Workdesk status");

    expect(message).toEqual({
      id: "mobile-chat-1",
      role: "user",
      text: "Check Her Workdesk status",
      status: "sent",
      createdAt: "2026-05-16T00:00:00.000Z",
      replyToId: null,
      error: null,
    });
  });

  it("records assistant messages that reply to a user message", () => {
    const store = createMobileChatStore({
      now: () => new Date("2026-05-16T00:00:00.000Z"),
    });
    const userMessage = store.createUserMessage("What needs review?");

    const assistantMessage = store.createAssistantMessage(
      "Two issues need review.",
      userMessage.id,
    );

    expect(assistantMessage).toEqual({
      id: "mobile-chat-2",
      role: "assistant",
      text: "Two issues need review.",
      status: "sent",
      createdAt: "2026-05-16T00:00:00.000Z",
      replyToId: userMessage.id,
      error: null,
    });
  });

  it("lists all messages in insertion order", () => {
    const store = createMobileChatStore({
      now: () => new Date("2026-05-16T00:00:00.000Z"),
    });
    const userMessage = store.createUserMessage("Summarize today");
    const assistantMessage = store.createAssistantMessage("All clear.", userMessage.id);

    expect(store.list()).toEqual([userMessage, assistantMessage]);
  });

  it("marks a message as failed with an error reason", () => {
    const store = createMobileChatStore({
      now: () => new Date("2026-05-16T00:00:00.000Z"),
    });
    const message = store.createUserMessage("Send update");

    const failedMessage = store.markFailed(message.id, "Network unavailable");

    expect(failedMessage).toEqual({
      ...message,
      status: "failed",
      error: "Network unavailable",
    });
    expect(store.list()).toEqual([failedMessage]);
  });

  it("retries a failed message by marking it sent and clearing the error", () => {
    const store = createMobileChatStore({
      now: () => new Date("2026-05-16T00:00:00.000Z"),
    });
    const message = store.createUserMessage("Retry me");
    store.markFailed(message.id, "Timeout");

    const retriedMessage = store.retry(message.id);

    expect(retriedMessage).toEqual({
      ...message,
      status: "sent",
      error: null,
    });
    expect(store.list()).toEqual([retriedMessage]);
  });

  it("throws when marking or retrying an unknown message", () => {
    const store = createMobileChatStore();

    expect(() => store.markFailed("missing", "No message")).toThrow(
      "Mobile chat message not found: missing",
    );
    expect(() => store.retry("missing")).toThrow(
      "Mobile chat message not found: missing",
    );
  });
});
