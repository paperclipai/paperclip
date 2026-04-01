import { describe, expect, it, vi } from "vitest";
import { assertCompanyAccess } from "../routes/authz.ts";
import type { Request } from "express";

function makeRequest(overrides: Partial<Request["actor"]> = {}): Request {
  return {
    actor: {
      type: "board",
      userId: "user-a",
      companyIds: ["company-a"],
      isInstanceAdmin: false,
      source: "session",
      ...overrides,
    },
  } as unknown as Request;
}

describe("Tenant Isolation — assertCompanyAccess", () => {
  it("allows user to access their own company", () => {
    const req = makeRequest({ companyIds: ["company-a"] });
    expect(() => assertCompanyAccess(req, "company-a")).not.toThrow();
  });

  it("blocks user from accessing a company they are not a member of", () => {
    const req = makeRequest({ companyIds: ["company-a"] });
    expect(() => assertCompanyAccess(req, "company-b")).toThrow(/does not have access/i);
  });

  it("blocks user with empty companyIds from accessing any company", () => {
    const req = makeRequest({ companyIds: [] });
    expect(() => assertCompanyAccess(req, "company-a")).toThrow(/does not have access/i);
  });

  it("allows instance admin to access any company", () => {
    const req = makeRequest({ isInstanceAdmin: true, companyIds: ["company-a"] });
    expect(() => assertCompanyAccess(req, "company-b")).not.toThrow();
  });

  it("allows local_implicit source to access any company", () => {
    const req = makeRequest({ source: "local_implicit", companyIds: [] });
    expect(() => assertCompanyAccess(req, "any-company")).not.toThrow();
  });

  it("blocks agent key from accessing another company", () => {
    const req = makeRequest({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-a",
    }) as Request;
    expect(() => assertCompanyAccess(req, "company-b")).toThrow(/Agent key cannot access another company/i);
  });

  it("allows agent key to access its own company", () => {
    const req = makeRequest({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-a",
    }) as Request;
    expect(() => assertCompanyAccess(req, "company-a")).not.toThrow();
  });

  it("blocks actor type 'none' from accessing any company", () => {
    const req = makeRequest({ type: "none" }) as Request;
    expect(() => assertCompanyAccess(req, "company-a")).toThrow();
  });
});

describe("Tenant Isolation — cross-tenant access scenarios", () => {
  const companyA = "company-a-id";
  const companyB = "company-b-id";

  const userAReq = makeRequest({ userId: "user-a", companyIds: [companyA] });
  const userBReq = makeRequest({ userId: "user-b", companyIds: [companyB] });

  it("user A cannot access company B resources", () => {
    // Agents
    expect(() => assertCompanyAccess(userAReq, companyB)).toThrow();
    // Issues
    expect(() => assertCompanyAccess(userAReq, companyB)).toThrow();
    // Projects
    expect(() => assertCompanyAccess(userAReq, companyB)).toThrow();
    // Goals
    expect(() => assertCompanyAccess(userAReq, companyB)).toThrow();
    // Knowledge Base
    expect(() => assertCompanyAccess(userAReq, companyB)).toThrow();
    // Cost data
    expect(() => assertCompanyAccess(userAReq, companyB)).toThrow();
    // Activity logs
    expect(() => assertCompanyAccess(userAReq, companyB)).toThrow();
    // Secrets
    expect(() => assertCompanyAccess(userAReq, companyB)).toThrow();
  });

  it("user B cannot access company A resources", () => {
    expect(() => assertCompanyAccess(userBReq, companyA)).toThrow();
  });

  it("user A CAN access company A", () => {
    expect(() => assertCompanyAccess(userAReq, companyA)).not.toThrow();
  });

  it("user B CAN access company B", () => {
    expect(() => assertCompanyAccess(userBReq, companyB)).not.toThrow();
  });

  it("multi-company user can access both companies", () => {
    const multiReq = makeRequest({
      userId: "user-multi",
      companyIds: [companyA, companyB],
    });
    expect(() => assertCompanyAccess(multiReq, companyA)).not.toThrow();
    expect(() => assertCompanyAccess(multiReq, companyB)).not.toThrow();
  });

  it("multi-company user cannot access a third company", () => {
    const multiReq = makeRequest({
      userId: "user-multi",
      companyIds: [companyA, companyB],
    });
    expect(() => assertCompanyAccess(multiReq, "company-c-id")).toThrow();
  });
});
