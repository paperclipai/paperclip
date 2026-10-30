import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
  unblockDescriptorFingerprint,
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

  it("records the acknowledgment without waking an agent that named itself as the unblock owner", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue(),
      wakeup,
      markNotified,
      actorAgentId: agentId,
      now: () => now,
    })).resolves.toBe(true);
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("still wakes the named agent when another agent authored the blocked write", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue(),
      wakeup,
      markNotified,
      actorAgentId: "00000000-0000-4000-8000-000000000003",
    })).resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(markNotified).toHaveBeenCalledTimes(1);
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
});

describe("unblock descriptor fingerprint", () => {
  it("hashes the owner and action into a stable hex digest", () => {
    const descriptor = { owner: { agentId: agentId }, action: "Review the finding" };
    const expected = createHash("md5").update(`${agentId}\nReview the finding`, "utf8").digest("hex");
    expect(unblockDescriptorFingerprint(descriptor)).toBe(expected);
    expect(unblockDescriptorFingerprint(descriptor)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes when the owner or action changes", () => {
    const base = unblockDescriptorFingerprint({ owner: { agentId }, action: "Review the finding" });
    expect(unblockDescriptorFingerprint({ owner: { agentId: `${agentId}x` }, action: "Review the finding" })).not.toBe(base);
    expect(unblockDescriptorFingerprint({ owner: { agentId }, action: "Review another finding" })).not.toBe(base);
  });

  it.each([null, undefined, "descriptor", 42, [], {}, { owner: "board" }, { owner: {} }, { owner: { agentId: 7 } }, { owner: { agentId: agentId } }, { action: "x" }])(
    "returns null for malformed input %j", (input) => {
      expect(unblockDescriptorFingerprint(input)).toBeNull();
    },
  );
});
