import { describe, expect, it, vi } from "vitest";
import {
  blockedOwnerNotificationIdempotencyKey,
  deliverAgentUnblockNotification,
  deliverBlockedOwnerNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
} from "../services/routable-blocked.js";

const agentId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000099";

function blockedIssue(input: {
  transitionAt?: Date | null;
  notifiedAt?: Date | null;
  owner?: { agentId: string } | { userId: string } | "board";
  action?: string;
} = {}) {
  const transitionAt = input.transitionAt === undefined
    ? new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1)
    : input.transitionAt;
  return {
    id: "00000000-0000-4000-8000-000000000002",
    companyId: "00000000-0000-4000-8000-000000000003",
    status: "blocked" as const,
    unblockDescriptor: {
      owner: input.owner ?? { agentId },
      action: input.action ?? "Review the finding",
    },
    blockedTransitionAt: transitionAt,
    blockedOwnerNotifiedAt: input.notifiedAt ?? null,
  };
}

describe("routable blocked notifications", () => {
  it("wakes the named agent and records delivery on a prospective transition", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");
    const issue = blockedIssue();

    await expect(deliverAgentUnblockNotification({ issue, wakeup, markNotified, now: () => now }))
      .resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}`,
      payload: { issueId: issue.id, action: "Review the finding" },
    }));
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("leaves pre-existing blocked issues untouched", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1) }),
      wakeup,
      markNotified,
    })).resolves.toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it("deduplicates one transition and notifies again after a blocked flap", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const firstTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const secondTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2);

    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: firstTransition, notifiedAt: new Date() }),
      wakeup,
      markNotified,
    });
    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: secondTransition }),
      wakeup,
      markNotified,
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: expect.stringContaining(secondTransition.toISOString()),
    });
  });

  it("delivers a user-owned unblock descriptor and records a receipt before success timestamp", async () => {
    const markNotified = vi.fn(async () => undefined);
    const deliverToUser = vi.fn(async () => ({ receiptId: "receipt-1" }));
    const now = new Date("2026-07-23T18:31:00.000Z");
    const issue = blockedIssue({
      transitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 3),
      owner: { userId },
      action: "Repair the adapter startup configuration, then explicitly retry or reassign this issue.",
    });

    await expect(deliverBlockedOwnerNotification({ issue, markNotified, deliverToUser, now: () => now }))
      .resolves.toEqual({ delivered: true, reason: "user_notification_delivered", receiptId: "receipt-1" });
    expect(deliverToUser).toHaveBeenCalledWith({
      userId,
      action: issue.unblockDescriptor.action,
      idempotencyKey: blockedOwnerNotificationIdempotencyKey({
        issueId: issue.id,
        blockedTransitionAt: issue.blockedTransitionAt!,
      }),
    });
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("does not set a success timestamp for unresolved board ownership", async () => {
    const markNotified = vi.fn(async () => undefined);
    const deliverToUser = vi.fn(async () => ({ receiptId: "receipt-1" }));
    const issue = blockedIssue({
      transitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 4),
      owner: "board",
    });

    await expect(deliverBlockedOwnerNotification({ issue, markNotified, deliverToUser }))
      .resolves.toEqual({ delivered: false, reason: "owner_unresolved" });
    expect(deliverToUser).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it("leaves delivery retryable when user notification delivery fails", async () => {
    const markNotified = vi.fn(async () => undefined);
    const deliverToUser = vi.fn(async () => {
      throw new Error("delivery failed");
    });
    const issue = blockedIssue({ owner: { userId } });

    await expect(deliverBlockedOwnerNotification({ issue, markNotified, deliverToUser }))
      .resolves.toEqual({ delivered: false, reason: "delivery_failed" });
    expect(markNotified).not.toHaveBeenCalled();
  });

  it("deduplicates repeated user notification delivery for one blocked transition", async () => {
    const markNotified = vi.fn(async () => undefined);
    const deliverToUser = vi.fn(async () => ({ receiptId: "receipt-1" }));
    const issue = blockedIssue({ owner: { userId } });

    await deliverBlockedOwnerNotification({ issue, markNotified, deliverToUser });
    await deliverBlockedOwnerNotification({ issue: { ...issue, blockedOwnerNotifiedAt: new Date() }, markNotified, deliverToUser });

    expect(deliverToUser).toHaveBeenCalledTimes(1);
    expect(markNotified).toHaveBeenCalledTimes(1);
  });

  it("does not set a success timestamp when board notification delivery is not applicable", async () => {
    const markNotified = vi.fn(async () => undefined);
    const issue = blockedIssue({ transitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1) });

    await expect(deliverBlockedOwnerNotification({ issue, markNotified }))
      .resolves.toEqual({ delivered: false, reason: "not_applicable" });
    expect(markNotified).not.toHaveBeenCalled();
  });
});
