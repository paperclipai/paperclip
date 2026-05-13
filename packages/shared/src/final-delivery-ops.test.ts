import { describe, expect, it } from "vitest";
import {
  buildFinalDeliveryHistorySummary,
  maskFinalDeliveryDestination,
  planFinalDeliveryCancel,
  planFinalDeliveryRetry,
} from "./final-delivery-ops.js";

describe("final delivery operations", () => {
  it("summarizes delivery history without leaking raw routing ids", () => {
    const destination = {
      platform: "telegram" as const,
      chatId: "-1003913210493",
      threadId: "103",
      messageId: "910",
    };

    const summary = buildFinalDeliveryHistorySummary({
      destination,
      entries: [
        {
          id: "delivery-1",
          createdAt: "2026-05-13T20:00:00.000Z",
          status: "pending",
          artifactCount: 1,
        },
        {
          id: "delivery-2",
          createdAt: "2026-05-13T20:05:00.000Z",
          status: "resolved",
          result: {
            version: 1,
            outcome: "failed",
            attemptCount: 2,
            retryable: true,
            externalMessageId: "910",
            error: ["Authorization: Bearer", "synthetic-token", "failed"].join(" "),
          },
          artifactCount: 2,
        },
      ],
    });

    expect(maskFinalDeliveryDestination(destination)).toBe("Telegram · chat …0493 · thread …103 · message …910");
    expect(summary.destinationSummary).toBe("Telegram · chat …0493 · thread …103 · message …910");
    expect(JSON.stringify(summary)).not.toContain("-1003913210493");
    expect(JSON.stringify(summary)).not.toContain("synthetic-token");
    expect(summary.latestOutcome).toBe("failed");
    expect(summary.retryableCount).toBe(1);
    expect(summary.entries[0]?.artifactCount).toBe(2);
  });

  it("plans retry/cancel operations as idempotent gated previews", () => {
    const retry = planFinalDeliveryRetry({
      issueId: "issue-1",
      deliveryId: "delivery-2",
      outcome: "failed",
      retryable: true,
      requestedBy: "operator-user",
      nowIso: "2026-05-13T21:00:00.000Z",
    });

    expect(retry.allowed).toBe(true);
    expect(retry.mutatesOutbox).toBe(true);
    expect(retry.sendsImmediately).toBe(false);
    expect(retry.idempotencyKey).toBe("final-delivery:retry:issue-1:delivery-2");
    expect(retry.requiredApprovalGate).toBe("lead");

    const cancel = planFinalDeliveryCancel({
      issueId: "issue-1",
      deliveryId: "delivery-3",
      outcome: "delivered",
      requestedBy: "operator-user",
      nowIso: "2026-05-13T21:00:00.000Z",
    });

    expect(cancel.allowed).toBe(false);
    expect(cancel.reason).toContain("terminal");
  });
});
