import { describe, it, expect, beforeEach } from "vitest";
import { IntentEngine } from "../intent-engine.js";
import { InMemoryConversationStore } from "../store.js";
import type { GatewayConfig } from "../config.js";
import type { InboundPayload } from "../types.js";

const TEST_CONFIG: GatewayConfig = {
  port: 3200,
  gatewayBaseUrl: "http://localhost:3200",
  bridgeSharedSecret: "test-secret",
  paperclipApiUrl: "http://localhost:3000",
  paperclipApiKey: "test-key",
  paperclipCompanyId: "company-1",
  webhookSecret: "webhook-secret",
  inactivityTimeoutMs: 24 * 60 * 60 * 1000,
};

function makePayload(text: string, overrides?: Partial<InboundPayload>): InboundPayload {
  return {
    messageId: "msg-1",
    platform: "telegram",
    timestamp: new Date().toISOString(),
    sender: {
      platformUserId: "user-1",
      displayName: "Test User",
    },
    conversation: {
      platformConversationId: "conv-1",
      threadId: null,
      replyToMessageId: null,
    },
    content: { type: "text", text },
    metadata: { bridgeVersion: "0.1.0" },
    ...overrides,
  };
}

const BINDING = {
  paperclipUserId: "pclip-user-1",
  paperclipCompanyId: "company-1",
};

describe("IntentEngine", () => {
  let store: InMemoryConversationStore;
  let engine: IntentEngine;

  beforeEach(() => {
    store = new InMemoryConversationStore();
    engine = new IntentEngine(TEST_CONFIG, store);
  });

  it("returns unbound_user when no binding exists", async () => {
    const result = await engine.resolve(makePayload("hello"), null);
    expect(result.action).toBe("unbound_user");
  });

  it("creates a new issue for first message in conversation", async () => {
    const result = await engine.resolve(makePayload("Deploy the new API"), BINDING);
    expect(result).toEqual({
      action: "create_issue",
      title: "Deploy the new API",
      description: "Deploy the new API",
    });
  });

  it("appends comment when active mapping exists", async () => {
    await store.create({
      platform: "telegram",
      platformUserId: "user-1",
      platformConversationId: "conv-1",
      threadId: null,
      paperclipIssueId: "issue-123",
      paperclipCompanyId: "company-1",
      paperclipUserId: "pclip-user-1",
    });

    const result = await engine.resolve(makePayload("Also add logging"), BINDING);
    expect(result).toEqual({
      action: "append_comment",
      issueId: "issue-123",
      body: "Also add logging",
    });
  });

  it("creates new issue on intent split keyword", async () => {
    await store.create({
      platform: "telegram",
      platformUserId: "user-1",
      platformConversationId: "conv-1",
      threadId: null,
      paperclipIssueId: "issue-123",
      paperclipCompanyId: "company-1",
      paperclipUserId: "pclip-user-1",
    });

    const result = await engine.resolve(
      makePayload("new task: fix the login page"),
      BINDING,
    );
    expect(result.action).toBe("create_issue");
  });

  it("creates new issue after inactivity timeout", async () => {
    const mapping = await store.create({
      platform: "telegram",
      platformUserId: "user-1",
      platformConversationId: "conv-1",
      threadId: null,
      paperclipIssueId: "issue-123",
      paperclipCompanyId: "company-1",
      paperclipUserId: "pclip-user-1",
    });

    // Simulate old activity
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    (mapping as { lastActivityAt: string }).lastActivityAt = old;

    const result = await engine.resolve(makePayload("Check the metrics"), BINDING);
    expect(result.action).toBe("create_issue");
  });

  it("truncates long titles to 80 chars", async () => {
    const longText = "A".repeat(100);
    const result = await engine.resolve(makePayload(longText), BINDING);
    expect(result.action).toBe("create_issue");
    if (result.action === "create_issue") {
      expect(result.title.length).toBeLessThanOrEqual(80);
      expect(result.title.endsWith("...")).toBe(true);
    }
  });
});
