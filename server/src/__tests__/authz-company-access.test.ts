import { describe, expect, it } from "vitest";
import { assertBoardOrgAccess, assertCompanyAccess, assertSameCompanyAgent, hasBoardOrgAccess } from "../routes/authz.js";

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
  it("allows viewer memberships to read", async () => {
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

    await expect(assertCompanyAccess(req, "company-1")).resolves.toBeUndefined();
  });

  it("rejects viewer memberships for writes", async () => {
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

    await expect(assertCompanyAccess(req, "company-1")).rejects.toThrow("Viewer access is read-only");
  });

  it("rejects writes when membership details are present but omit the target company", async () => {
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

    await expect(assertCompanyAccess(req, "company-1")).rejects.toThrow("User does not have active company access");
  });

  it("allows legacy board actors that only provide company ids", async () => {
    const req = makeReq({
      method: "POST",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
      },
    });

    await expect(assertCompanyAccess(req, "company-1")).resolves.toBeUndefined();
  });

  it("rejects signed-in instance admins without explicit company access", async () => {
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

    await expect(assertCompanyAccess(req, "company-1")).rejects.toThrow("User does not have access to this company");
  });

  it("allows local trusted board access without explicit membership", async () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
    });

    await expect(assertCompanyAccess(req, "company-1")).resolves.toBeUndefined();
  });

  it("rejects cross-company agents when CCG is disabled", async () => {
    const previousFlag = process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;
    delete process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;

    const req = makeReq({
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-home",
      },
    });

    await expect(assertCompanyAccess(req, "company-target", {} as never)).rejects.toThrow(
      "Agent key cannot access another company",
    );

    if (previousFlag === undefined) {
      delete process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;
    } else {
      process.env.PAPERCLIP_CROSS_COMPANY_GRANTS = previousFlag;
    }
  });

  it("defers cross-company agents to access.decide when CCG is enabled", async () => {
    const previousFlag = process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;
    process.env.PAPERCLIP_CROSS_COMPANY_GRANTS = "enabled";

    const req = makeReq({
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-home",
      },
    });

    await expect(assertCompanyAccess(req, "company-target", {} as never)).resolves.toBeUndefined();

    if (previousFlag === undefined) {
      delete process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;
    } else {
      process.env.PAPERCLIP_CROSS_COMPANY_GRANTS = previousFlag;
    }
  });
});

describe("assertSameCompanyAgent", () => {
  it("rejects cross-company agents even when CCG is enabled", () => {
    const previousFlag = process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;
    process.env.PAPERCLIP_CROSS_COMPANY_GRANTS = "enabled";

    const req = makeReq({
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-home",
      },
    });

    expect(() => assertSameCompanyAgent(req, "company-target")).toThrow(
      "Agent key cannot access another company",
    );

    if (previousFlag === undefined) {
      delete process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;
    } else {
      process.env.PAPERCLIP_CROSS_COMPANY_GRANTS = previousFlag;
    }
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
