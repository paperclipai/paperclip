import { describe, expect, it } from "vitest";
import type { OrgNode } from "../api/agents";
import { orgNodeCanManageSeat, primarySeatAction } from "./seat-actions";

const baseNode: OrgNode = {
  id: "agent-1",
  seatId: "seat-1",
  name: "Platform Seat",
  role: "engineer",
  seatType: "manager",
  operatingMode: "vacant",
  status: "active",
  reports: [],
};

describe("seat action helpers", () => {
  it("enables management actions only for nodes with seats", () => {
    expect(orgNodeCanManageSeat(baseNode)).toBe(true);
    expect(orgNodeCanManageSeat({ ...baseNode, seatId: null })).toBe(false);
  });

  it("returns attach for vacant seats and detach otherwise", () => {
    expect(primarySeatAction(baseNode)).toBe("attach");
    expect(primarySeatAction({ ...baseNode, operatingMode: "assisted" })).toBe("detach");
    expect(primarySeatAction({ ...baseNode, operatingMode: "shadowed" })).toBe("detach");
    expect(primarySeatAction({ ...baseNode, status: "paused" })).toBeNull();
    expect(primarySeatAction({ ...baseNode, status: "terminated" })).toBeNull();
    expect(primarySeatAction({ ...baseNode, seatId: null })).toBeNull();
  });
});
