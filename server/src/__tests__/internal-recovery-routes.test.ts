import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockAdapter = vi.hoisted(() => ({
  getState: vi.fn(),
  performAttempt: vi.fn(),
  resolve: vi.fn(),
  escalate: vi.fn(),
}));

vi.mock("../services/recovery-workflow-adapter.js", () => ({
  recoveryWorkflowAdapter: () => mockAdapter,
}));

// The route factory also constructs recoveryService + issueRecoveryActionService
// (to wire the real adapter). Mock them so the test env never touches drizzle-orm.
vi.mock("../services/recovery/service.js", () => ({
  recoveryService: () => ({ escalateStrandedAssignedIssue: vi.fn() }),
}));

vi.mock("../services/issue-recovery-actions.js", () => ({
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(),
    resolveActiveForIssue: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

const INTERNAL_SECRET = "test-secret";

async function createApp() {
  vi.resetModules();
  process.env.PAPERCLIP_INTERNAL_API_SECRET = INTERNAL_SECRET;
  const [{ errorHandler }, { internalRecoveryRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/internal-recovery.js") as Promise<
      typeof import("../routes/internal-recovery.js")
    >,
  ]);
  const app = express();
  app.use(express.json());
  app.use(
    internalRecoveryRoutes({} as any, {
      enqueueWakeup: vi.fn() as any,
      heartbeatIntervalMs: 60000,
    }),
  );
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.sequential("internal recovery routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.getState.mockReset();
    mockAdapter.performAttempt.mockReset();
    mockAdapter.resolve.mockReset();
    mockAdapter.escalate.mockReset();

    // Default mock return values
    mockAdapter.getState.mockResolvedValue({ active: true, status: "active", attemptCount: 1 });
    mockAdapter.performAttempt.mockResolvedValue({
      active: true,
      status: "active",
      attemptCount: 1,
      nextIntervalMs: 60000,
    });
    mockAdapter.resolve.mockResolvedValue({ status: "resolved" });
    mockAdapter.escalate.mockResolvedValue({ status: "cancelled" });
  });

  // ---- Auth guard ----------------------------------------------------------

  it("GET returns 401 when x-internal-secret is missing", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/internal/recovery/action-1?companyId=c1&sourceIssueId=i1"),
    );
    expect(res.status).toBe(401);
  });

  it("GET returns 401 when x-internal-secret is wrong", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .get("/internal/recovery/action-1?companyId=c1&sourceIssueId=i1")
        .set("x-internal-secret", "wrong-secret"),
    );
    expect(res.status).toBe(401);
  });

  it("POST /attempt returns 401 when x-internal-secret is missing", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/internal/recovery/action-1/attempt")
        .send({ companyId: "c1", sourceIssueId: "i1", attemptNumber: 1, mode: "dry" }),
    );
    expect(res.status).toBe(401);
  });

  // ---- GET /internal/recovery/:actionId ------------------------------------

  it("GET returns { active, status, attemptCount } with valid secret", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .get("/internal/recovery/action-1?companyId=c1&sourceIssueId=i1")
        .set("x-internal-secret", INTERNAL_SECRET),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ active: true, status: "active", attemptCount: 1 });
    expect(mockAdapter.getState).toHaveBeenCalledWith("c1", "i1");
  });

  it("GET returns 400 when companyId or sourceIssueId query param is missing", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .get("/internal/recovery/action-1?companyId=c1")
        .set("x-internal-secret", INTERNAL_SECRET),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(mockAdapter.getState).not.toHaveBeenCalled();
  });

  // ---- POST /internal/recovery/:actionId/attempt ---------------------------

  it("POST /attempt with valid dry body returns { active, status, attemptCount, nextIntervalMs }", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/internal/recovery/action-1/attempt")
        .set("x-internal-secret", INTERNAL_SECRET)
        .send({ companyId: "c1", sourceIssueId: "i1", attemptNumber: 1, mode: "dry" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      active: true,
      status: "active",
      attemptCount: 1,
      nextIntervalMs: 60000,
    });
    expect(mockAdapter.performAttempt).toHaveBeenCalledWith({
      companyId: "c1",
      sourceIssueId: "i1",
      actionId: "action-1",
      attemptNumber: 1,
      mode: "dry",
    });
  });

  it("POST /attempt with invalid mode returns 400", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/internal/recovery/action-1/attempt")
        .set("x-internal-secret", INTERNAL_SECRET)
        .send({ companyId: "c1", sourceIssueId: "i1", attemptNumber: 1, mode: "invalid" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  it("POST /attempt with missing companyId returns 400", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/internal/recovery/action-1/attempt")
        .set("x-internal-secret", INTERNAL_SECRET)
        .send({ sourceIssueId: "i1", attemptNumber: 1, mode: "dry" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  // ---- POST /internal/recovery/:actionId/resolve ---------------------------

  it("POST /resolve returns { status } and calls adapter.resolve with full input", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/internal/recovery/action-1/resolve")
        .set("x-internal-secret", INTERNAL_SECRET)
        .send({ companyId: "c1", sourceIssueId: "i1", outcome: "restored", note: "done" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "resolved" });
    expect(mockAdapter.resolve).toHaveBeenCalledWith({
      companyId: "c1",
      sourceIssueId: "i1",
      actionId: "action-1",
      status: "resolved",
      outcome: "restored",
      resolutionNote: "done",
    });
  });

  // ---- POST /internal/recovery/:actionId/escalate --------------------------

  it("POST /escalate returns { status } and calls adapter.escalate with full input", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/internal/recovery/action-1/escalate")
        .set("x-internal-secret", INTERNAL_SECRET)
        .send({ companyId: "c1", sourceIssueId: "i1" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: "cancelled" });
    expect(mockAdapter.escalate).toHaveBeenCalledWith({
      companyId: "c1",
      sourceIssueId: "i1",
      actionId: "action-1",
    });
  });
});
