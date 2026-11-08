import { describe, expect, it, vi } from "vitest";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
} from "../services/routable-blocked.js";

const agentId = "00000000-0000-4000-8000-000000000001";

function blockedIssue(input: {
  transitionAt?: Date | null;
  notifiedAt?: Date | null;
} = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    status: "blocked",
    unblockDescriptor: { owner: { agentId }, action: "Review the finding" } as const,
    blockedTransitionAt: input.transitionAt === undefined
      ? new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1)
      : input.transitionAt,
    blockedOwnerNotifiedAt: input.notifiedAt ?? null,
  };
}

describe("routable blocked notifications", () => {
  it("wakes the named agent and records delivery on a prospective transition", async () => {
    const wakeup = vi.fn(async () => undefined);
    const claimNotification = vi.fn(async (_notifiedAt: Date) => true);
    const releaseNotification = vi.fn(async (_notifiedAt: Date) => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");
    const issue = blockedIssue();

    await expect(deliverAgentUnblockNotification({ issue, wakeup, claimNotification, releaseNotification, now: () => now }))
      .resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}`,
      payload: { issueId: issue.id, action: "Review the finding" },
    }));
    expect(claimNotification).toHaveBeenCalledWith(now);
    expect(releaseNotification).not.toHaveBeenCalled();
  });

  it("leaves pre-existing blocked issues untouched", async () => {
    const wakeup = vi.fn(async () => undefined);
    const claimNotification = vi.fn(async (_notifiedAt: Date) => true);
    const releaseNotification = vi.fn(async (_notifiedAt: Date) => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1) }),
      wakeup,
      claimNotification,
      releaseNotification,
    })).resolves.toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(claimNotification).not.toHaveBeenCalled();
  });

  it("deduplicates one transition and notifies again after a blocked flap", async () => {
    const wakeup = vi.fn(async (_agentId: string, _options: unknown) => undefined);
    const claimNotification = vi.fn(async (_notifiedAt: Date) => true);
    const releaseNotification = vi.fn(async (_notifiedAt: Date) => undefined);
    const firstTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const secondTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2);

    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: firstTransition, notifiedAt: new Date() }),
      wakeup,
      claimNotification,
      releaseNotification,
    });
    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: secondTransition }),
      wakeup,
      claimNotification,
      releaseNotification,
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: expect.stringContaining(secondTransition.toISOString()),
    });
  });

  it("sends no wake when another update already claimed the delivery", async () => {
    const wakeup = vi.fn(async () => undefined);
    const releaseNotification = vi.fn(async (_notifiedAt: Date) => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue(),
      wakeup,
      claimNotification: async () => false,
      releaseNotification,
    })).resolves.toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(releaseNotification).not.toHaveBeenCalled();
  });

  it("releases the claimed delivery when the wake fails", async () => {
    const failure = new Error("wake rejected");
    const releaseNotification = vi.fn(async (_notifiedAt: Date) => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue(),
      wakeup: async () => { throw failure; },
      claimNotification: async () => true,
      releaseNotification,
      now: () => now,
    })).rejects.toBe(failure);
    expect(releaseNotification).toHaveBeenCalledWith(now);
  });
});
