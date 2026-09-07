import { describe, expect, it } from "bun:test";
import {
  authorizeCompanyAccess,
  type HttpActor,
} from "./actor-context.js";

const localBoard: HttpActor = {
  type: "board",
  source: "local_implicit",
  userId: "local-board",
  isInstanceAdmin: true,
};

const memberBoard: HttpActor = {
  type: "board",
  source: "session",
  userId: "user-1",
  companyIds: ["company-a"],
  memberships: [
    { companyId: "company-a", membershipRole: "member", status: "active" },
  ],
  isInstanceAdmin: false,
};

const viewerBoard: HttpActor = {
  ...memberBoard,
  memberships: [
    { companyId: "company-a", membershipRole: "viewer", status: "active" },
  ],
};

const agent: HttpActor = {
  type: "agent",
  source: "agent_key",
  agentId: "agent-1",
  companyId: "company-a",
  onBehalfOfUserId: "user-1",
  onBehalfOfMemberships: [
    { companyId: "company-a", membershipRole: "member", status: "active" },
  ],
};

const agentWithViewer: HttpActor = {
  ...agent,
  onBehalfOfMemberships: [
    { companyId: "company-a", membershipRole: "viewer", status: "active" },
  ],
};

describe("HTTP actor company policy", () => {
  it("allows local trusted board access to any company", () => {
    expect(authorizeCompanyAccess(localBoard, "company-a", "PATCH")).toEqual({
      allowed: true,
    });
  });

  it("allows a board member only in their assigned company", () => {
    expect(authorizeCompanyAccess(memberBoard, "company-a", "GET")).toEqual({
      allowed: true,
    });
    expect(authorizeCompanyAccess(memberBoard, "company-b", "GET")).toEqual({
      allowed: false,
      status: 403,
      message: "User does not have access to this company",
    });
  });

  it("blocks board viewers from mutating their company", () => {
    expect(authorizeCompanyAccess(viewerBoard, "company-a", "PATCH")).toEqual({
      allowed: false,
      status: 403,
      message: "Viewer access is read-only",
    });
    expect(authorizeCompanyAccess(viewerBoard, "company-a", "GET")).toEqual({
      allowed: true,
    });
  });

  it("preserves legacy board access when membership details are absent", () => {
    const boardWithoutMembershipDetails: HttpActor = {
      type: "board",
      source: "session",
      userId: "user-1",
      companyIds: ["company-a"],
      isInstanceAdmin: false,
    };

    expect(authorizeCompanyAccess(boardWithoutMembershipDetails, "company-a", "PATCH")).toEqual({
      allowed: true,
    });
  });


  it("requires agent company identity and responsible-user membership", () => {
    expect(authorizeCompanyAccess(agent, "company-a", "GET")).toEqual({
      allowed: true,
    });
    expect(authorizeCompanyAccess(agent, "company-b", "GET")).toEqual({
      allowed: false,
      status: 403,
      message: "Agent key cannot access another company",
    });
  });

  it("blocks responsible-user viewers from writes but allows safe reads", () => {
    expect(authorizeCompanyAccess(agentWithViewer, "company-a", "GET")).toEqual({
      allowed: true,
    });
    expect(authorizeCompanyAccess(agentWithViewer, "company-a", "POST")).toEqual({
      allowed: false,
      status: 403,
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
      message: "Responsible user is not authorized for write access",
    });
  });

  it("rejects unauthenticated actors", () => {
    const actor: HttpActor = { type: "none", source: "none" };
    expect(authorizeCompanyAccess(actor, "company-a", "GET")).toEqual({
      allowed: false,
      status: 401,
      message: "Unauthorized",
    });
  });
});
