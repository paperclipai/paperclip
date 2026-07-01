import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  assertBoard,
  assertCompanyAccess,
  getActorInfo,
} from "../routes/authz.js";

// Mirror of the actor shape declared in server/src/types/express.d.ts.
// Defined locally so this test does not depend on the global Express namespace
// augmentation being visible at type-check time.
type Actor = {
  type: "board" | "agent" | "none";
  userId?: string;
  agentId?: string;
  companyId?: string;
  companyIds?: string[];
  isInstanceAdmin?: boolean;
  keyId?: string;
  runId?: string;
  source?: "local_implicit" | "session" | "agent_key" | "agent_jwt" | "none";
};

// Builds a minimal fake Request with only the actor field populated.
// All auth functions in authz.ts only read req.actor, so this is sufficient.
function buildReq(actor: Actor): Request {
  return { actor } as unknown as Request;
}

describe("auth validation matrix (#693)", () => {
  // ── Criterion: Unauthenticated access to protected board routes is denied ────

  describe("unauthenticated actor (type=none)", () => {
    const req = buildReq({ type: "none", source: "none" });

    it("assertCompanyAccess throws 401 Unauthorized", () => {
      expect(() => assertCompanyAccess(req, "company-1")).toThrow("Unauthorized");
    });

    it("getActorInfo throws 401 Unauthorized", () => {
      expect(() => getActorInfo(req)).toThrow("Unauthorized");
    });

    it("assertBoard throws 403 -- board access required (not a 401 passthrough)", () => {
      expect(() => assertBoard(req)).toThrow("Board access required");
    });
  });

  // ── Criterion: Agent JWT is company-scoped; cross-company access returns 403 ─

  describe("agent actor -- company scoping", () => {
    it("same-company agent passes assertCompanyAccess", () => {
      const req = buildReq({ type: "agent", companyId: "company-1", source: "agent_jwt" });
      expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
    });

    it("cross-company agent throws 403 with explicit message", () => {
      const req = buildReq({ type: "agent", companyId: "company-1", source: "agent_jwt" });
      expect(() => assertCompanyAccess(req, "company-2")).toThrow(
        "Agent key cannot access another company",
      );
    });

    it("agent with api key (source=agent_key) also enforces company scope", () => {
      const req = buildReq({ type: "agent", companyId: "company-1", source: "agent_key" });
      expect(() => assertCompanyAccess(req, "company-other")).toThrow(
        "Agent key cannot access another company",
      );
    });

    it("agent actor cannot reach board-only routes -- assertBoard throws 403", () => {
      const req = buildReq({ type: "agent", companyId: "company-1", source: "agent_jwt" });
      expect(() => assertBoard(req)).toThrow("Board access required");
    });

    it("getActorInfo returns scoped agent identity with agentId and runId", () => {
      const req = buildReq({
        type: "agent",
        agentId: "agent-42",
        companyId: "company-1",
        runId: "run-99",
        source: "agent_jwt",
      });
      expect(getActorInfo(req)).toEqual({
        actorType: "agent",
        actorId: "agent-42",
        agentId: "agent-42",
        runId: "run-99",
      });
    });

    it("agent without runId still produces valid scoped identity", () => {
      const req = buildReq({
        type: "agent",
        agentId: "agent-7",
        companyId: "company-1",
        source: "agent_key",
      });
      const info = getActorInfo(req);
      expect(info.actorType).toBe("agent");
      expect(info.agentId).toBe("agent-7");
      expect(info.runId).toBeNull();
    });
  });

  // ── Criterion: Bootstrap CEO invite is limited to intended setup paths ────────
  // The local_trusted / local_implicit source is the bootstrap path. It grants
  // unrestricted board access without session auth -- it is auditable because the
  // source field is always "local_implicit" and isInstanceAdmin is always true.

  describe("local_trusted bootstrap board (source=local_implicit)", () => {
    const req = buildReq({
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    });

    it("passes assertCompanyAccess for any company -- bootstrap is unrestricted", () => {
      expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
      expect(() => assertCompanyAccess(req, "company-999")).not.toThrow();
    });

    it("passes assertBoard", () => {
      expect(() => assertBoard(req)).not.toThrow();
    });

    it("getActorInfo returns board identity -- bootstrap identity is auditable", () => {
      expect(getActorInfo(req)).toMatchObject({ actorType: "user", actorId: "local-board" });
    });
  });

  // ── Criterion: Board actor is company-scoped in authenticated mode ────────────

  describe("authenticated board actor -- company membership scoping", () => {
    it("board member with company in membership list passes assertCompanyAccess", () => {
      const req = buildReq({
        type: "board",
        userId: "user-1",
        companyIds: ["company-1", "company-2"],
        isInstanceAdmin: false,
        source: "session",
      });
      expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
      expect(() => assertCompanyAccess(req, "company-2")).not.toThrow();
    });

    it("board member without company in membership list throws 403", () => {
      const req = buildReq({
        type: "board",
        userId: "user-1",
        companyIds: ["company-1"],
        isInstanceAdmin: false,
        source: "session",
      });
      expect(() => assertCompanyAccess(req, "company-99")).toThrow(
        "User does not have access to this company",
      );
    });

    it("board member with empty company list is denied all company access", () => {
      const req = buildReq({
        type: "board",
        userId: "user-1",
        companyIds: [],
        isInstanceAdmin: false,
        source: "session",
      });
      expect(() => assertCompanyAccess(req, "company-1")).toThrow(
        "User does not have access to this company",
      );
    });

    it("instance admin board passes assertCompanyAccess for any company regardless of membership list", () => {
      const req = buildReq({
        type: "board",
        userId: "user-admin",
        companyIds: [],
        isInstanceAdmin: true,
        source: "session",
      });
      expect(() => assertCompanyAccess(req, "company-any")).not.toThrow();
    });

    it("board member with single company in membership list passes assertCompanyAccess", () => {
      const req = buildReq({
        type: "board",
        userId: "user-1",
        companyIds: ["company-1"],
        isInstanceAdmin: false,
        source: "session",
      });
      expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
    });
  });

  // ── Criterion: Invite claim produces a valid scoped identity ─────────────────

  describe("getActorInfo -- scoped identity after onboarding", () => {
    it("board actor returns user actorType with userId", () => {
      const req = buildReq({
        type: "board",
        userId: "user-42",
        isInstanceAdmin: false,
        source: "session",
      });
      expect(getActorInfo(req)).toEqual({
        actorType: "user",
        actorId: "user-42",
        agentId: null,
        runId: null,
      });
    });

    it("board actor with runId includes runId in identity", () => {
      const req = buildReq({
        type: "board",
        userId: "user-5",
        runId: "run-abc",
        isInstanceAdmin: false,
        source: "session",
      });
      expect(getActorInfo(req)).toMatchObject({ runId: "run-abc" });
    });
  });

  // ── Criterion: isInstanceAdmin bypass is encoded in assertCompanyAccess ───────
  // assertCompanyAccess skips the company-membership check when isInstanceAdmin
  // is true, so instance admins are never locked out of a company they need to
  // manage. This is the correct access-control gate for bootstrap / admin paths.

  describe("instance admin bypass in assertCompanyAccess", () => {
    it("regular board member without admin flag is denied access to unlisted company", () => {
      const req = buildReq({
        type: "board",
        userId: "user-1",
        companyIds: [],
        isInstanceAdmin: false,
        source: "session",
      });
      expect(() => assertCompanyAccess(req, "company-x")).toThrow(
        "User does not have access to this company",
      );
    });

    it("board member with isInstanceAdmin=true bypasses company membership check", () => {
      const req = buildReq({
        type: "board",
        userId: "user-1",
        companyIds: [],
        isInstanceAdmin: true,
        source: "session",
      });
      expect(() => assertCompanyAccess(req, "company-x")).not.toThrow();
    });

    it("agent actor has no instance admin bypass -- company scope always enforced", () => {
      const req = buildReq({ type: "agent", companyId: "company-1", source: "agent_jwt" });
      expect(() => assertCompanyAccess(req, "company-other")).toThrow(
        "Agent key cannot access another company",
      );
    });

    it("unauthenticated actor is always denied regardless of company", () => {
      const req = buildReq({ type: "none", source: "none" });
      expect(() => assertCompanyAccess(req, "company-1")).toThrow("Unauthorized");
    });
  });
});
