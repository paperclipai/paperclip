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

  it("keeps voice presentation concise without cancelling work on hangup or granting approvals", () => {
    const guidance = buildChatCommunicationGuidance({ provider: "speko", isDirectMessage: true });
    expect(guidance).toContain("Communication by voice");
    expect(guidance).toContain("Keep your existing identity, runtime, tools, and task assignment");
    expect(guidance).toContain("one focused clarification");
    expect(guidance).toContain("durable Paperclip continuation");
    expect(guidance).toContain("Delivery to Speko does not prove an answer was spoken");
    expect(guidance).toContain("does not cancel work");
    expect(guidance).toContain("Protected approvals must be completed in Paperclip");
  });

  it.each(CHAT_PROVIDERS.filter((provider) => provider !== "slack" && provider !== "speko"))("leaves %s unchanged", (provider) => {
    expect(buildChatCommunicationGuidance({ provider, isDirectMessage: false, communicationInstructions: "Ignored" })).toBeNull();
  });

  it("accepts clearing instructions and rejects oversized instructions and unsupported controls", () => {
    expect(updateChatEndpointSchema.parse({ communicationInstructions: "  " })).toEqual({ communicationInstructions: "" });
    expect(updateChatEndpointSchema.safeParse({ communicationInstructions: "a".repeat(4001) }).success).toBe(false);
    expect(updateChatEndpointSchema.safeParse({ replyDetail: "brief" }).success).toBe(false);
    expect(updateChatEndpointSchema.safeParse({ progressUpdates: false }).success).toBe(false);
  });
});
