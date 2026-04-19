import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  boardAuthServiceMock,
  loggerWarnMock,
  verifyLocalAgentJwtMock,
} = vi.hoisted(() => ({
  boardAuthServiceMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  verifyLocalAgentJwtMock: vi.fn(),
}));

vi.mock("../agent-auth-jwt.js", () => ({
  verifyLocalAgentJwt: verifyLocalAgentJwtMock,
}));

vi.mock("../services/board-auth.js", () => ({
  boardAuthService: boardAuthServiceMock,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: loggerWarnMock,
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { actorMiddleware } from "../middleware/auth.ts";

function createDbStub(resultSets: Array<unknown[]>) {
  const queue = [...resultSets];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(queue.shift() ?? [])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
  };
}

function createApp(db: ReturnType<typeof createDbStub>) {
  const app = express();
  app.use(actorMiddleware(db as never, { deploymentMode: "authenticated" }));
  app.get("/whoami", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

describe("actorMiddleware agent run id normalization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    boardAuthServiceMock.mockReturnValue({
      findBoardApiKeyByToken: vi.fn(async () => null),
      resolveBoardAccess: vi.fn(async () => ({ user: null, companyIds: [], isInstanceAdmin: false })),
      touchBoardApiKey: vi.fn(async () => undefined),
    });
    verifyLocalAgentJwtMock.mockReturnValue({
      sub: "agent-1",
      company_id: "company-1",
      run_id: "run-claim",
    });
  });

  it("preserves a known agent-owned run id and its status", async () => {
    const app = createApp(createDbStub([
      [],
      [{ id: "agent-1", companyId: "company-1", status: "active" }],
      [{ id: "run-1", companyId: "company-1", agentId: "agent-1", status: "failed" }],
    ]));

    const res = await request(app)
      .get("/whoami")
      .set("authorization", "Bearer token")
      .set("x-paperclip-run-id", "run-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      runStatus: "failed",
      source: "agent_jwt",
    });
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("drops a missing run id instead of surfacing it to routes", async () => {
    const app = createApp(createDbStub([
      [],
      [{ id: "agent-1", companyId: "company-1", status: "active" }],
      [],
    ]));

    const res = await request(app)
      .get("/whoami")
      .set("authorization", "Bearer token")
      .set("x-paperclip-run-id", "run-missing");

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeUndefined();
    expect(res.body.runStatus).toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedRunId: "run-missing",
        rejectionReason: "missing",
      }),
      "Ignoring invalid agent run id from request",
    );
  });

  it("drops run ids that belong to another company", async () => {
    const app = createApp(createDbStub([
      [],
      [{ id: "agent-1", companyId: "company-1", status: "active" }],
      [{ id: "run-foreign-company", companyId: "company-2", agentId: "agent-1", status: "running" }],
    ]));

    const res = await request(app)
      .get("/whoami")
      .set("authorization", "Bearer token")
      .set("x-paperclip-run-id", "run-foreign-company");

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedRunId: "run-foreign-company",
        rejectionReason: "company_mismatch",
      }),
      "Ignoring invalid agent run id from request",
    );
  });

  it("drops run ids that belong to another agent", async () => {
    const app = createApp(createDbStub([
      [],
      [{ id: "agent-1", companyId: "company-1", status: "active" }],
      [{ id: "run-foreign-agent", companyId: "company-1", agentId: "agent-2", status: "running" }],
    ]));

    const res = await request(app)
      .get("/whoami")
      .set("authorization", "Bearer token")
      .set("x-paperclip-run-id", "run-foreign-agent");

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedRunId: "run-foreign-agent",
        rejectionReason: "agent_mismatch",
      }),
      "Ignoring invalid agent run id from request",
    );
  });
});
