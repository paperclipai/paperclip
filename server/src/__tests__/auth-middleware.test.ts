import express from "express";
import request from "supertest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import * as boardAuthModule from "../services/board-auth.js";

describe("actorMiddleware run id header validation", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const ttlEnv = "PAPERCLIP_AGENT_JWT_TTL_SECONDS";
  const originalEnv = {
    secret: process.env[secretEnv],
    ttl: process.env[ttlEnv],
  };

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    process.env[ttlEnv] = "3600";
    vi.spyOn(boardAuthModule, "boardAuthService").mockReturnValue({
      findBoardApiKeyByToken: vi.fn().mockResolvedValue(null),
      resolveBoardAccess: vi.fn(),
      touchBoardApiKey: vi.fn(),
    } as unknown as ReturnType<typeof boardAuthModule.boardAuthService>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv.secret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalEnv.secret;
    if (originalEnv.ttl === undefined) delete process.env[ttlEnv];
    else process.env[ttlEnv] = originalEnv.ttl;
  });

  it("keeps a valid UUID run id header", async () => {
    const app = express();
    const db = {} as Db;
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.get("/actor", (req, res) => res.json(req.actor));

    const runId = "11111111-1111-4111-8111-111111111111";
    const res = await request(app).get("/actor").set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
  });

  it("keeps a valid UUID v7 run id header", async () => {
    const app = express();
    const db = {} as Db;
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.get("/actor", (req, res) => res.json(req.actor));

    const runId = "77777777-7777-7777-8777-777777777777";
    const res = await request(app).get("/actor").set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
  });

  it("drops a malformed run id header", async () => {
    const app = express();
    const db = {} as Db;
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.get("/actor", (req, res) => res.json(req.actor));

    const res = await request(app).get("/actor").set("X-Paperclip-Run-Id", "24916751496-1");

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeUndefined();
  });

  it("falls back to the JWT run id when the header is malformed", async () => {
    const agentId = "22222222-2222-4222-8222-222222222222";
    const companyId = "33333333-3333-4333-8333-333333333333";
    const jwtRunId = "44444444-4444-4444-8444-444444444444";
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", jwtRunId);
    let selectCall = 0;
    const db = {
      select: vi.fn(() => {
        selectCall += 1;
        const rows =
          selectCall === 1
            ? []
            : [{ id: agentId, companyId, status: "running" }];
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              then: async (cb: (value: typeof rows) => unknown) => cb(rows),
            })),
          })),
        };
      }),
    } as unknown as Db;

    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.get("/actor", (req, res) => res.json(req.actor));

    const res = await request(app)
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", "not-a-uuid");

    expect(res.status).toBe(200);
    expect(res.body.type).toBe("agent");
    expect(res.body.runId).toBe(jwtRunId);
  });
});
