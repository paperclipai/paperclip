import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(),
  create: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  canUser: vi.fn(),
}));

const mockAgentActionAuditService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
  MAX_ACTIVITY_LIMIT: 1000,
  normalizeActivityLimit: (limit: number | undefined) => {
    if (!Number.isFinite(limit)) return 100;
    return Math.max(1, Math.min(1000, Math.floor(limit ?? 100)));
  },
  normalizeActivityOffset: (offset: number | undefined) => {
    if (!Number.isFinite(offset)) return 0;
    return Math.max(0, Math.floor(offset ?? 0));
  },
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  issueService: () => mockIssueService,
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/agent-action-audit.js", () => ({
  agentActionAuditService: () => mockAgentActionAuditService,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  vi.resetModules();
  const [{ errorHandler }, { activityRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/activity.js") as Promise<typeof import("../routes/activity.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", activityRoutes({} as any));
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

describe.sequential("activity routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockActivityService)) mock.mockReset();
    for (const mock of Object.values(mockHeartbeatService)) mock.mockReset();
    for (const mock of Object.values(mockIssueService)) mock.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.canUser.mockReset();
    mockAgentActionAuditService.list.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockAccessService.canUser.mockResolvedValue(false);
  });

  it("returns redacted all-actors rows to a basic company reader", async () => {
    mockAgentActionAuditService.list.mockResolvedValue({
      items: [{
        id: "activity-1",
        companyId: "company-1",
        actorType: "plugin",
        actorId: "plugin-1",
        action: "plugin.synced",
        entityType: "company",
        entityId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        responsibleUserId: "user-2",
        details: { privateAttribution: true },
        createdAt: "2026-08-04T00:00:00.000Z",
        entity: { issue: null, comment: null, document: null },
      }],
      nextCursor: null,
    });

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/audit/agent-actions?actorScope=all");

    expect(res.status).toBe(200);
    expect(mockAgentActionAuditService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      actorScope: "all",
      limit: 50,
    });
    expect(res.body.items[0]).toMatchObject({
      actorType: "plugin",
      actorId: "plugin-1",
      action: "plugin.synced",
      entityType: "company",
      entityId: "company-1",
      createdAt: "2026-08-04T00:00:00.000Z",
      agentId: null,
      runId: null,
      responsibleUserId: null,
      details: null,
    });
    expect(res.body.accessTier).toBe("basic");
  });

  it("rejects attribution filters for a basic all-actors reader", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/audit/agent-actions?actorScope=all&runId=00000000-0000-4000-8000-000000000001");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("audit:view_agent_actions");
    expect(mockAgentActionAuditService.list).not.toHaveBeenCalled();
  });

  it("keeps attribution for a permitted all-actors reader", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    mockAgentActionAuditService.list.mockResolvedValue({
      items: [{
        id: "activity-1",
        agentId: "agent-1",
        runId: "run-1",
        responsibleUserId: "user-2",
        details: { attribution: true },
      }],
      nextCursor: null,
    });

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/audit/agent-actions?actorScope=all&actorType=system");

    expect(res.status).toBe(200);
    expect(mockAgentActionAuditService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      actorScope: "all",
      actorType: "system",
      limit: 50,
    });
    expect(res.body.items[0]).toMatchObject({
      agentId: "agent-1",
      runId: "run-1",
      responsibleUserId: "user-2",
      details: { attribution: true },
    });
    expect(res.body.accessTier).toBe("full");
  });

  it("limits company activity lists by default", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/companies/company-1/activity"));

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      entityType: undefined,
      entityId: undefined,
      since: undefined,
      until: undefined,
      limit: 100,
      offset: 0,
    });
  });

  it("caps requested company activity list limits", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/activity?limit=5000&entityType=issue"),
    );

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      entityType: "issue",
      entityId: undefined,
      since: undefined,
      until: undefined,
      limit: 1000,
      offset: 0,
    });
  });

  it("forwards since/until/offset to the activity query", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(
        "/api/companies/company-1/activity?since=2026-08-10T00:00:00Z&until=2026-08-17T00:00:00Z&limit=1000&offset=250",
      ),
    );

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      entityType: undefined,
      entityId: undefined,
      since: new Date("2026-08-10T00:00:00.000Z"),
      until: new Date("2026-08-17T00:00:00.000Z"),
      limit: 1000,
      offset: 250,
    });
  });

  // Category safeguard: the underlying defect was a query param the route
  // accepted and then silently dropped, so a bounded query quietly returned
  // unbounded data. Any param documented in docs/api/activity.md must
  // demonstrably reach the service layer.
  it.each([
    ["agentId", "agent-9", "agentId", "agent-9"],
    ["entityType", "issue", "entityType", "issue"],
    ["entityId", "issue-9", "entityId", "issue-9"],
    ["since", "2026-08-10T00:00:00Z", "since", new Date("2026-08-10T00:00:00.000Z")],
    ["until", "2026-08-17T00:00:00Z", "until", new Date("2026-08-17T00:00:00.000Z")],
    ["limit", "250", "limit", 250],
    ["offset", "40", "offset", 40],
  ])("forwards the %s query param to the activity service", async (param, raw, key, expected) => {
    mockActivityService.list.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/company-1/activity?${param}=${encodeURIComponent(raw)}`),
    );

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith(
      expect.objectContaining({ [key]: expected }),
    );
  });

  // `new Date(string)` accepts each of these, and resolves the ones without a
  // zone against the server's local timezone — so the same request would
  // select a different window depending on where it ran. Rejecting beats
  // quietly answering a question the caller did not ask.
  it.each([
    ["last-tuesday", "not a date at all"],
    ["Aug 10 2026", "host-specific format, no zone"],
    ["2026/08/10", "host-specific format, no zone"],
    ["2026-08-10T00:00:00", "ISO shape but no zone, so locale-dependent"],
    ["1786060800000", "epoch millis, not ISO-8601"],
    // `new Date()` rolls these forward rather than failing — "2026-02-31"
    // becomes March 3 — so a shape-only check would accept a window the caller
    // never asked for. The date-time forms matter too: Zod's `.datetime()`
    // validates format, not calendar validity.
    ["2026-02-31", "ISO shape, impossible day"],
    ["2026-02-31T00:00:00Z", "impossible day in a date-time"],
    ["2026-02-31T00:00:00+05:00", "impossible day with an offset"],
    ["2027-02-29", "Feb 29 in a non-leap year"],
    ["2026-13-01", "month 13"],
    ["2026-04-31", "April has 30 days"],
    ["2026-00-10", "month 0"],
    ["2026-08-00", "day 0"],
  ])("rejects since=%s (%s) instead of silently ignoring it", async (raw) => {
    mockActivityService.list.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/company-1/activity?since=${encodeURIComponent(raw)}`),
    );

    expect(res.status).toBe(400);
    expect(mockActivityService.list).not.toHaveBeenCalled();
  });

  // The guard rejects impossible days, so prove it does not also reject real
  // ones — Feb 29 in a leap year is the case a naive 28-day rule breaks.
  it.each([
    ["2028-02-29", new Date("2028-02-29T00:00:00.000Z")],
    ["2026-01-31", new Date("2026-01-31T00:00:00.000Z")],
    ["2028-02-29T06:30:00Z", new Date("2028-02-29T06:30:00.000Z")],
    ["2026-08-10T00:00:00+05:00", new Date("2026-08-09T19:00:00.000Z")],
  ])("accepts the real date %s", async (raw, expected) => {
    mockActivityService.list.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/company-1/activity?since=${encodeURIComponent(raw)}`),
    );

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith(expect.objectContaining({ since: expected }));
  });

  it("widens a bare date bound to cover that whole UTC day", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/activity?since=2026-08-10&until=2026-08-16"),
    );

    expect(res.status).toBe(200);
    // `until` lands at end-of-day, not midnight: `since=2026-08-10&until=2026-08-16`
    // has to mean seven full days, otherwise the last day is silently dropped.
    expect(mockActivityService.list).toHaveBeenCalledWith(
      expect.objectContaining({
        since: new Date("2026-08-10T00:00:00.000Z"),
        until: new Date("2026-08-16T23:59:59.999Z"),
      }),
    );
  });

  it("resolves alphanumeric issue identifiers before loading runs", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
        adapterType: "codex_local",
      },
    ]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/issues/pc1a2-475/runs"));

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PC1A2-475");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-1", "issue-uuid-1");
    expect(res.body).toEqual([{ runId: "run-1", adapterType: "codex_local" }]);
  });

  it("requires company access before creating activity events", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-2/activity")
      .send({
        actorId: "user-1",
        action: "test.event",
        entityType: "issue",
        entityId: "issue-1",
      }));

    expect(res.status).toBe(403);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("returns 200 [] (not 404) when listing issues for another company's run, preserving API contract and the cross-tenant oracle", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-2",
      companyId: "company-2",
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-2/issues"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("returns 200 [] (not 404) for a non-existent heartbeat run, matching the cross-tenant response", async () => {
    mockHeartbeatService.getRun.mockResolvedValue(null);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/missing-run/issues"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("rejects anonymous heartbeat run issue lookups before run existence checks", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/missing-run/issues"));

    expect(res.status).toBe(401);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });
});
