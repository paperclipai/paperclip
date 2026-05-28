import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";

const mockBoardAuth = vi.hoisted(() => ({
  findBoardApiKeyByToken: vi.fn(),
  resolveBoardAccess: vi.fn(),
  touchBoardApiKey: vi.fn(),
}));

// Mock board-auth service to avoid real DB calls in the board-key path
vi.mock("../services/board-auth.js", () => ({
  boardAuthService: () => mockBoardAuth,
}));

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const COMPANY_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OTHER_COMPANY_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const RUN_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Build a mock Db that returns specific rows for heartbeat_runs and agents
 * table lookups.  Uses a query counter to distinguish sequential select calls
 * (first = heartbeatRuns, second = agents).
 */
function createMockDb(opts: {
  run?: { agentId: string; companyId: string } | null;
  agent?: { id: string; companyId: string; status: string } | null;
}): Db {
  let queryCount = 0;
  const selectFn = () => ({
    from: () => ({
      where: () => {
        const currentQuery = queryCount++;
        if (currentQuery === 0) {
          // First query: heartbeatRuns lookup
          return Promise.resolve(opts.run ? [opts.run] : []);
        }
        // Second query: agents lookup
        return Promise.resolve(opts.agent ? [opts.agent] : []);
      },
    }),
  });

  return { select: selectFn } as unknown as Db;
}

function createApp(db: Db, deploymentMode: "local_trusted" | "authenticated" = "local_trusted") {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode }));
  app.get("/test", (req, res) => {
    res.json({
      actorType: req.actor.type,
      agentId: req.actor.agentId ?? null,
      userId: req.actor.userId ?? null,
      runId: req.actor.runId ?? null,
      source: req.actor.source ?? null,
    });
  });
  return app;
}

describe("auth middleware: run-ID agent resolution in local_trusted mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBoardAuth.findBoardApiKeyByToken.mockResolvedValue(null);
    mockBoardAuth.resolveBoardAccess.mockResolvedValue({
      user: null,
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });
    mockBoardAuth.touchBoardApiKey.mockResolvedValue(undefined);
  });

  it("resolves agent identity from x-paperclip-run-id when no bearer token is present", async () => {
    const db = createMockDb({
      run: { agentId: AGENT_ID, companyId: COMPANY_ID },
      agent: { id: AGENT_ID, companyId: COMPANY_ID, status: "running" },
    });

    const app = createApp(db);
    const res = await request(app)
      .get("/test")
      .set("x-paperclip-run-id", RUN_ID);

    expect(res.body.actorType).toBe("agent");
    expect(res.body.agentId).toBe(AGENT_ID);
    expect(res.body.runId).toBe(RUN_ID);
    expect(res.body.source).toBe("run_id");
  });

  it("falls back to board when run ID is unknown", async () => {
    const db = createMockDb({
      run: null,
      agent: null,
    });

    const app = createApp(db);
    const res = await request(app)
      .get("/test")
      .set("x-paperclip-run-id", RUN_ID);

    expect(res.body.actorType).toBe("board");
    expect(res.body.agentId).toBeNull();
    expect(res.body.userId).toBe("local-board");
    expect(res.body.runId).toBeNull();
  });

  it("falls back to board when agent is terminated", async () => {
    const db = createMockDb({
      run: { agentId: AGENT_ID, companyId: COMPANY_ID },
      agent: { id: AGENT_ID, companyId: COMPANY_ID, status: "terminated" },
    });

    const app = createApp(db);
    const res = await request(app)
      .get("/test")
      .set("x-paperclip-run-id", RUN_ID);

    expect(res.body.actorType).toBe("board");
    expect(res.body.userId).toBe("local-board");
    expect(res.body.runId).toBeNull();
  });

  it("stays board when no run-id header is present", async () => {
    const db = createMockDb({ run: null, agent: null });

    const app = createApp(db);
    const res = await request(app).get("/test");

    expect(res.body.actorType).toBe("board");
    expect(res.body.userId).toBe("local-board");
    expect(res.body.runId).toBeNull();
    expect(res.body.source).toBe("local_implicit");
  });

  it("falls back to board when agent companyId does not match run companyId", async () => {
    const db = createMockDb({
      run: { agentId: AGENT_ID, companyId: COMPANY_ID },
      agent: { id: AGENT_ID, companyId: OTHER_COMPANY_ID, status: "running" },
    });

    const app = createApp(db);
    const res = await request(app)
      .get("/test")
      .set("x-paperclip-run-id", RUN_ID);

    expect(res.body.actorType).toBe("board");
    expect(res.body.userId).toBe("local-board");
    expect(res.body.runId).toBeNull();
  });

  it("does not resolve run-ID to agent identity in authenticated mode", async () => {
    const db = createMockDb({
      run: { agentId: AGENT_ID, companyId: COMPANY_ID },
      agent: { id: AGENT_ID, companyId: COMPANY_ID, status: "running" },
    });

    const app = createApp(db, "authenticated");
    const res = await request(app)
      .get("/test")
      .set("x-paperclip-run-id", RUN_ID);

    // In authenticated mode without a bearer token or valid session,
    // the actor must remain { type: "none" } — never agent.
    expect(res.body.actorType).toBe("none");
    expect(res.body.agentId).toBeNull();
    expect(res.body.source).toBe("none");
  });

  it("drops unknown run-ID headers for authenticated board API keys", async () => {
    mockBoardAuth.findBoardApiKeyByToken.mockResolvedValue({ id: "board-key-1", userId: "user-1" });
    mockBoardAuth.resolveBoardAccess.mockResolvedValue({
      user: { id: "user-1", name: "Board User", email: "board@example.com" },
      companyIds: [COMPANY_ID],
      memberships: [{ companyId: COMPANY_ID, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: true,
    });
    const db = createMockDb({
      run: null,
      agent: null,
    });

    const app = createApp(db, "authenticated");
    const res = await request(app)
      .get("/test")
      .set("authorization", "Bearer board-token")
      .set("x-paperclip-run-id", RUN_ID);

    expect(res.body.actorType).toBe("board");
    expect(res.body.userId).toBe("user-1");
    expect(res.body.runId).toBeNull();
    expect(res.body.source).toBe("board_key");
  });

  it("preserves known run-ID headers for authenticated board API keys", async () => {
    mockBoardAuth.findBoardApiKeyByToken.mockResolvedValue({ id: "board-key-1", userId: "user-1" });
    mockBoardAuth.resolveBoardAccess.mockResolvedValue({
      user: { id: "user-1", name: "Board User", email: "board@example.com" },
      companyIds: [COMPANY_ID],
      memberships: [{ companyId: COMPANY_ID, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: true,
    });
    const db = createMockDb({
      run: { agentId: AGENT_ID, companyId: COMPANY_ID },
      agent: null,
    });

    const app = createApp(db, "authenticated");
    const res = await request(app)
      .get("/test")
      .set("authorization", "Bearer board-token")
      .set("x-paperclip-run-id", RUN_ID);

    expect(res.body.actorType).toBe("board");
    expect(res.body.userId).toBe("user-1");
    expect(res.body.runId).toBe(RUN_ID);
    expect(res.body.source).toBe("board_key");
  });
});
