import { createHash } from "node:crypto";
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Mock } from "vitest";

// ---- mock declarations must come before the module under test is imported ----

vi.mock("../agent-auth-jwt.js", () => ({
  verifyLocalAgentJwt: vi.fn(),
}));

vi.mock("../services/board-auth.js", () => ({
  // boardAuthService is called once with `db` at construction time.
  // We expose the mock methods on a stable object so tests can override them.
  boardAuthService: vi.fn(() => ({
    findBoardApiKeyByToken: vi.fn(),
    resolveBoardAccess: vi.fn(),
    touchBoardApiKey: vi.fn(),
  })),
}));

vi.mock("./logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ---- import mocks so tests can configure them ----
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { boardAuthService } from "../services/board-auth.js";
import { actorMiddleware } from "./auth.js";

// ---- helpers ----

function sha256(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a minimal Express-like request. */
function mockReq(headers: Record<string, string> = {}): any {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  return {
    actor: { type: "none", source: "none" },
    header: (name: string) => lower[name.toLowerCase()],
    headers: lower,
    method: "GET",
    originalUrl: "/test",
  };
}

function mockRes(): any {
  return {};
}

// ---- DB factory ----
// The middleware directly calls db.select().from().where().then() and
// db.update().set().where() for agent API keys and agent rows.
// We use a flexible factory that lets each test override what rows come back.

type SelectSetup = { rows: any[] }[];

function makeMockDb(selectSetups: SelectSetup = []) {
  let callIndex = -1;

  const db: any = {
    select: vi.fn(() => {
      callIndex++;
      const setup = selectSetups[callIndex];
      const rows = setup?.rows ?? [];
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnValue({
          then: vi.fn((cb: (r: any[]) => any) => Promise.resolve(cb(rows))),
        }),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(undefined)),
      })),
    })),
  };

  return db;
}

// Convenience: build the middleware with given mode and optional resolveSession
function makeMiddleware(
  deploymentMode: string,
  resolveSession?: () => Promise<any>,
  db?: any,
) {
  const database = db ?? makeMockDb();
  return actorMiddleware(database, { deploymentMode, resolveSession });
}

// Run the middleware and return the mutated req
async function run(mw: any, req: any) {
  const next = vi.fn();
  await mw(req, mockRes(), next);
  expect(next).toHaveBeenCalledOnce();
  return req;
}

// ---- tests ----

describe("actorMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset boardAuthService mock to return no-op stubs by default
    (boardAuthService as Mock).mockReturnValue({
      findBoardApiKeyByToken: vi.fn().mockResolvedValue(null),
      resolveBoardAccess: vi.fn().mockResolvedValue({ user: null, companyIds: [], isInstanceAdmin: false }),
      touchBoardApiKey: vi.fn().mockResolvedValue(undefined),
    });
  });

  // --------------------------------------------------------------------------
  // 1. local_trusted mode
  // --------------------------------------------------------------------------

  describe("local_trusted mode", () => {
    it("sets actor to board with userId=local-board and isInstanceAdmin=true", async () => {
      const mw = makeMiddleware("local_trusted");
      const req = mockReq();
      await run(mw, req);

      expect(req.actor).toMatchObject({
        type: "board",
        userId: "local-board",
        isInstanceAdmin: true,
        source: "local_implicit",
      });
    });

    it("calls next()", async () => {
      const mw = makeMiddleware("local_trusted");
      const next = vi.fn();
      await mw(mockReq(), mockRes(), next);
      expect(next).toHaveBeenCalledOnce();
    });

    it("propagates x-ironworks-run-id header to actor", async () => {
      // In local_trusted mode there is no bearer header, so the code falls through
      // the no-bearer branch and reaches line 74: `if (runIdHeader) req.actor.runId = runIdHeader`.
      const mw = makeMiddleware("local_trusted");
      const req = mockReq({ "x-ironworks-run-id": "run-abc" });
      await run(mw, req);

      expect(req.actor.type).toBe("board");
      expect(req.actor.runId).toBe("run-abc");
    });
  });

  // --------------------------------------------------------------------------
  // 2. No auth header + authenticated mode with session
  // --------------------------------------------------------------------------

  describe("no auth header – authenticated mode", () => {
    it("sets actor from a valid session with userId, companyIds, isInstanceAdmin", async () => {
      const db = makeMockDb([
        { rows: [{ id: "role-1" }] }, // instanceUserRoles -> has admin role
        { rows: [{ companyId: "company-1" }, { companyId: "company-2" }] }, // companyMemberships
      ]);

      const resolveSession = vi.fn().mockResolvedValue({
        user: { id: "user-123" },
        session: {},
      });

      const mw = makeMiddleware("authenticated", resolveSession, db);
      const req = mockReq(); // no authorization header
      await run(mw, req);

      expect(req.actor).toMatchObject({
        type: "board",
        userId: "user-123",
        companyIds: ["company-1", "company-2"],
        isInstanceAdmin: true,
        source: "session",
      });
    });

    it("sets isInstanceAdmin=false when no instance_admin role exists", async () => {
      const db = makeMockDb([
        { rows: [] }, // instanceUserRoles -> no admin role
        { rows: [{ companyId: "co-1" }] }, // companyMemberships
      ]);

      const resolveSession = vi.fn().mockResolvedValue({ user: { id: "user-999" } });
      const mw = makeMiddleware("authenticated", resolveSession, db);
      const req = mockReq();
      await run(mw, req);

      expect(req.actor).toMatchObject({
        type: "board",
        userId: "user-999",
        isInstanceAdmin: false,
        source: "session",
      });
    });

    it("actor stays 'none' when resolveSession throws", async () => {
      const resolveSession = vi.fn().mockRejectedValue(new Error("session error"));
      const mw = makeMiddleware("authenticated", resolveSession);
      const req = mockReq();
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });

    it("actor stays 'none' when session has no user", async () => {
      const resolveSession = vi.fn().mockResolvedValue({ session: {} }); // user is absent
      const mw = makeMiddleware("authenticated", resolveSession);
      const req = mockReq();
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });

    it("actor stays 'none' when session.user.id is falsy", async () => {
      const resolveSession = vi.fn().mockResolvedValue({ user: { id: "" } });
      const mw = makeMiddleware("authenticated", resolveSession);
      const req = mockReq();
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });

    it("propagates run-id when session resolves", async () => {
      const db = makeMockDb([
        { rows: [] },
        { rows: [{ companyId: "co-x" }] },
      ]);

      const resolveSession = vi.fn().mockResolvedValue({ user: { id: "uid" } });
      const mw = makeMiddleware("authenticated", resolveSession, db);
      const req = mockReq({ "x-ironworks-run-id": "run-xyz" });
      await run(mw, req);

      expect(req.actor.runId).toBe("run-xyz");
    });

    it("propagates run-id to actor.none when session resolution fails", async () => {
      const resolveSession = vi.fn().mockResolvedValue(null);
      const mw = makeMiddleware("authenticated", resolveSession);
      const req = mockReq({ "x-ironworks-run-id": "run-fallback" });
      await run(mw, req);

      expect(req.actor.type).toBe("none");
      expect(req.actor.runId).toBe("run-fallback");
    });
  });

  // --------------------------------------------------------------------------
  // 3. Board API key
  // --------------------------------------------------------------------------

  describe("board API key", () => {
    it("sets actor type=board with correct userId/companyIds when key is valid", async () => {
      const boardKey = { id: "bk-1", userId: "user-board" };
      const access = {
        user: { id: "user-board", name: "Test User", email: "t@t.com" },
        companyIds: ["co-a", "co-b"],
        isInstanceAdmin: false,
      };

      const boardServiceMock = {
        findBoardApiKeyByToken: vi.fn().mockResolvedValue(boardKey),
        resolveBoardAccess: vi.fn().mockResolvedValue(access),
        touchBoardApiKey: vi.fn().mockResolvedValue(undefined),
      };
      (boardAuthService as Mock).mockReturnValue(boardServiceMock);

      const mw = makeMiddleware("unauthenticated");
      const req = mockReq({ authorization: "Bearer my-board-token" });
      await run(mw, req);

      expect(req.actor).toMatchObject({
        type: "board",
        userId: "user-board",
        companyIds: ["co-a", "co-b"],
        isInstanceAdmin: false,
        keyId: "bk-1",
        source: "board_key",
      });
    });

    it("calls touchBoardApiKey on a valid board key", async () => {
      const touchFn = vi.fn().mockResolvedValue(undefined);
      const boardServiceMock = {
        findBoardApiKeyByToken: vi.fn().mockResolvedValue({ id: "bk-2", userId: "u2" }),
        resolveBoardAccess: vi.fn().mockResolvedValue({
          user: { id: "u2" },
          companyIds: [],
          isInstanceAdmin: false,
        }),
        touchBoardApiKey: touchFn,
      };
      (boardAuthService as Mock).mockReturnValue(boardServiceMock);

      const mw = makeMiddleware("unauthenticated");
      await run(mw, mockReq({ authorization: "Bearer tok-x" }));

      expect(touchFn).toHaveBeenCalledWith("bk-2");
    });

    it("falls through when board key is found but access.user is null", async () => {
      const boardServiceMock = {
        findBoardApiKeyByToken: vi.fn().mockResolvedValue({ id: "bk-3", userId: "ghost" }),
        resolveBoardAccess: vi.fn().mockResolvedValue({ user: null, companyIds: [], isInstanceAdmin: false }),
        touchBoardApiKey: vi.fn(),
      };
      (boardAuthService as Mock).mockReturnValue(boardServiceMock);

      // No agent key match either
      const db = makeMockDb([{ rows: [] }]); // agentApiKeys lookup returns nothing
      (verifyLocalAgentJwt as Mock).mockReturnValue(null);

      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: "Bearer tok-ghost" });
      await run(mw, req);

      // Should not be set to board from the board key path
      expect(req.actor.type).toBe("none");
    });

    it("propagates run-id on valid board key", async () => {
      const boardServiceMock = {
        findBoardApiKeyByToken: vi.fn().mockResolvedValue({ id: "bk-4", userId: "uid" }),
        resolveBoardAccess: vi.fn().mockResolvedValue({ user: { id: "uid" }, companyIds: [], isInstanceAdmin: false }),
        touchBoardApiKey: vi.fn().mockResolvedValue(undefined),
      };
      (boardAuthService as Mock).mockReturnValue(boardServiceMock);

      const mw = makeMiddleware("unauthenticated");
      const req = mockReq({ authorization: "Bearer tok", "x-ironworks-run-id": "run-board" });
      await run(mw, req);

      expect(req.actor.runId).toBe("run-board");
    });
  });

  // --------------------------------------------------------------------------
  // 4. Agent API key via hash
  // --------------------------------------------------------------------------

  describe("agent API key (hash lookup)", () => {
    // Helper: token whose hash matches, no board key match
    function setupAgentKeyTest(agentKeyRow: any, agentRow: any) {
      // board key lookup returns null
      const boardServiceMock = {
        findBoardApiKeyByToken: vi.fn().mockResolvedValue(null),
        resolveBoardAccess: vi.fn(),
        touchBoardApiKey: vi.fn(),
      };
      (boardAuthService as Mock).mockReturnValue(boardServiceMock);

      // verifyLocalAgentJwt is only reached when no key row was found
      (verifyLocalAgentJwt as Mock).mockReturnValue(null);

      const selectSetups: SelectSetup = [
        { rows: agentKeyRow ? [agentKeyRow] : [] }, // agentApiKeys select
        { rows: agentRow ? [agentRow] : [] },        // agents select
      ];

      return makeMockDb(selectSetups);
    }

    it("sets actor type=agent with agentId/companyId on valid key", async () => {
      const token = "my-agent-api-token";
      const keyRow = {
        id: "ak-1",
        agentId: "agent-1",
        companyId: "co-1",
        keyHash: sha256(token),
        revokedAt: null,
      };
      const agentRow = { id: "agent-1", companyId: "co-1", status: "active" };

      const db = setupAgentKeyTest(keyRow, agentRow);
      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: `Bearer ${token}` });
      await run(mw, req);

      expect(req.actor).toMatchObject({
        type: "agent",
        agentId: "agent-1",
        companyId: "co-1",
        keyId: "ak-1",
        source: "agent_key",
      });
    });

    it("calls db.update to set lastUsedAt on a valid key", async () => {
      const token = "update-test-token";
      const keyRow = { id: "ak-upd", agentId: "a-upd", companyId: "co-upd", keyHash: sha256(token), revokedAt: null };
      const agentRow = { id: "a-upd", companyId: "co-upd", status: "active" };

      const boardServiceMock = {
        findBoardApiKeyByToken: vi.fn().mockResolvedValue(null),
        resolveBoardAccess: vi.fn(),
        touchBoardApiKey: vi.fn(),
      };
      (boardAuthService as Mock).mockReturnValue(boardServiceMock);
      (verifyLocalAgentJwt as Mock).mockReturnValue(null);

      const selectSetups: SelectSetup = [{ rows: [keyRow] }, { rows: [agentRow] }];
      const db = makeMockDb(selectSetups);

      const mw = makeMiddleware("unauthenticated", undefined, db);
      await run(mw, mockReq({ authorization: `Bearer ${token}` }));

      expect(db.update).toHaveBeenCalled();
    });

    it("actor stays 'none' when agent is terminated", async () => {
      const token = "terminated-agent-token";
      const keyRow = { id: "ak-t", agentId: "agent-t", companyId: "co-t", keyHash: sha256(token), revokedAt: null };
      const agentRow = { id: "agent-t", companyId: "co-t", status: "terminated" };

      const db = setupAgentKeyTest(keyRow, agentRow);
      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: `Bearer ${token}` });
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });

    it("actor stays 'none' when agent is pending_approval", async () => {
      const token = "pending-agent-token";
      const keyRow = { id: "ak-p", agentId: "agent-p", companyId: "co-p", keyHash: sha256(token), revokedAt: null };
      const agentRow = { id: "agent-p", companyId: "co-p", status: "pending_approval" };

      const db = setupAgentKeyTest(keyRow, agentRow);
      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: `Bearer ${token}` });
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });

    it("actor stays 'none' when agent record not found", async () => {
      const token = "missing-agent-token";
      const keyRow = { id: "ak-m", agentId: "agent-missing", companyId: "co-m", keyHash: sha256(token), revokedAt: null };

      const db = setupAgentKeyTest(keyRow, null); // no agent row
      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: `Bearer ${token}` });
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });

    it("propagates run-id from header on valid agent key", async () => {
      const token = "run-id-agent-token";
      const keyRow = { id: "ak-r", agentId: "agent-r", companyId: "co-r", keyHash: sha256(token), revokedAt: null };
      const agentRow = { id: "agent-r", companyId: "co-r", status: "active" };

      const db = setupAgentKeyTest(keyRow, agentRow);
      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: `Bearer ${token}`, "x-ironworks-run-id": "run-agent" });
      await run(mw, req);

      expect(req.actor.runId).toBe("run-agent");
    });
  });

  // --------------------------------------------------------------------------
  // 5. Agent JWT
  // --------------------------------------------------------------------------

  describe("agent JWT", () => {
    function setupJwtTest(jwtClaims: any | null, agentRow: any | null) {
      const boardServiceMock = {
        findBoardApiKeyByToken: vi.fn().mockResolvedValue(null),
        resolveBoardAccess: vi.fn(),
        touchBoardApiKey: vi.fn(),
      };
      (boardAuthService as Mock).mockReturnValue(boardServiceMock);
      (verifyLocalAgentJwt as Mock).mockReturnValue(jwtClaims);

      // When JWT path is taken, agentApiKeys lookup returns empty, then agents lookup fires
      const selectSetups: SelectSetup = [
        { rows: [] }, // agentApiKeys: no key found -> falls through to JWT path
        ...(jwtClaims && agentRow !== undefined ? [{ rows: agentRow ? [agentRow] : [] }] : []),
      ];

      return makeMockDb(selectSetups);
    }

    it("sets actor type=agent via valid JWT", async () => {
      const claims = { sub: "agent-j1", company_id: "co-j", adapter_type: "http", run_id: "jwt-run" };
      const agentRow = { id: "agent-j1", companyId: "co-j", status: "active" };

      const db = setupJwtTest(claims, agentRow);
      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: "Bearer some.jwt.token" });
      await run(mw, req);

      expect(req.actor).toMatchObject({
        type: "agent",
        agentId: "agent-j1",
        companyId: "co-j",
        keyId: undefined,
        source: "agent_jwt",
      });
    });

    it("uses JWT run_id when no x-ironworks-run-id header is present", async () => {
      const claims = { sub: "agent-j2", company_id: "co-j2", adapter_type: "http", run_id: "jwt-run-id" };
      const agentRow = { id: "agent-j2", companyId: "co-j2", status: "active" };

      const db = setupJwtTest(claims, agentRow);
      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: "Bearer jwt.token.here" });
      await run(mw, req);

      expect(req.actor.runId).toBe("jwt-run-id");
    });

    it("header run-id takes precedence over JWT run_id", async () => {
      const claims = { sub: "agent-j3", company_id: "co-j3", adapter_type: "http", run_id: "jwt-run" };
      const agentRow = { id: "agent-j3", companyId: "co-j3", status: "active" };

      const db = setupJwtTest(claims, agentRow);
      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: "Bearer jwt.tok", "x-ironworks-run-id": "header-run" });
      await run(mw, req);

      expect(req.actor.runId).toBe("header-run");
    });

    it("actor stays 'none' when agent company_id does not match JWT claims", async () => {
      const claims = { sub: "agent-j4", company_id: "co-claims", adapter_type: "http", run_id: "r" };
      const agentRow = { id: "agent-j4", companyId: "co-different", status: "active" }; // mismatch

      const db = setupJwtTest(claims, agentRow);
      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: "Bearer jwt.tok.mismatch" });
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });

    it("actor stays 'none' for JWT when agent is terminated", async () => {
      const claims = { sub: "agent-j5", company_id: "co-j5", adapter_type: "http", run_id: "r" };
      const agentRow = { id: "agent-j5", companyId: "co-j5", status: "terminated" };

      const db = setupJwtTest(claims, agentRow);
      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: "Bearer jwt.tok.term" });
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });

    it("actor stays 'none' for JWT when agent is pending_approval", async () => {
      const claims = { sub: "agent-j6", company_id: "co-j6", adapter_type: "http", run_id: "r" };
      const agentRow = { id: "agent-j6", companyId: "co-j6", status: "pending_approval" };

      const db = setupJwtTest(claims, agentRow);
      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: "Bearer jwt.tok.pend" });
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });

    it("actor stays 'none' when JWT verification returns null", async () => {
      const boardServiceMock = {
        findBoardApiKeyByToken: vi.fn().mockResolvedValue(null),
        resolveBoardAccess: vi.fn(),
        touchBoardApiKey: vi.fn(),
      };
      (boardAuthService as Mock).mockReturnValue(boardServiceMock);
      (verifyLocalAgentJwt as Mock).mockReturnValue(null);

      const db = makeMockDb([{ rows: [] }]); // agentApiKeys: empty
      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: "Bearer invalid.jwt.token" });
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });

    it("actor stays 'none' for JWT when agent record not found in DB", async () => {
      const claims = { sub: "agent-missing", company_id: "co-miss", adapter_type: "http", run_id: "r" };

      const db = setupJwtTest(claims, null); // no agent row
      const mw = makeMiddleware("unauthenticated", undefined, db);
      const req = mockReq({ authorization: "Bearer jwt.tok.miss" });
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });
  });

  // --------------------------------------------------------------------------
  // 6. No valid auth at all
  // --------------------------------------------------------------------------

  describe("no valid auth", () => {
    it("actor stays 'none' with empty bearer token", async () => {
      const mw = makeMiddleware("unauthenticated");
      const req = mockReq({ authorization: "Bearer " });
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });

    it("actor stays 'none' with no auth header and no session (unauthenticated mode)", async () => {
      const mw = makeMiddleware("unauthenticated");
      const req = mockReq();
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });

    it("actor stays 'none' with no auth header in authenticated mode and no resolveSession", async () => {
      const mw = makeMiddleware("authenticated"); // no resolveSession provided
      const req = mockReq();
      await run(mw, req);

      expect(req.actor.type).toBe("none");
    });
  });

  // --------------------------------------------------------------------------
  // 7. x-ironworks-run-id header propagation
  // --------------------------------------------------------------------------

  describe("x-ironworks-run-id header", () => {
    it("run-id propagated to actor.none when no auth and no session", async () => {
      const mw = makeMiddleware("unauthenticated");
      const req = mockReq({ "x-ironworks-run-id": "run-none" });
      await run(mw, req);

      expect(req.actor.type).toBe("none");
      expect(req.actor.runId).toBe("run-none");
    });

    it("run-id NOT present in actor when run-id header is absent", async () => {
      const mw = makeMiddleware("unauthenticated");
      const req = mockReq();
      await run(mw, req);

      expect(req.actor.runId).toBeUndefined();
    });

    it("run-id propagated to board actor from session", async () => {
      const db = makeMockDb([{ rows: [] }, { rows: [{ companyId: "co" }] }]);
      const resolveSession = vi.fn().mockResolvedValue({ user: { id: "uid-run" } });
      const mw = makeMiddleware("authenticated", resolveSession, db);
      const req = mockReq({ "x-ironworks-run-id": "run-session" });
      await run(mw, req);

      expect(req.actor.type).toBe("board");
      expect(req.actor.runId).toBe("run-session");
    });
  });
});
