import { describe, expect, it } from "vitest";
import { boardDescriptorForBlock } from "./blocked-descriptor.js";

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
