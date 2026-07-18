import { describe, expect, it } from "vitest";
import { clearanceForMembershipRole, readRunRequester } from "./requester-clearance.js";

describe("readRunRequester (NEO-447)", () => {
  it("reads a well-formed requester snapshot", () => {
    expect(
      readRunRequester({
        requester: { userId: "u-1", channelUserId: "cliq-9", channelId: "ch-1", source: "cliq" },
      }),
    ).toEqual({ userId: "u-1", channelUserId: "cliq-9", channelId: "ch-1", source: "cliq" });
  });

  it("returns null for missing/malformed snapshots", () => {
    expect(readRunRequester(null)).toBeNull();
    expect(readRunRequester(undefined)).toBeNull();
    expect(readRunRequester("nope")).toBeNull();
    expect(readRunRequester({})).toBeNull();
    expect(readRunRequester({ requester: "spoof" })).toBeNull();
    expect(readRunRequester({ requester: 42 })).toBeNull();
  });

  it("normalizes empty/non-string ids to null (unresolved, never a truthy principal)", () => {
    expect(readRunRequester({ requester: { userId: "" } })?.userId).toBeNull();
    expect(readRunRequester({ requester: { userId: "   " } })?.userId).toBeNull();
    expect(readRunRequester({ requester: { userId: 123 } })?.userId).toBeNull();
    expect(readRunRequester({ requester: { userId: null } })?.userId).toBeNull();
  });
});

describe("clearanceForMembershipRole (NEO-447)", () => {
  it("maps human membership roles onto the MCP clearance ladder", () => {
    expect(clearanceForMembershipRole("owner")).toBe("board");
    expect(clearanceForMembershipRole("admin")).toBe("board");
    expect(clearanceForMembershipRole("operator")).toBe("member");
    expect(clearanceForMembershipRole("viewer")).toBe("guest");
  });

  it("resolves unknown/absent roles to null (UNRESOLVED — caller floors)", () => {
    expect(clearanceForMembershipRole("superuser")).toBeNull();
    expect(clearanceForMembershipRole("")).toBeNull();
    expect(clearanceForMembershipRole(null)).toBeNull();
    expect(clearanceForMembershipRole(undefined)).toBeNull();
  });
});
