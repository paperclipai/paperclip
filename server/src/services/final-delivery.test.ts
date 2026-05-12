import { describe, expect, it, vi } from "vitest";
import type { Issue, IssueThreadInteraction, IssueWorkProduct } from "@paperclipai/shared";
import {
  buildIssueFinalDeliveryIdempotencyKey,
  createIssueFinalDeliveryQueue,
} from "./final-delivery.js";

const issue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "33333333-3333-4333-8333-333333333333",
  identifier: "LET-50",
  title: "Return final result to Telegram",
  status: "done",
  completedAt: new Date("2026-05-12T12:00:00.000Z"),
  executionPolicy: {
    mode: "normal",
    commentRequired: true,
    stages: [],
    finalDelivery: {
      enabled: true,
      destination: {
        platform: "telegram",
        chatId: "-1003913210493",
        threadId: "103",
      },
    },
  },
} as unknown as Issue;

const pullRequest = {
  id: "22222222-2222-4222-8222-222222222222",
  issueId: issue.id,
  type: "pull_request",
  provider: "github",
  title: "Final delivery loop PR",
  url: "https://github.com/lmanualm/paperclip/pull/16",
  status: "ready_for_review",
  summary: "Adds final delivery trigger and idempotency",
  isPrimary: true,
} as IssueWorkProduct;

describe("issue final delivery queue", () => {
  it("builds stable destination-scoped idempotency keys", () => {
    expect(buildIssueFinalDeliveryIdempotencyKey(issue.id, {
      platform: "telegram",
      chatId: "-1003913210493",
      threadId: "103",
    })).toBe("issue-final-delivery:11111111-1111-4111-8111-111111111111:telegram:-1003913210493:103");

    expect(buildIssueFinalDeliveryIdempotencyKey(issue.id, {
      platform: "slack",
      channelId: "C0123456789",
      threadTs: "1710000000.000100",
    })).toBe("issue-final-delivery:11111111-1111-4111-8111-111111111111:slack:C0123456789:1710000000.000100");
  });

  it("queues one final_delivery interaction for a completed issue and reuses it on duplicate triggers", async () => {
    const queuedInteraction = {
      id: "44444444-4444-4444-8444-444444444444",
      companyId: issue.companyId,
      issueId: issue.id,
      kind: "final_delivery",
      status: "pending",
      continuationPolicy: "none",
      idempotencyKey: "issue-final-delivery:11111111-1111-4111-8111-111111111111:telegram:-1003913210493:103",
      payload: {},
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as IssueThreadInteraction;

    const deps = {
      findInteractionByIdempotencyKey: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(queuedInteraction),
      createInteraction: vi.fn(async () => queuedInteraction),
      listWorkProducts: vi.fn(async () => [pullRequest]),
    };

    const queue = createIssueFinalDeliveryQueue(deps);

    const first = await queue.queueForCompletedIssue(issue, {
      actor: { agentId: "55555555-5555-4555-8555-555555555555", userId: null },
      finalMessageMarkdown: "Done. Evidence attached below.",
      sourceRunId: "66666666-6666-4666-8666-666666666666",
    });

    expect(first.status).toBe("queued");
    expect(deps.createInteraction).toHaveBeenCalledTimes(1);
    expect(deps.createInteraction).toHaveBeenCalledWith(
      { id: issue.id, companyId: issue.companyId },
      expect.objectContaining({
        kind: "final_delivery",
        continuationPolicy: "none",
        idempotencyKey: queuedInteraction.idempotencyKey,
        sourceRunId: "66666666-6666-4666-8666-666666666666",
        payload: expect.objectContaining({
          destination: expect.objectContaining({ platform: "telegram", chatId: "-1003913210493", threadId: "103" }),
          message: { format: "markdown", body: "Done. Evidence attached below." },
          artifacts: [
            expect.objectContaining({
              id: pullRequest.id,
              type: "pull_request",
              title: "Final delivery loop PR",
              url: "https://github.com/lmanualm/paperclip/pull/16",
              isPrimary: true,
            }),
          ],
        }),
      }),
      { agentId: "55555555-5555-4555-8555-555555555555", userId: null },
    );

    const duplicate = await queue.queueForCompletedIssue(issue, {
      actor: { agentId: "55555555-5555-4555-8555-555555555555", userId: null },
      finalMessageMarkdown: "A later retry should not create another delivery.",
    });

    expect(duplicate.status).toBe("already_queued");
    if (duplicate.status !== "already_queued") {
      throw new Error(`expected already_queued, got ${duplicate.status}`);
    }
    expect(duplicate.interaction).toBe(queuedInteraction);
    expect(deps.createInteraction).toHaveBeenCalledTimes(1);
  });
});
