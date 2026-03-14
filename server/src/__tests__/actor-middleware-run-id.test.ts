import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { agentApiKeys, agents, heartbeatRuns } from "@paperclipai/db";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const COMPANY_ID = "00000000-0000-0000-0000-000000000002";
const RUN_ID = "00000000-0000-0000-0000-000000000003";

const AGENT_RECORD = {
  id: AGENT_ID,
  companyId: COMPANY_ID,
  status: "active",
};

/**
 * Builds a minimal DB stub for the actor middleware.
 * All select() calls are differentiating by table reference.
 * update() for agentApiKeys.lastUsedAt is a no-op.
 */
function makeDb(opts: {
  apiKey?: { id: string; agentId: string; companyId: string; keyHash: string; revokedAt: null } | null;
  agentRecord?: typeof AGENT_RECORD | null;
  runRecord?: { id: string } | null;
  throwOnRunLookup?: boolean;
}) {
  const select = vi.fn().mockImplementation(() => {
    let queriedTable: unknown;
    const then = vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) => {
      if (queriedTable === agentApiKeys) {
        return Promise.resolve(cb(opts.apiKey ? [opts.apiKey] : []));
      }
      if (queriedTable === agents) {
        return Promise.resolve(cb(opts.agentRecord ? [opts.agentRecord] : []));
      }
      if (queriedTable === heartbeatRuns) {
        if (opts.throwOnRunLookup) return Promise.reject(new Error("simulated DB error"));
        return Promise.resolve(cb(opts.runRecord ? [opts.runRecord] : []));
      }
      // instanceUserRoles, companyMemberships, etc.
      return Promise.resolve(cb([]));
    });
    const where = vi.fn().mockReturnValue({ then });
    const from = vi.fn().mockImplementation((table: unknown) => {
      queriedTable = table;
      return { where };
    });
    return { from };
  });

  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  });

  return { select, update } as any;
}

function makeApp(db: ReturnType<typeof makeDb>, deploymentMode: "authenticated" | "local_trusted" = "authenticated") {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode }));
  app.get("/me", (req, res) => {
    res.json({ actor: req.actor });
  });
  return app;
}

describe("actor middleware — runId validation", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env[secretEnv];
    vi.clearAllMocks();
  });

  describe("agent JWT actor", () => {
    it("preserves runId when the run exists for the same agent and company", async () => {
      const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "claude_local", RUN_ID)!;
      const db = makeDb({
        agentRecord: AGENT_RECORD,
        runRecord: { id: RUN_ID },
      });

      const res = await request(makeApp(db)).get("/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.actor.runId).toBe(RUN_ID);
    });

    it("nulls runId when the run does not exist in heartbeat_runs", async () => {
      const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "claude_local", RUN_ID)!;
      const db = makeDb({
        agentRecord: AGENT_RECORD,
        runRecord: null,
      });

      const res = await request(makeApp(db)).get("/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.actor.runId).toBeUndefined();
    });

    it("falls back to undefined (not error) when heartbeat_runs lookup throws", async () => {
      const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "claude_local", RUN_ID)!;
      const db = makeDb({
        agentRecord: AGENT_RECORD,
        throwOnRunLookup: true,
      });

      const res = await request(makeApp(db)).get("/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.actor.runId).toBeUndefined();
    });

    it("header runId overrides JWT claim run_id and is validated", async () => {
      const tokenRunId = "00000000-0000-0000-0000-000000000099";
      const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "claude_local", tokenRunId)!;
      const db = makeDb({
        agentRecord: AGENT_RECORD,
        runRecord: { id: RUN_ID },
      });

      const res = await request(makeApp(db))
        .get("/me")
        .set("Authorization", `Bearer ${token}`)
        .set("x-paperclip-run-id", RUN_ID);
      expect(res.status).toBe(200);
      // header wins; that run exists → preserved
      expect(res.body.actor.runId).toBe(RUN_ID);
    });
  });

  describe("board actor", () => {
    it("never carries runId even when x-paperclip-run-id header is present (local_trusted)", async () => {
      const db = makeDb({});

      const res = await request(makeApp(db, "local_trusted"))
        .get("/me")
        .set("x-paperclip-run-id", RUN_ID);
      expect(res.status).toBe(200);
      expect(res.body.actor.type).toBe("board");
      expect(res.body.actor.runId).toBeUndefined();
    });
  });
});
