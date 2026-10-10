/**
 * Anchor tests for doc/AUTH-ONBOARDING-VALIDATION-MATRIX.md (company scoping rows).
 */
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "../routes/authz.js";

function expectHttpError(fn: () => void, status: number) {
  try {
    fn();
    expect.fail("expected HttpError");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
  }
}

function boardReq(overrides: Partial<Request["actor"]> = {}): Request {
  return {
    actor: {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...overrides,
    },
  } as unknown as Request;
}

describe("auth validation matrix (authz helpers)", () => {
  it("assertCompanyAccess: none → 401 (matrix B1 / company gate)", () => {
    const req = { actor: { type: "none", source: "none" } } as unknown as Request;
    expectHttpError(() => assertCompanyAccess(req, "company-1"), 401);
  });

  it("assertCompanyAccess: agent wrong company → 403 (matrix A3)", () => {
    const req = {
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-a",
        source: "agent_key",
      },
    } as unknown as Request;
    expectHttpError(() => assertCompanyAccess(req, "company-b"), 403);
  });

  it("assertCompanyAccess: session board missing membership → 403", () => {
    const req = boardReq({ companyIds: ["company-other"] });
    expectHttpError(() => assertCompanyAccess(req, "company-1"), 403);
  });

  it("assertCompanyAccess: session board with membership → ok", () => {
    const req = boardReq({ companyIds: ["company-1"] });
    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("assertCompanyAccess: local_implicit board → ok for any companyId (matrix B4)", () => {
    const req = {
      actor: {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
    } as unknown as Request;
    expect(() => assertCompanyAccess(req, "any-company-id")).not.toThrow();
  });

  it("assertBoard: agent → 403", () => {
    const req = {
      actor: { type: "agent", agentId: "a1", companyId: "c1", source: "agent_key" },
    } as unknown as Request;
    expectHttpError(() => assertBoard(req), 403);
  });
});
