import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { assertBoardOrgAccess, assertCompanyAccess, hasBoardOrgAccess, hasCompanyAccess } from "../routes/authz.js";

function makeReq(input: {
  method?: string;
  actor: Express.Request["actor"];
}) {
  return {
    method: input.method ?? "GET",
    actor: input.actor,
  } as Express.Request;
}

describe("assertCompanyAccess", () => {
  it("allows viewer memberships to read", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [
          { companyId: "company-1", membershipRole: "viewer", status: "active" },
        ],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("rejects viewer memberships for writes", () => {
    const req = makeReq({
      method: "PATCH",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [
          { companyId: "company-1", membershipRole: "viewer", status: "active" },
        ],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow("Viewer access is read-only");
  });

  it("rejects writes when membership details are present but omit the target company", () => {
    const req = makeReq({
      method: "POST",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow("User does not have active company access");
  });

  it("allows legacy board actors that only provide company ids", () => {
    const req = makeReq({
      method: "POST",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("rejects signed-in instance admins without explicit company access", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [],
        memberships: [],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow("User does not have access to this company");
  });

  it("allows local trusted board access without explicit membership", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("fails closed when an on-behalf-of agent lacks a responsible user membership snapshot", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        onBehalfOfUserId: "user-1",
        onBehalfOfMemberships: [],
        source: "agent_jwt",
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow(HttpError);
    try {
      assertCompanyAccess(req, "company-1");
    } catch (err) {
      expect((err as HttpError).details).toMatchObject({ code: "RESPONSIBLE_USER_UNAVAILABLE" });
    }
  });

  it("rejects on-behalf-of agent writes when the responsible user is read-only", () => {
    const req = makeReq({
      method: "PATCH",
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        onBehalfOfUserId: "user-1",
        onBehalfOfMemberships: [
          { companyId: "company-1", membershipRole: "viewer", status: "active" },
        ],
        source: "agent_jwt",
      },
    });

    try {
      assertCompanyAccess(req, "company-1");
    } catch (err) {
      expect((err as HttpError).status).toBe(403);
      expect((err as HttpError).details).toMatchObject({ code: "RESPONSIBLE_USER_UNAUTHORIZED" });
      return;
    }
    throw new Error("Expected responsible-user company access denial");
  });

  it("logs only in shadow mode for responsible-user company access denials", () => {
    const previous = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW;
    process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW = "true";
    try {
      const req = makeReq({
        method: "PATCH",
        actor: {
          type: "agent",
          agentId: "agent-1",
          companyId: "company-1",
          onBehalfOfUserId: "user-1",
          onBehalfOfMemberships: [],
          source: "agent_jwt",
        },
      });

      expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW;
      else process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW = previous;
    }
  });

  it("allows on-behalf-of agent writes for active non-viewer responsible users", () => {
    const req = makeReq({
      method: "PATCH",
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        onBehalfOfUserId: "user-1",
        onBehalfOfMemberships: [
          { companyId: "company-1", membershipRole: "operator", status: "active" },
        ],
        source: "agent_jwt",
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });
});

describe("hasCompanyAccess", () => {
  it("allows members of the company", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
      },
    });

    expect(hasCompanyAccess(req, "company-1")).toBe(true);
  });

  it("denies users from other companies", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
      },
    });

    expect(hasCompanyAccess(req, "company-2")).toBe(false);
  });

  it("denies signed-in instance admins without explicit company access, matching assertCompanyAccess", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [],
        memberships: [],
      },
    });

    expect(hasCompanyAccess(req, "company-1")).toBe(false);
    expect(() => assertCompanyAccess(req, "company-1")).toThrow("User does not have access to this company");
  });

  it("allows local trusted board access without explicit membership", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
    });

    expect(hasCompanyAccess(req, "company-1")).toBe(true);
  });

  it("scopes agent actors to their own company", () => {
    const agent = { type: "agent", agentId: "agent-1", companyId: "company-1" } as const;

    expect(hasCompanyAccess(makeReq({ actor: agent }), "company-1")).toBe(true);
    expect(hasCompanyAccess(makeReq({ actor: agent }), "company-2")).toBe(false);
  });

  it("denies unauthenticated actors", () => {
    const req = makeReq({ actor: { type: "none" } });

    expect(hasCompanyAccess(req, "company-1")).toBe(false);
  });
});

describe("assertBoardOrgAccess", () => {
  it("allows signed-in board users with active company access", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
        isInstanceAdmin: false,
      },
    });

    expect(hasBoardOrgAccess(req)).toBe(true);
    expect(() => assertBoardOrgAccess(req)).not.toThrow();
  });

  it("allows instance admins without company memberships", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "admin-1",
        source: "session",
        companyIds: [],
        memberships: [],
        isInstanceAdmin: true,
      },
    });

    expect(hasBoardOrgAccess(req)).toBe(true);
    expect(() => assertBoardOrgAccess(req)).not.toThrow();
  });

  it("rejects signed-in users without company access or instance admin rights", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "outsider-1",
        source: "session",
        companyIds: [],
        memberships: [],
        isInstanceAdmin: false,
      },
    });

    expect(hasBoardOrgAccess(req)).toBe(false);
    expect(() => assertBoardOrgAccess(req)).toThrow("Company membership or instance admin access required");
  });
});
