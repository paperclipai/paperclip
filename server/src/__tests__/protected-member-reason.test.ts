import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { getProtectedMemberReason } from "../routes/access.js";

// Minimal access stub — the function only consults `isInstanceAdmin` when the
// target is *not* the actor, so for self-update tests it is never reached.
const noAccessStub = {
  isInstanceAdmin: async () => false,
  // Cast through unknown so we don't have to construct the full service shape
  // for tests that don't exercise it.
} as unknown as Parameters<typeof getProtectedMemberReason>[1];

function ownerActor(userId: string): Request["actor"] {
  return {
    type: "board",
    source: "session",
    userId,
    isInstanceAdmin: false,
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
  } as Request["actor"];
}

function req(actor: Request["actor"], method = "PATCH"): Request {
  return { method, actor } as Request;
}

describe("getProtectedMemberReason — self target", () => {
  const SELF = "user-self";
  const selfMember = {
    principalId: SELF,
    principalType: "user",
    membershipRole: "owner" as string | null,
  };

  it("blocks self-archive with the explicit removal message", async () => {
    const reason = await getProtectedMemberReason(
      req(ownerActor(SELF)),
      noAccessStub,
      "company-1",
      selfMember,
      { operation: "archive" },
    );
    expect(reason).toBe("You cannot remove yourself.");
  });

  it("allows self-update (no protective reason raised)", async () => {
    const reason = await getProtectedMemberReason(
      req(ownerActor(SELF)),
      noAccessStub,
      "company-1",
      selfMember,
      { operation: "update" },
    );
    expect(reason).toBeNull();
  });

  it("allows self-update even when operation is unspecified (default treated as update)", async () => {
    const reason = await getProtectedMemberReason(
      req(ownerActor(SELF)),
      noAccessStub,
      "company-1",
      selfMember,
      undefined,
    );
    expect(reason).toBeNull();
  });

  it("self-update is allowed regardless of role rank (regression: previously fired 'You can only remove users below your company role')", async () => {
    // operator updating their own membership — same rank, would have triggered
    // the rank-comparison branch had we let the function fall through.
    const operatorActor: Request["actor"] = {
      ...(ownerActor(SELF) as object),
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
    } as Request["actor"];
    const operatorMember = { ...selfMember, membershipRole: "operator" as string | null };
    const reason = await getProtectedMemberReason(
      req(operatorActor),
      noAccessStub,
      "company-1",
      operatorMember,
      { operation: "update" },
    );
    expect(reason).toBeNull();
  });
});

describe("getProtectedMemberReason — non-self target (regression coverage)", () => {
  it("still blocks archive of another instance admin", async () => {
    const adminAccessStub = {
      isInstanceAdmin: async (id: string) => id === "admin-2",
    } as unknown as Parameters<typeof getProtectedMemberReason>[1];
    const reason = await getProtectedMemberReason(
      req(ownerActor("owner-1")),
      adminAccessStub,
      "company-1",
      { principalId: "admin-2", principalType: "user", membershipRole: "admin" },
      { operation: "archive" },
    );
    expect(reason).toBe("Instance admins cannot be removed from company access.");
  });

  it("still blocks archive of an owner", async () => {
    const reason = await getProtectedMemberReason(
      req(ownerActor("owner-1")),
      noAccessStub,
      "company-1",
      { principalId: "owner-2", principalType: "user", membershipRole: "owner" },
      { operation: "archive" },
    );
    expect(reason).toBe("Board owners cannot be removed from company access.");
  });
});
