import { describe, expect, it } from "vitest";
import { orgNodeBadges } from "./org-node-display";

describe("orgNodeBadges", () => {
  it("returns seat and operating mode badges when present", () => {
    expect(orgNodeBadges({
      id: "agent-1",
      seatId: "seat-1",
      name: "Platform Seat",
      role: "engineer",
      seatType: "manager",
      operatingMode: "assisted",
      status: "active",
      reports: [],
    })).toEqual([
      { key: "seat", label: "manager seat" },
      { key: "mode", label: "assisted" },
    ]);
  });

  it("returns empty list for legacy nodes without seat metadata", () => {
    expect(orgNodeBadges({
      id: "agent-1",
      seatId: null,
      name: "Legacy Agent",
      role: "engineer",
      seatType: null,
      operatingMode: null,
      status: "active",
      reports: [],
    })).toEqual([]);
  });
});
