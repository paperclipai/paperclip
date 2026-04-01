import { describe, expect, it } from "vitest";
import { activeUserSeatCandidates } from "./seat-members";

describe("activeUserSeatCandidates", () => {
  it("returns unique active user memberships only", () => {
    expect(
      activeUserSeatCandidates([
        {
          id: "m-1",
          companyId: "c-1",
          principalType: "user",
          principalId: "user-2",
          membershipRole: "member",
          status: "active",
        },
        {
          id: "m-2",
          companyId: "c-1",
          principalType: "user",
          principalId: "user-1",
          membershipRole: "owner",
          status: "active",
        },
        {
          id: "m-3",
          companyId: "c-1",
          principalType: "agent",
          principalId: "agent-1",
          membershipRole: "member",
          status: "active",
        },
        {
          id: "m-4",
          companyId: "c-1",
          principalType: "user",
          principalId: "user-2",
          membershipRole: "member",
          status: "active",
        },
        {
          id: "m-5",
          companyId: "c-1",
          principalType: "user",
          principalId: "user-3",
          membershipRole: "member",
          status: "inactive",
        },
      ]),
    ).toEqual([
      { userId: "user-2", membershipRole: "member" },
      { userId: "user-1", membershipRole: "owner" },
    ]);
  });
});
