import { describe, expect, it } from "vitest";
import { CHAT_PROVIDERS, updateChatEndpointSchema } from "@paperclipai/shared";
import { buildChatCommunicationGuidance } from "./chat-communication-guidance.js";

describe("initial medium communication guidance", () => {
  it("guides Slack presentation while retaining ordinary agent tools and explicit output requests", () => {
    const guidance = buildChatCommunicationGuidance({ provider: "slack", isDirectMessage: false, communicationInstructions: "Use customer-facing names." });
    expect(guidance).toContain("shared channel thread");
    expect(guidance).toContain("document or artifact tools");
    expect(guidance).toContain("exact output");
    expect(guidance).toContain("grant no additional authority");
    expect(guidance).toContain('"Use customer-facing names."');
    expect(buildChatCommunicationGuidance({ provider: "slack", isDirectMessage: true })).toContain("direct conversation");
  });

  it.each(CHAT_PROVIDERS.filter((provider) => provider !== "slack"))("leaves %s unchanged", (provider) => {
    expect(buildChatCommunicationGuidance({ provider, isDirectMessage: false, communicationInstructions: "Ignored" })).toBeNull();
  });

  it("accepts clearing instructions and rejects oversized instructions and unsupported controls", () => {
    expect(updateChatEndpointSchema.parse({ communicationInstructions: "  " })).toEqual({ communicationInstructions: "" });
    expect(updateChatEndpointSchema.safeParse({ communicationInstructions: "a".repeat(4001) }).success).toBe(false);
    expect(updateChatEndpointSchema.safeParse({ replyDetail: "brief" }).success).toBe(false);
    expect(updateChatEndpointSchema.safeParse({ progressUpdates: false }).success).toBe(false);
  });
});
