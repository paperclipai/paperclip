import { describe, expect, it, vi } from "vitest";
import {
  buildAgentUnblockWakeIntent,
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
} from "../services/routable-blocked.js";
import { allowsIssueUnblockRequestWake } from "../services/heartbeat.js";

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
  it("rejects superseded unblock wake intents before execution", () => {
    const issue = {
      id: "issue-1",
      status: "blocked",
      unblockDescriptor: { owner: { agentId: "agent-1" }, action: "Review version A" },
      blockedTransitionAt: new Date("2026-07-28T12:00:00.000Z"),
    };
    const intent = buildAgentUnblockWakeIntent(issue)!;
    const context = {
      wakeReason: "issue_unblock_requested",
      intentFingerprint: intent.intentFingerprint,
    };

    expect(allowsIssueUnblockRequestWake(context, issue, "agent-1")).toBe(true);
    expect(allowsIssueUnblockRequestWake(context, {
      ...issue,
      unblockDescriptor: { owner: { agentId: "agent-1" }, action: "Review version B" },
    }, "agent-1")).toBe(false);
    expect(allowsIssueUnblockRequestWake(context, {
      ...issue,
      blockedTransitionAt: new Date("2026-07-28T12:05:00.000Z"),
    }, "agent-1")).toBe(false);
    expect(allowsIssueUnblockRequestWake(context, issue, "agent-2")).toBe(false);
  });

  it("wakes the named agent and records delivery on a prospective transition", async () => {
    const wakeup = vi.fn(async () => ({ id: "queued-run" }));
    const markNotified = vi.fn(async () => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");
    const issue = blockedIssue();

    await expect(deliverAgentUnblockNotification({ issue, wakeup, markNotified, now: () => now }))
      .resolves.toBe(true);
    const intent = buildAgentUnblockWakeIntent(issue)!;
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_unblock_requested",
      idempotencyKey: intent.idempotencyKey,
      payload: intent.payload,
    }));
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("does not record delivery when scheduling is suppressed", async () => {
    const wakeup = vi.fn(async () => null);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue(),
      wakeup,
      markNotified,
    })).resolves.toBe(false);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(markNotified).not.toHaveBeenCalled();
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
    const wakeup = vi.fn(async () => ({ id: "queued-run" }));
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
});
