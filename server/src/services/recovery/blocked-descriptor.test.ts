import { describe, expect, it } from "vitest";
import { boardDescriptorForBlock, repairedBlockedTransitionAt } from "./blocked-descriptor.js";

/**
 * A recovery path that creates a `blocked` card must attach a descriptor, or the
 * card is invisible. But it must never displace a block it did not create:
 * overwriting an agent- or user-owned descriptor with a board-owned one severs
 * the only path to whoever is already responsible for the unblock.
 */
describe("boardDescriptorForBlock", () => {
  it("attaches a board-owned descriptor when the card has none", () => {
    expect(
      boardDescriptorForBlock({ existing: null, action: "Inspect the failure and choose a recovery action." }),
    ).toEqual({
      owner: "board",
      action: "Inspect the failure and choose a recovery action.",
    });
  });

  it("attaches a board-owned descriptor when an existing descriptor has no usable action", () => {
    expect(
      boardDescriptorForBlock({ existing: { owner: "board", action: "   " }, action: "Real next step." }),
    ).toEqual({ owner: "board", action: "Real next step." });
  });

  it("preserves an agent-owned descriptor instead of downgrading it to the board", () => {
    const existing = { owner: { agentId: "agent-1" }, action: "Agent must resolve the checkout conflict." };
    expect(boardDescriptorForBlock({ existing, action: "Generic board text." })).toBeNull();
  });

  it("preserves a user-owned descriptor instead of downgrading it to the board", () => {
    const existing = { owner: { userId: "user-1" }, action: "Board member is reviewing this hold." };
    expect(boardDescriptorForBlock({ existing, action: "Generic board text." })).toBeNull();
  });

  it("preserves an existing board-owned descriptor so the original action survives", () => {
    const existing = { owner: "board" as const, action: "Original operator action." };
    expect(boardDescriptorForBlock({ existing, action: "Replacement text." })).toBeNull();
  });

  it("returns null when there is no existing descriptor and no usable action", () => {
    expect(boardDescriptorForBlock({ existing: null, action: "  " })).toBeNull();
  });

  it("trims the action it attaches", () => {
    expect(boardDescriptorForBlock({ existing: null, action: "  Padded action.  " })).toEqual({
      owner: "board",
      action: "Padded action.",
    });
  });
});

/**
 * `issuesSvc.update` stamps `blockedTransitionAt` only on a real
 * `not blocked -> blocked` transition. A card that is already `blocked` with a
 * null or pre-rollout timestamp keeps it, and `isProspectiveBlockedTransition`
 * then returns false, so the card stays invisible to board attention.
 */
describe("repairedBlockedTransitionAt", () => {
  const now = new Date("2026-09-26T00:00:00.000Z");

  it("stamps a card that is blocked with no timestamp", () => {
    expect(repairedBlockedTransitionAt({ status: "blocked", blockedTransitionAt: null, now })).toEqual(now);
  });

  it("stamps a card whose timestamp predates the routable rollout", () => {
    expect(
      repairedBlockedTransitionAt({
        status: "blocked",
        blockedTransitionAt: new Date("2026-01-01T00:00:00.000Z"),
        now,
      }),
    ).toEqual(now);
  });

  it("leaves a card that is blocked with a valid timestamp alone", () => {
    const valid = new Date("2026-09-01T00:00:00.000Z");
    expect(repairedBlockedTransitionAt({ status: "blocked", blockedTransitionAt: valid, now })).toBeNull();
  });

  it("returns null for a card that is not blocked, so a real transition keeps its own stamp", () => {
    expect(repairedBlockedTransitionAt({ status: "in_progress", blockedTransitionAt: null, now })).toBeNull();
  });
});
