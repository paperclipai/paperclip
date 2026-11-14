import { describe, expect, it } from "vitest";
import { slackDeliveryMeetsMentionRequirement } from "./wake-authority.js";

describe("Slack channel mention policy", () => {
  const root = {
    trigger: "subscribed_message",
    conversation: { externalThreadId: "slack:C123:7300.000001", isDirectMessage: false },
    message: { providerMessageId: "7300.000001", mentionedBot: false },
  };

  it("requires a mention on a channel root, even for a subscribed callback", () => {
    expect(slackDeliveryMeetsMentionRequirement({ requireAtMention: true }, root)).toBe(false);
    expect(slackDeliveryMeetsMentionRequirement({ requireAtMention: false }, root)).toBe(true);
  });

  it("allows replies with a known message ID in a channel thread", () => {
    expect(slackDeliveryMeetsMentionRequirement({ requireAtMention: true }, {
      ...root, message: { ...root.message, providerMessageId: "7300.000002" },
    })).toBe(true);
  });

  it.each([
    {},
    { ...root, message: {} },
    { ...root, message: { providerMessageId: "" } },
    { ...root, message: { providerMessageId: 7300 } },
    { ...root, conversation: {} },
    { ...root, conversation: { externalThreadId: "slack:C123:" } },
    { ...root, conversation: { externalThreadId: "slack:C123" } },
    { ...root, conversation: { externalThreadId: "discord:C123:7300.000001" } },
  ])("does not infer a thread reply from incomplete or invalid identity (%j)", (event) => {
    expect(slackDeliveryMeetsMentionRequirement({ requireAtMention: true }, event)).toBe(false);
  });

  it("accepts either explicit mention callback", () => {
    expect(slackDeliveryMeetsMentionRequirement({ requireAtMention: true }, { ...root, trigger: "mention" })).toBe(true);
    expect(slackDeliveryMeetsMentionRequirement({ requireAtMention: true }, {
      ...root, message: { ...root.message, mentionedBot: true },
    })).toBe(true);
  });

  it("exempts DMs and uses the current conversation type when it is supplied", () => {
    const directMessage = { ...root, conversation: { ...root.conversation, isDirectMessage: true } };
    expect(slackDeliveryMeetsMentionRequirement({ requireAtMention: true }, directMessage)).toBe(true);
    expect(slackDeliveryMeetsMentionRequirement({ requireAtMention: true }, root, true)).toBe(true);
    expect(slackDeliveryMeetsMentionRequirement({ requireAtMention: true }, directMessage, false)).toBe(false);
  });
});
