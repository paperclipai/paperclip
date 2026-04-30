import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted so vi.doMock sees them before imports
// ---------------------------------------------------------------------------
const mockVerifyLocalAgentJwt = vi.hoisted(() => vi.fn());

const mockDbSelect = vi.hoisted(() => vi.fn());

function registerMocks() {
  vi.doMock("../agent-auth-jwt.js", () => ({
    verifyLocalAgentJwt: mockVerifyLocalAgentJwt,
  }));

  // Minimal Drizzle-compatible db stub that returns what mockDbSelect resolves to.
  // The route calls: db.select({...}).from(heartbeatRuns).where(...).then(rows => rows[0] ?? null)
  vi.doMock("@paperclipai/db", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@paperclipai/db")>();
    return {
      ...actual,
    };
  });
}

// ---------------------------------------------------------------------------
// App factory — re-imported after mocks are registered
// ---------------------------------------------------------------------------
async function createApp(db: unknown) {
  const [{ proxyRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/proxy.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use("/api", proxyRoutes(db as any));
  app.use(errorHandler);
  return app;
}

function makeDb(runRow: Record<string, unknown> | null) {
  const chain = {
    from: () => chain,
    where: () => chain,
    then: (fn: (rows: unknown[]) => unknown) =>
      Promise.resolve(fn(runRow ? [runRow] : [])),
  };
  return {
    select: () => chain,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("proxy token validation routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    registerMocks();
  });

  it("returns 400 when token is missing", async () => {
    const app = await createApp(makeDb(null));
    const res = await request(app).post("/api/proxy/validate-run-token").send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ valid: false, reason: "missing_token" });
  });

  it("returns 401 when JWT is invalid", async () => {
    mockVerifyLocalAgentJwt.mockReturnValue(null);
    const app = await createApp(makeDb(null));
    const res = await request(app)
      .post("/api/proxy/validate-run-token")
      .send({ token: "bad-token" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ valid: false, reason: "invalid_token" });
  });

  it("returns 401 when run is not found", async () => {
    mockVerifyLocalAgentJwt.mockReturnValue({
      sub: "agent-1",
      company_id: "company-1",
      run_id: "run-999",
      adapter_type: "claude_local",
      iat: 1000,
      exp: 9999999999,
    });
    const app = await createApp(makeDb(null)); // null = run not found
    const res = await request(app)
      .post("/api/proxy/validate-run-token")
      .send({ token: "valid-but-run-gone" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ valid: false, reason: "run_not_found" });
  });

  it("returns 401 when run has finished (token implicitly revoked)", async () => {
    mockVerifyLocalAgentJwt.mockReturnValue({
      sub: "agent-1",
      company_id: "company-1",
      run_id: "run-1",
      adapter_type: "claude_local",
      iat: 1000,
      exp: 9999999999,
    });
    const app = await createApp(
      makeDb({
        id: "run-1",
        agentId: "agent-1",
        companyId: "company-1",
        status: "done",
        finishedAt: new Date("2026-04-10T05:00:00Z"), // run completed
      }),
    );
    const res = await request(app)
      .post("/api/proxy/validate-run-token")
      .send({ token: "token-for-completed-run" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ valid: false, reason: "run_finished" });
  });

  it("rejects a run in terminal status with no finishedAt (crash path)", async () => {
    mockVerifyLocalAgentJwt.mockReturnValue({
      sub: "agent-1",
      company_id: "company-1",
      run_id: "run-1",
      adapter_type: "claude_local",
      iat: 1000,
      exp: 9999999999,
    });
    const app = await createApp(
      makeDb({
        id: "run-1",
        agentId: "agent-1",
        companyId: "company-1",
        status: "error",
        finishedAt: null, // crashed — no finishedAt
      }),
    );
    const res = await request(app)
      .post("/api/proxy/validate-run-token")
      .send({ token: "token-for-crashed-run" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ valid: false, reason: "run_finished" });
  });

  it("rejects a cancelled run with no finishedAt (crash path)", async () => {
    mockVerifyLocalAgentJwt.mockReturnValue({
      sub: "agent-1",
      company_id: "company-1",
      run_id: "run-1",
      adapter_type: "claude_local",
      iat: 1000,
      exp: 9999999999,
    });
    const app = await createApp(
      makeDb({
        id: "run-1",
        agentId: "agent-1",
        companyId: "company-1",
        status: "cancelled",
        finishedAt: null,
      }),
    );
    const res = await request(app)
      .post("/api/proxy/validate-run-token")
      .send({ token: "token-for-cancelled-run" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ valid: false, reason: "run_finished" });
  });

  it("returns 401 when token agent does not match run agent", async () => {
    mockVerifyLocalAgentJwt.mockReturnValue({
      sub: "agent-WRONG",
      company_id: "company-1",
      run_id: "run-1",
      adapter_type: "claude_local",
      iat: 1000,
      exp: 9999999999,
    });
    const app = await createApp(
      makeDb({
        id: "run-1",
        agentId: "agent-1", // different agent
        companyId: "company-1",
        status: "running",
        finishedAt: null,
      }),
    );
    const res = await request(app)
      .post("/api/proxy/validate-run-token")
      .send({ token: "mismatched-agent-token" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ valid: false, reason: "token_agent_mismatch" });
  });

  it("returns 200 with agent info for a valid token on an active run", async () => {
    mockVerifyLocalAgentJwt.mockReturnValue({
      sub: "agent-1",
      company_id: "company-1",
      run_id: "run-1",
      adapter_type: "claude_local",
      iat: 1000,
      exp: 9999999999,
    });
    const app = await createApp(
      makeDb({
        id: "run-1",
        agentId: "agent-1",
        companyId: "company-1",
        status: "running",
        finishedAt: null, // run still active
      }),
    );
    const res = await request(app)
      .post("/api/proxy/validate-run-token")
      .send({ token: "valid-active-token" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      valid: true,
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });
  });
});
