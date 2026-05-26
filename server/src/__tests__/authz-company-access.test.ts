import { describe, expect, it, vi } from "vitest";
import { assertBoardOrgAccess, assertCompanyAccess, hasBoardOrgAccess } from "../routes/authz.js";

function makeReq(input: {
  method?: string;
  actor: Express.Request["actor"];
  delegateGrant?: Express.Request["delegateGrant"];
}) {
  return {
    method: input.method ?? "GET",
    actor: input.actor,
    delegateGrant: input.delegateGrant ?? null,
  } as Express.Request;
}

// Stub DB used for board-path tests where the DB is never consulted.
const noopDb = {} as any;

describe("assertCompanyAccess — board paths (no DB access)", () => {
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

    await expect(assertCompanyAccess(req, "company-1", noopDb)).resolves.toBeUndefined();
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

    await expect(assertCompanyAccess(req, "company-1", noopDb)).rejects.toMatchObject({
      message: "Viewer access is read-only",
    });
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

    await expect(assertCompanyAccess(req, "company-1", noopDb)).rejects.toMatchObject({
      message: "User does not have active company access",
    });
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

    await expect(assertCompanyAccess(req, "company-1", noopDb)).resolves.toBeUndefined();
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

    await expect(assertCompanyAccess(req, "company-1", noopDb)).rejects.toMatchObject({
      message: "User does not have access to this company",
    });
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

    await expect(assertCompanyAccess(req, "company-1", noopDb)).resolves.toBeUndefined();
  });
});

describe("assertCompanyAccess — agent home-company path (no DB access)", () => {
  it("allows an agent accessing its own company without DB lookup", async () => {
    const req = makeReq({
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
      },
    });

    await expect(assertCompanyAccess(req, "company-1", noopDb)).resolves.toBeUndefined();
  });
});

describe("assertCompanyAccess — cross-company agent delegate path", () => {
  function makeAgentReq(agentId: string, homeCompanyId: string) {
    return makeReq({
      actor: {
        type: "agent",
        agentId,
        companyId: homeCompanyId,
      },
    });
  }

  function makeDbWithGrant(grant: { id: string; scopes: string[] } | null) {
    const limitMock = vi.fn().mockResolvedValue(grant ? [grant] : []);
    const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    const selectMock = vi.fn().mockReturnValue({ from: fromMock });
    return { select: selectMock } as any;
  }

  it("allows cross-company access when an active grant exists", async () => {
    const req = makeAgentReq("agent-1", "company-home");
    const db = makeDbWithGrant({ id: "grant-id-1", scopes: ["read", "write"] });

    await expect(assertCompanyAccess(req, "company-host", db)).resolves.toBeUndefined();
    expect(req.delegateGrant).toEqual({ grantId: "grant-id-1", hostCompanyId: "company-host" });
  });

  it("rejects cross-company access when no active grant exists", async () => {
    const req = makeAgentReq("agent-1", "company-home");
    const db = makeDbWithGrant(null);

    await expect(assertCompanyAccess(req, "company-host", db)).rejects.toMatchObject({
      message: "Agent key cannot access another company",
    });
  });

  it("rejects cross-company access when grant exists but required scope is missing", async () => {
    const req = makeAgentReq("agent-1", "company-home");
    const db = makeDbWithGrant({ id: "grant-id-2", scopes: ["read"] });

    await expect(
      assertCompanyAccess(req, "company-host", db, { requiredScope: "write" }),
    ).rejects.toMatchObject({
      message: "Delegate grant does not include required scope: write",
    });
  });

  it("allows cross-company access when required scope is present", async () => {
    const req = makeAgentReq("agent-1", "company-home");
    const db = makeDbWithGrant({ id: "grant-id-3", scopes: ["read", "write"] });

    await expect(
      assertCompanyAccess(req, "company-host", db, { requiredScope: "write" }),
    ).resolves.toBeUndefined();
  });

  it("rejects agent with no agentId", async () => {
    const req = makeReq({
      actor: {
        type: "agent",
        agentId: undefined,
        companyId: "company-home",
      },
    });

    await expect(assertCompanyAccess(req, "company-host", noopDb)).rejects.toMatchObject({
      message: "Agent key cannot access another company",
    });
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
