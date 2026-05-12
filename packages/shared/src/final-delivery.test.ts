import { describe, expect, it } from "vitest";
import {
  ISSUE_THREAD_INTERACTION_KINDS,
  createIssueThreadInteractionSchema,
  issueExecutionPolicySchema,
  issueFinalDeliveryDestinationSchema,
  issueFinalDeliveryPayloadSchema,
} from "./index.js";

const issueId = "11111111-1111-4111-8111-111111111111";

describe("issue final delivery contract", () => {
  it("persists Telegram and Slack destinations in the issue execution policy", () => {
    const telegramPolicy = issueExecutionPolicySchema.parse({
      mode: "normal",
      finalDelivery: {
        enabled: true,
        destination: {
          platform: "telegram",
          chatId: "-1003913210493",
          threadId: "103",
          messageId: "9876",
        },
      },
    });

    expect(telegramPolicy.finalDelivery).toMatchObject({
      enabled: true,
      destination: {
        platform: "telegram",
        chatId: "-1003913210493",
        threadId: "103",
        messageId: "9876",
      },
    });

    const slackDestination = issueFinalDeliveryDestinationSchema.parse({
      platform: "slack",
      channelId: "C0123456789",
      threadTs: "1710000000.000100",
      messageTs: "1710000000.000099",
    });

    expect(slackDestination).toMatchObject({
      platform: "slack",
      channelId: "C0123456789",
      threadTs: "1710000000.000100",
      messageTs: "1710000000.000099",
    });
  });

  it("validates final_delivery interactions with evidence artifacts", () => {
    expect(ISSUE_THREAD_INTERACTION_KINDS).toContain("final_delivery");

    const payload = issueFinalDeliveryPayloadSchema.parse({
      version: 1,
      destination: {
        platform: "telegram",
        chatId: "-1003913210493",
        threadId: "103",
      },
      issue: {
        id: issueId,
        identifier: "LET-50",
        title: "Ship final delivery loop",
      },
      message: {
        format: "markdown",
        body: "Done. Evidence attached below.",
      },
      artifacts: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "pull_request",
          title: "Final delivery PR",
          url: "https://github.com/lmanualm/paperclip/pull/16",
          summary: "Implementation and tests",
          isPrimary: true,
        },
      ],
    });

    expect(payload.artifacts).toHaveLength(1);

    const interaction = createIssueThreadInteractionSchema.parse({
      kind: "final_delivery",
      continuationPolicy: "none",
      idempotencyKey: "issue-final-delivery:11111111-1111-4111-8111-111111111111:telegram:-1003913210493:103",
      title: "Final delivery for LET-50",
      summary: "Queued delivery to Telegram thread 103",
      payload,
    });

    if (interaction.kind !== "final_delivery") {
      throw new Error(`expected final_delivery interaction, got ${interaction.kind}`);
    }
    expect(interaction.payload.destination.platform).toBe("telegram");
  });
});
