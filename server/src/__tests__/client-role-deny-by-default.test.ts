import { describe, expect, it } from "vitest";
import { assertCompanyAccess, hasCompanyAccess } from "../routes/authz.js";
import { grantsForHumanRole, normalizeHumanRole, resolveHumanInviteRole } from "../services/company-member-roles.js";

/**
 * Characterization tests for the deny-by-default `client` membership role RFC.
 *
 * These describe how the CURRENT code treats an unrecognized membership role
 * such as `client`. They all pass on master: that is the point. They encode the
 * three fail-open behaviors a client role has to contend with, so that the
 * implementation PR can invert each assertion and have a regression test that
 * genuinely covers the change.
 *
 * Each block is labeled with the hazard number used in the RFC.
 */

function makeReq(input: { method?: string; actor: Express.Request["actor"] }) {
  return {
    method: input.method ?? "GET",
    actor: input.actor,
  } as Express.Request;
}

/** A session actor holding a single `client` membership in company-1. */
function clientActor(): Express.Request["actor"] {
  return {
    type: "board",
    userId: "client-user-1",
    source: "session",
    // auth.ts derives companyIds from every ACTIVE membership, regardless of role.
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: "client", status: "active" }],
  };
}

describe("hazard 1: hasCompanyAccess ignores membershipRole", () => {
  it("admits a client membership, so every getAccessibleResource read path admits it too", () => {
    // getAccessibleResource gates existence on hasCompanyAccess alone. There are
    // 241 getAccessibleResource call sites on master; all of them would return
    // the resource to a client principal.
    expect(hasCompanyAccess(makeReq({ actor: clientActor() }), "company-1")).toBe(true);
  });

  it("is the only gate that distinguishes 404 from a real read, and it is role-blind", () => {
    const viewerLike = makeReq({
      actor: {
        type: "board",
        userId: "u",
        source: "session",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
      },
    });
    // A client is indistinguishable from a viewer here: both pass.
    expect(hasCompanyAccess(viewerLike, "company-1")).toBe(true);
    expect(hasCompanyAccess(makeReq({ actor: clientActor() }), "company-1")).toBe(true);
  });
});

describe("hazard 2: assertCompanyAccess only role-gates writes, and only for viewer", () => {
  it("admits a client GET to any company-scoped core route", () => {
    const req = makeReq({ method: "GET", actor: clientActor() });
    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("admits a client WRITE, because the write gate names only viewer", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const req = makeReq({ method, actor: clientActor() });
      expect(() => assertCompanyAccess(req, "company-1"), `${method} should currently be allowed`).not.toThrow();
    }
  });
});

describe("hazard 3: an unknown role silently normalizes to operator", () => {
  it("normalizeHumanRole('client') returns operator", () => {
    expect(normalizeHumanRole("client")).toBe("operator");
  });

  it("an invite asking for role 'client' mints an operator membership", () => {
    // resolveHumanInviteRole is what POST /join-requests/:id/approve feeds into
    // access.ensureMembership + access.setPrincipalGrants.
    expect(resolveHumanInviteRole({ human: { role: "client" } })).toBe("operator");
  });

  it("and that operator is seeded with tools:admin and users:invite", () => {
    const seeded = grantsForHumanRole(resolveHumanInviteRole({ human: { role: "client" } }))
      .map((grant) => grant.permissionKey);
    expect(seeded).toContain("tools:admin");
    expect(seeded).toContain("users:invite");
    expect(seeded).toContain("agents:create");
  });

  it("the human role list is duplicated in server/src/services/company-member-roles.ts", async () => {
    // Adding "client" to the shared HUMAN_COMPANY_MEMBERSHIP_ROLES does not reach
    // the local copy that normalizeHumanRole actually consults, so the fallback
    // above survives a partial rollout. Guard the duplication explicitly.
    const shared = await import("@paperclipai/shared");
    expect([...shared.HUMAN_COMPANY_MEMBERSHIP_ROLES]).toEqual([
      "owner",
      "admin",
      "operator",
      "viewer",
    ]);
    // Same four values, declared a second time, in the module under test.
    expect(normalizeHumanRole("owner")).toBe("owner");
    expect(normalizeHumanRole("admin")).toBe("admin");
    expect(normalizeHumanRole("operator")).toBe("operator");
    expect(normalizeHumanRole("viewer")).toBe("viewer");
  });
});
