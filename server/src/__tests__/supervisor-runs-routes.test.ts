import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const supervisorRunId = "44444444-4444-4444-8444-444444444444";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockSupervisorRunsService = vi.hoisted(() => ({
  createSupervisorRun: vi.fn(),
  validateSupervisorRunScope: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerMocks() {
  vi.doMock("../services/index.js", () => ({
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/supervisor-runs.js", () => mockSupervisorRunsService);
}

async function createApp(
  actor: Record<string, unknown> = {
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
    runId: null,
  },
) {
  vi.resetModules();
  registerMocks();
  const [{ errorHandler }, { supervisorRunsRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/supervisor-runs.js") as Promise<typeof import("../routes/supervisor-runs.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", supervisorRunsRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function doRequest(app: express.Express, buildReq: (baseUrl: string) => request.Test) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No TCP port");
    return await buildReq(`http://127.0.0.1:${(address as { port: number }).port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }
}

describe.sequential("supervisor runs routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("creates a supervisor run and returns runId, expiresAt, issueId", async () => {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    mockIssueService.getById.mockResolvedValue({ id: issueId, companyId });
    mockSupervisorRunsService.createSupervisorRun.mockResolvedValue({
      runId: supervisorRunId,
      expiresAt,
      issueId,
    });

    const app = await createApp();
    const res = await doRequest(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/supervisor-runs")
        .send({ issueId, motif: "Fix title typo", source: "codex" }),
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      runId: supervisorRunId,
      expiresAt,
      issueId,
    });
    expect(mockSupervisorRunsService.createSupervisorRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        agentId,
        issueId,
        motif: "Fix title typo",
        source: "codex",
      }),
    );
  });

  it("returns 404 when issue not found", async () => {
    mockIssueService.getById.mockResolvedValue(null);

    const app = await createApp();
    const res = await doRequest(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/supervisor-runs")
        .send({ issueId, source: "codex" }),
    );

    expect(res.status).toBe(404);
    expect(mockSupervisorRunsService.createSupervisorRun).not.toHaveBeenCalled();
  });

  it("returns 400 on missing issueId", async () => {
    const app = await createApp();
    const res = await doRequest(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/supervisor-runs")
        .send({ source: "codex" }),
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid issueId (not uuid)", async () => {
    const app = await createApp();
    const res = await doRequest(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/supervisor-runs")
        .send({ issueId: "not-a-uuid", source: "codex" }),
    );

    expect(res.status).toBe(400);
  });

  it("returns 403 when actor is a board user (not agent)", async () => {
    mockIssueService.getById.mockResolvedValue({ id: issueId, companyId });

    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "board_key",
      isInstanceAdmin: true,
    });
    const res = await doRequest(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/supervisor-runs")
        .send({ issueId, source: "codex" }),
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/agent authentication/i);
  });

  it("does not create run for agent from different company", async () => {
    mockIssueService.getById.mockResolvedValue({ id: issueId, companyId: "other-company-id" });

    const app = await createApp();
    const res = await doRequest(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/supervisor-runs")
        .send({ issueId, source: "codex" }),
    );

    expect(res.status).toBe(403);
    expect(mockSupervisorRunsService.createSupervisorRun).not.toHaveBeenCalled();
  });

  it("accepts request without optional motif and source", async () => {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    mockIssueService.getById.mockResolvedValue({ id: issueId, companyId });
    mockSupervisorRunsService.createSupervisorRun.mockResolvedValue({
      runId: supervisorRunId,
      expiresAt,
      issueId,
    });

    const app = await createApp();
    const res = await doRequest(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/supervisor-runs")
        .send({ issueId }),
    );

    expect(res.status).toBe(201);
    expect(res.body.runId).toBe(supervisorRunId);
  });
});

describe("supervisor run service unit tests", () => {
  async function importRealService() {
    vi.doUnmock("../services/supervisor-runs.js");
    vi.resetModules();
    return import("../services/supervisor-runs.js");
  }

  it("SUPERVISOR_RUN_TTL_MS is 5 minutes", async () => {
    const { SUPERVISOR_RUN_TTL_MS } = await importRealService();
    expect(SUPERVISOR_RUN_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("isSupervisorRunContext identifies supervisor runs", async () => {
    const { isSupervisorRunContext } = await importRealService();
    expect(isSupervisorRunContext({ type: "supervisor", issueId: "x" })).toBe(true);
    expect(isSupervisorRunContext({ type: "heartbeat", issueId: "x" })).toBe(false);
    expect(isSupervisorRunContext(null)).toBe(false);
    expect(isSupervisorRunContext({})).toBe(false);
    expect(isSupervisorRunContext([])).toBe(false);
  });

  it("validateSupervisorRunScope returns null when run not found", async () => {
    const { validateSupervisorRunScope } = await importRealService();
    const result = await validateSupervisorRunScope(makeFakeDb(null), supervisorRunId, issueId, companyId);
    expect(result).toBeNull();
  });

  it("validateSupervisorRunScope returns null for non-supervisor runs", async () => {
    const { validateSupervisorRunScope } = await importRealService();
    const fakeDb = makeFakeDb({ agentId, companyId, contextSnapshot: { type: "heartbeat", issueId } });
    const result = await validateSupervisorRunScope(fakeDb, supervisorRunId, issueId, companyId);
    expect(result).toBeNull();
  });

  it("validateSupervisorRunScope returns scope error for wrong issueId", async () => {
    const { validateSupervisorRunScope } = await importRealService();
    const futureDate = new Date(Date.now() + 60_000).toISOString();
    const fakeDb = makeFakeDb({
      agentId,
      companyId,
      contextSnapshot: { type: "supervisor", issueId: "different-issue-id", expiresAt: futureDate },
    });
    const result = await validateSupervisorRunScope(fakeDb, supervisorRunId, "my-issue-id", companyId);
    expect(result).not.toBeNull();
    expect(result!.code).toBe("supervisor_run_scope_mismatch");
  });

  it("validateSupervisorRunScope returns expired error past TTL", async () => {
    const { validateSupervisorRunScope } = await importRealService();
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const fakeDb = makeFakeDb({
      agentId,
      companyId,
      contextSnapshot: { type: "supervisor", issueId, expiresAt: pastDate },
    });
    const result = await validateSupervisorRunScope(fakeDb, supervisorRunId, issueId, companyId);
    expect(result).not.toBeNull();
    expect(result!.code).toBe("supervisor_run_expired");
  });

  it("validateSupervisorRunScope returns null for valid in-scope run", async () => {
    const { validateSupervisorRunScope } = await importRealService();
    const futureDate = new Date(Date.now() + 60_000).toISOString();
    const fakeDb = makeFakeDb({
      agentId,
      companyId,
      contextSnapshot: { type: "supervisor", issueId, expiresAt: futureDate },
    });
    const result = await validateSupervisorRunScope(fakeDb, supervisorRunId, issueId, companyId);
    expect(result).toBeNull();
  });
});

function makeFakeDb(row: unknown) {
  const thenable = {
    then(cb: (rows: unknown[]) => unknown) {
      return Promise.resolve(cb(row ? [row] : []));
    },
  };
  return {
    select: () => ({
      from: () => ({
        where: () => thenable,
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => thenable,
      }),
    }),
  } as unknown as import("@paperclipai/db").Db;
}
