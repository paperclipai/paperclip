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

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/authz.ts", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../middleware/index.js", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/index.ts", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/validate.js", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/validate.ts", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );

  const activityServiceMock = () => ({
    activityService: () => mockActivityService,
  });
  const servicesIndexMock = () => ({
    issueService: () => mockIssueService,
    heartbeatService: () => mockHeartbeatService,
  });
  vi.doMock("../services/activity.js", activityServiceMock);
  vi.doMock("../services/activity.ts", activityServiceMock);
  vi.doMock("../services/index.js", servicesIndexMock);
  vi.doMock("../services/index.ts", servicesIndexMock);
}

function resetActivityRouteModules() {
  vi.resetModules();
  vi.doUnmock("@paperclipai/db");
  vi.doUnmock("@paperclipai/shared");
  vi.doUnmock("../redaction.js");
  vi.doUnmock("../redaction.ts");
  vi.doUnmock("../routes/activity.js");
  vi.doUnmock("../routes/activity.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../middleware/validate.ts");
  vi.doUnmock("../middleware/logger.js");
  vi.doUnmock("../middleware/logger.ts");
  vi.doUnmock("../services/activity.js");
  vi.doUnmock("../services/activity.ts");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/index.ts");
}

let activityRouteImportSeq = 0;

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
}) {
  resetActivityRouteModules();
  registerModuleMocks();
  activityRouteImportSeq += 1;
  const routeModulePath = `../routes/activity.ts?activity-routes-${activityRouteImportSeq}`;
  const [{ errorHandler }, { activityRoutes }] = await Promise.all([
    import("../middleware/index.ts"),
    import(routeModulePath) as Promise<typeof import("../routes/activity.ts")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", activityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("activity routes", () => {
  beforeEach(() => {
    resetActivityRouteModules();
    registerModuleMocks();
    vi.clearAllMocks();
  });

  it("resolves issue identifiers before loading runs", async () => {
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
    const res = await request(app).get("/api/issues/PAP-475/runs");

    expect(res.status).toBe(200);
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-1", "issue-uuid-1");
    expect(res.body).toEqual([{ runId: "run-1", adapterType: "codex_local" }]);
  });

  it("requires company access before creating activity events", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-2/activity")
      .send({
        actorId: "user-1",
        action: "test.event",
        entityType: "issue",
        entityId: "issue-1",
      });

    expect(res.status).toBe(403);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("allows same-company agents to read company activity", async () => {
    mockActivityService.list.mockResolvedValue([
      { id: "event-1", action: "issue.updated" },
    ]);

    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });
    const res = await request(app).get("/api/companies/company-1/activity");

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      entityType: undefined,
      entityId: undefined,
    });
    expect(res.body).toEqual([{ id: "event-1", action: "issue.updated" }]);
  });

  it("requires company access before listing issues for another company's run", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-2",
      companyId: "company-2",
    });

    const app = await createApp();
    const res = await request(app).get("/api/heartbeat-runs/run-2/issues");

    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("rejects anonymous heartbeat run issue lookups before run existence checks", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/heartbeat-runs/missing-run/issues");

    expect(res.status).toBe(401);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });
});
