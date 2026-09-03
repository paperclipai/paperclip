import { describe, expect, it, vi } from "vitest";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
  unblockDescriptorFingerprint,
} from "../services/routable-blocked.js";

const agentId = "00000000-0000-4000-8000-000000000001";
const otherAgentId = "00000000-0000-4000-8000-000000000003";

function blockedIssue(input: {
  transitionAt?: Date | null;
  notifiedAt?: Date | null;
  owner?: { agentId: string } | { userId: string } | "board";
  action?: string;
} = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    status: "blocked",
    unblockDescriptor: {
      owner: input.owner ?? { agentId },
      action: input.action ?? "Review the finding",
    },
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
      idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}:${
        unblockDescriptorFingerprint(issue.unblockDescriptor)
      }:first`,
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

  // BRO-2453: BRO-2377 was already blocked when an agent attached its
  // descriptor. The transition timestamp does not move on a re-point, so the
  // descriptor itself has to discriminate the key — otherwise two owners'
  // deliveries are indistinguishable in the wakeup log, and any future dedupe
  // wired onto this prefix would drop the second one.
  it("gives a re-pointed descriptor a distinct idempotency key on the same transition", async () => {
    const transitionAt = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const first = blockedIssue({ transitionAt });
    const repointed = blockedIssue({ transitionAt, owner: { agentId: otherAgentId } });

    const firstWakeup = vi.fn(async () => undefined);
    const repointedWakeup = vi.fn(async () => undefined);
    await deliverAgentUnblockNotification({
      issue: first,
      wakeup: firstWakeup,
      markNotified: async () => undefined,
    });
    await deliverAgentUnblockNotification({
      issue: repointed,
      wakeup: repointedWakeup,
      markNotified: async () => undefined,
    });

    expect(repointedWakeup).toHaveBeenCalledWith(otherAgentId, expect.anything());
    const firstKey = (firstWakeup.mock.calls[0]?.[1] as { idempotencyKey: string }).idempotencyKey;
    const repointedKey = (repointedWakeup.mock.calls[0]?.[1] as { idempotencyKey: string }).idempotencyKey;
    expect(firstKey).toContain(transitionAt.toISOString());
    expect(repointedKey).toContain(transitionAt.toISOString());
    expect(repointedKey).not.toBe(firstKey);
  });

  // BRO-2453 (Greptile): owner+action+transition are identical on the first and
  // third delivery of an A -> B -> A re-point, so the descriptor fingerprint
  // alone rebuilds A's original key. The superseded delivery stamp is the only
  // thing separating the renewed obligation from the one already sent.
  it("separates a descriptor re-pointed back to the first owner from its first delivery", async () => {
    const transitionAt = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const wakeup = vi.fn(async () => undefined);
    const repoints = [
      { owner: { agentId }, at: new Date("2026-07-24T00:00:00.000Z") },
      { owner: { agentId: otherAgentId }, at: new Date("2026-07-24T01:00:00.000Z") },
      { owner: { agentId }, at: new Date("2026-07-24T02:00:00.000Z") },
    ];

    // Mirrors the route: the first delivery supersedes nothing, and each
    // re-point clears the stamp for suppression but carries it into the key.
    let notifiedAt: Date | null = null;
    for (const [index, repoint] of repoints.entries()) {
      const supersedesNotifiedAt = index === 0 ? null : notifiedAt;
      await deliverAgentUnblockNotification({
        issue: blockedIssue({ transitionAt, owner: repoint.owner }),
        supersedesNotifiedAt,
        wakeup,
        markNotified: async (at) => { notifiedAt = at; },
        now: () => repoint.at,
      });
    }

    expect(wakeup.mock.calls.map((call) => call[0])).toEqual([agentId, otherAgentId, agentId]);
    const keys = wakeup.mock.calls.map((call) => (call[1] as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    // The specific collision Greptile flagged: third delivery vs. first.
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("separates keys when only the action text changes", () => {
    const owner = { agentId } as const;
    expect(unblockDescriptorFingerprint({ owner, action: "Do A" }))
      .not.toBe(unblockDescriptorFingerprint({ owner, action: "Do B" }));
    expect(unblockDescriptorFingerprint({ owner, action: "Do A" }))
      .toBe(unblockDescriptorFingerprint({ owner, action: "Do A" }));
  });
});
