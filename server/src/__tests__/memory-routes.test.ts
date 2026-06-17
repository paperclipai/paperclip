import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMemoryService = vi.hoisted(() => ({
  resolveBinding: vi.fn(),
  hydrateForRun: vi.fn(),
  captureRunCompletion: vi.fn(),
  queryForOperator: vi.fn(),
  noteForOperator: vi.fn(),
  getOverview: vi.fn(),
  listOperations: vi.fn(),
  updateBinding: vi.fn(),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

// Avoids touching the real gbrain binary: the route constructs the memory
// service from this module, so the whole provider path is stubbed out.
vi.mock("../services/memory/index.js", () => ({
  memoryService: () => mockMemoryService,
}));

const COMPANY_ID = "company-1";
const OTHER_COMPANY_ID = "company-2";
const BINDING_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeBindingRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: BINDING_ID,
    companyId: COMPANY_ID,
    key: "default",
    provider: "gbrain",
    config: { topK: 5 },
    enabled: true,
    createdAt: new Date("2026-06-09T10:00:00.000Z"),
    updatedAt: new Date("2026-06-09T10:00:00.000Z"),
    ...overrides,
  };
}

function makeOperationRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    companyId: COMPANY_ID,
    bindingId: BINDING_ID,
    operation: "query",
    hookKind: "pre_run_hydrate",
    intent: "agent_preamble",
    status: "succeeded",
    agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    issueId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    heartbeatRunId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    scopeJson: { companyId: COMPANY_ID },
    requestJson: { query: "stall recovery", topK: 5 },
    resultJson: { count: 1, snippets: [{ slug: "notes/stalls", score: 0.91 }] },
    usageJson: { latencyMs: 420, attributionMode: "included_in_run" },
    errorMessage: null,
    createdAt: new Date("2026-06-10T08:00:00.000Z"),
    ...overrides,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ memoryRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/memory.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", memoryRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function sessionBoardActor() {
  return {
    type: "board",
    userId: "session-user",
    companyIds: [COMPANY_ID],
    source: "better_auth",
    isInstanceAdmin: false,
    memberships: [
      { companyId: COMPANY_ID, status: "active", membershipRole: "admin" },
    ],
  };
}

describe.sequential("memory routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMemoryService.getOverview.mockResolvedValue({
      binding: makeBindingRecord(),
      providerAvailable: true,
      stats: {
        opsLast24h: 3,
        failuresLast24h: 1,
        lastHydrateAt: new Date("2026-06-10T08:00:00.000Z"),
        lastCaptureAt: null,
      },
    });
    mockMemoryService.listOperations.mockResolvedValue([makeOperationRecord()]);
    mockMemoryService.queryForOperator.mockResolvedValue({
      snippets: [
        {
          slug: "notes/stalls",
          text: "Paperclip stall recovery notes",
          title: "Stall recovery",
          score: 0.91,
          stale: false,
        },
      ],
      latencyMs: 412,
      error: null,
    });
    mockMemoryService.noteForOperator.mockResolvedValue({
      slug: `paperclip/companies/${COMPANY_ID}/notes/abc123def0`,
      error: null,
    });
    mockMemoryService.updateBinding.mockResolvedValue(
      makeBindingRecord({ enabled: false, config: { topK: 7 } }),
    );
  });

  it("returns the bootstrapped binding and stats from the overview", async () => {
    const res = await request(await installActor(createApp()))
      .get(`/api/companies/${COMPANY_ID}/memory/overview`);

    expect(res.status).toBe(200);
    expect(mockMemoryService.getOverview).toHaveBeenCalledWith(COMPANY_ID);
    expect(res.body).toEqual({
      binding: {
        id: BINDING_ID,
        key: "default",
        provider: "gbrain",
        enabled: true,
        config: { topK: 5 },
      },
      providerAvailable: true,
      stats: {
        opsLast24h: 3,
        failuresLast24h: 1,
        lastHydrateAt: "2026-06-10T08:00:00.000Z",
        lastCaptureAt: null,
      },
    });
  });

  it("returns a null binding when no binding could be bootstrapped", async () => {
    mockMemoryService.getOverview.mockResolvedValue({
      binding: null,
      providerAvailable: false,
      stats: { opsLast24h: 0, failuresLast24h: 0, lastHydrateAt: null, lastCaptureAt: null },
    });

    const res = await request(await installActor(createApp()))
      .get(`/api/companies/${COMPANY_ID}/memory/overview`);

    expect(res.status).toBe(200);
    expect(res.body.binding).toBeNull();
    expect(res.body.providerAvailable).toBe(false);
  });

  it("lists operations with contract fields only and forwards limit/before", async () => {
    const res = await request(await installActor(createApp()))
      .get(`/api/companies/${COMPANY_ID}/memory/operations`)
      .query({ limit: "5", before: "2026-06-10T09:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(mockMemoryService.listOperations).toHaveBeenCalledWith(COMPANY_ID, {
      limit: 5,
      before: new Date("2026-06-10T09:00:00.000Z"),
    });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toEqual({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      operation: "query",
      hookKind: "pre_run_hydrate",
      intent: "agent_preamble",
      status: "succeeded",
      agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      issueId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      heartbeatRunId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      usageJson: { latencyMs: 420, attributionMode: "included_in_run" },
      errorMessage: null,
      createdAt: "2026-06-10T08:00:00.000Z",
      requestJson: { query: "stall recovery", topK: 5 },
      resultJson: { count: 1, snippets: [{ slug: "notes/stalls", score: 0.91 }] },
    });
    expect(res.body.items[0]).not.toHaveProperty("companyId");
    expect(res.body.items[0]).not.toHaveProperty("bindingId");
    expect(res.body.items[0]).not.toHaveProperty("scopeJson");
  });

  it("rejects an invalid before query value", async () => {
    const res = await request(await installActor(createApp()))
      .get(`/api/companies/${COMPANY_ID}/memory/operations`)
      .query({ before: "not-a-date" });

    expect(res.status).toBe(400);
    expect(mockMemoryService.listOperations).not.toHaveBeenCalled();
  });

  it("runs operator queries and serializes snippets per the contract", async () => {
    const res = await request(await installActor(createApp()))
      .post(`/api/companies/${COMPANY_ID}/memory/query`)
      .send({ query: "stall recovery", topK: 3 });

    expect(res.status).toBe(200);
    expect(mockMemoryService.queryForOperator).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      query: "stall recovery",
      topK: 3,
    });
    expect(res.body).toEqual({
      snippets: [
        {
          slug: "notes/stalls",
          title: "Stall recovery",
          score: 0.91,
          text: "Paperclip stall recovery notes",
        },
      ],
      latencyMs: 412,
    });
  });

  it("returns 409 when querying without a configured binding", async () => {
    mockMemoryService.queryForOperator.mockResolvedValue({
      snippets: [],
      latencyMs: 0,
      error: "memory_not_configured",
    });

    const res = await request(await installActor(createApp()))
      .post(`/api/companies/${COMPANY_ID}/memory/query`)
      .send({ query: "anything" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Memory is not configured for this company");
  });

  it("rejects query payloads without a query string", async () => {
    const res = await request(await installActor(createApp()))
      .post(`/api/companies/${COMPANY_ID}/memory/query`)
      .send({ topK: 3 });

    expect(res.status).toBe(400);
    expect(mockMemoryService.queryForOperator).not.toHaveBeenCalled();
  });

  it("creates operator notes with the acting user", async () => {
    const res = await request(await installActor(createApp()))
      .post(`/api/companies/${COMPANY_ID}/memory/note`)
      .send({ title: "Stall learnings", text: "Always check liveness wake boundaries." });

    expect(res.status).toBe(201);
    expect(mockMemoryService.noteForOperator).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      title: "Stall learnings",
      text: "Always check liveness wake boundaries.",
      actorUserId: "local-board",
    });
    expect(res.body).toEqual({ slug: `paperclip/companies/${COMPANY_ID}/notes/abc123def0` });
  });

  it("returns 500 when note capture fails at the provider", async () => {
    mockMemoryService.noteForOperator.mockResolvedValue({
      slug: null,
      error: "gbrain call timed out after 15000ms",
    });

    const res = await request(await installActor(createApp()))
      .post(`/api/companies/${COMPANY_ID}/memory/note`)
      .send({ text: "note body" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Memory note failed");
  });

  it("updates the binding and returns the serialized record", async () => {
    const res = await request(await installActor(createApp()))
      .patch(`/api/companies/${COMPANY_ID}/memory/binding`)
      .send({ enabled: false, config: { topK: 7 } });

    expect(res.status).toBe(200);
    expect(mockMemoryService.updateBinding).toHaveBeenCalledWith(
      COMPANY_ID,
      { enabled: false, config: { topK: 7 } },
      { actorUserId: "local-board" },
    );
    expect(res.body).toEqual({
      id: BINDING_ID,
      key: "default",
      provider: "gbrain",
      enabled: false,
      config: { topK: 7 },
    });
  });

  it("returns 404 when no binding exists to update", async () => {
    mockMemoryService.updateBinding.mockResolvedValue(null);

    const res = await request(await installActor(createApp()))
      .patch(`/api/companies/${COMPANY_ID}/memory/binding`)
      .send({ enabled: true });

    expect(res.status).toBe(404);
  });

  it("rejects binding patches with unknown config keys", async () => {
    const res = await request(await installActor(createApp()))
      .patch(`/api/companies/${COMPANY_ID}/memory/binding`)
      .send({ config: { arbitrary: true } });

    expect(res.status).toBe(400);
    expect(mockMemoryService.updateBinding).not.toHaveBeenCalled();
  });

  it("rejects cross-company access for session board users", async () => {
    const res = await request(await installActor(createApp(), sessionBoardActor()))
      .get(`/api/companies/${OTHER_COMPANY_ID}/memory/overview`);

    expect(res.status).toBe(403);
    expect(mockMemoryService.getOverview).not.toHaveBeenCalled();
  });

  it("rejects cross-company note writes from agent keys", async () => {
    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        companyId: COMPANY_ID,
        source: "agent_key",
        runId: "run-1",
      }),
    )
      .post(`/api/companies/${OTHER_COMPANY_ID}/memory/note`)
      .send({ text: "cross-company note" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another company");
    expect(mockMemoryService.noteForOperator).not.toHaveBeenCalled();
  });
});
