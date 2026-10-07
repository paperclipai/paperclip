import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSavedTaskViewService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

class MockNameTakenError extends Error {}

function registerModuleMocks() {
  vi.doMock("../services/saved-task-views.js", () => ({
    savedTaskViewService: () => mockSavedTaskViewService,
    SavedTaskViewNameTakenError: MockNameTakenError,
  }));
  // The routes take only `logActivity` from the services barrel; mocking it
  // keeps this a route test rather than one that needs a database.
  vi.doMock("../services/index.js", () => ({ logActivity: mockLogActivity }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ savedTaskViewRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/saved-task-views.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", savedTaskViewRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const BOARD_USER = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
};

const VIEW = {
  id: "view-1",
  companyId: "company-1",
  collectionKey: "paperclip:issues-view",
  name: "Ready to start",
  viewState: { statuses: ["todo", "backlog"] },
  position: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("saved task view routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/saved-task-views.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/saved-task-views.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockSavedTaskViewService.list.mockResolvedValue([VIEW]);
    mockSavedTaskViewService.create.mockResolvedValue(VIEW);
    mockSavedTaskViewService.update.mockResolvedValue(VIEW);
    mockSavedTaskViewService.remove.mockResolvedValue(VIEW);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lists the signed-in user's views for one collection", async () => {
    const app = await createApp(BOARD_USER);

    const res = await request(app)
      .get("/api/companies/company-1/saved-task-views?collectionKey=paperclip:issues-view");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockSavedTaskViewService.list).toHaveBeenCalledWith(
      { companyId: "company-1", userId: "user-1" },
      "paperclip:issues-view",
    );
  });

  it("creates a view scoped to the caller, not to whatever the body claims", async () => {
    const app = await createApp(BOARD_USER);

    const res = await request(app)
      .post("/api/companies/company-1/saved-task-views")
      .send({
        collectionKey: "paperclip:issues-view",
        name: "Ready to start",
        viewState: { statuses: ["todo"] },
        // A body cannot reassign ownership: the owner comes from the actor.
        userId: "someone-else",
        companyId: "company-9",
      });

    expect(res.status).toBe(201);
    expect(mockSavedTaskViewService.create).toHaveBeenCalledWith(
      { companyId: "company-1", userId: "user-1" },
      expect.objectContaining({ collectionKey: "paperclip:issues-view", name: "Ready to start" }),
    );
  });

  it("rejects a view state larger than the cap", async () => {
    const app = await createApp(BOARD_USER);

    const res = await request(app)
      .post("/api/companies/company-1/saved-task-views")
      .send({
        collectionKey: "paperclip:issues-view",
        name: "Huge",
        viewState: { blob: "x".repeat(20_000) },
      });

    expect(res.status).toBe(400);
    expect(mockSavedTaskViewService.create).not.toHaveBeenCalled();
  });

  it("rejects an empty name", async () => {
    const app = await createApp(BOARD_USER);

    const res = await request(app)
      .post("/api/companies/company-1/saved-task-views")
      .send({ collectionKey: "paperclip:issues-view", name: "   ", viewState: {} });

    expect(res.status).toBe(400);
  });

  it("reports a duplicate name as a conflict", async () => {
    mockSavedTaskViewService.create.mockRejectedValue(new MockNameTakenError("taken"));
    const app = await createApp(BOARD_USER);

    const res = await request(app)
      .post("/api/companies/company-1/saved-task-views")
      .send({ collectionKey: "paperclip:issues-view", name: "Ready to start", viewState: {} });

    expect(res.status).toBe(409);
  });

  it("rejects a patch that changes nothing", async () => {
    const app = await createApp(BOARD_USER);

    const res = await request(app)
      .patch("/api/companies/company-1/saved-task-views/view-1")
      .send({});

    expect(res.status).toBe(400);
    expect(mockSavedTaskViewService.update).not.toHaveBeenCalled();
  });

  it("returns 404 for a view the caller does not own", async () => {
    mockSavedTaskViewService.update.mockResolvedValue(null);
    const app = await createApp(BOARD_USER);

    const res = await request(app)
      .patch("/api/companies/company-1/saved-task-views/someone-elses-view")
      .send({ name: "Mine now" });

    expect(res.status).toBe(404);
  });

  it("deletes a view the caller owns and reports a miss as 404", async () => {
    const app = await createApp(BOARD_USER);
    const deleted = await request(app).delete("/api/companies/company-1/saved-task-views/view-1");
    expect(deleted.status).toBe(204);

    mockSavedTaskViewService.remove.mockResolvedValue(null);
    const missing = await request(app).delete("/api/companies/company-1/saved-task-views/view-2");
    expect(missing.status).toBe(404);
  });

  it("writes an activity entry for every mutation, and none for a miss", async () => {
    const app = await createApp(BOARD_USER);

    await request(app)
      .post("/api/companies/company-1/saved-task-views")
      .send({ collectionKey: "paperclip:issues-view", name: "Ready to start", viewState: {} });
    await request(app)
      .patch("/api/companies/company-1/saved-task-views/view-1")
      .send({ name: "Renamed" });
    await request(app).delete("/api/companies/company-1/saved-task-views/view-1");

    expect(mockLogActivity.mock.calls.map(([, input]) => input.action)).toEqual([
      "saved_task_view.created",
      "saved_task_view.updated",
      "saved_task_view.deleted",
    ]);
    const [, created] = mockLogActivity.mock.calls[0]!;
    expect(created).toMatchObject({
      companyId: "company-1",
      actorType: "user",
      entityType: "saved_task_view",
      entityId: "view-1",
      details: { userId: "user-1", collectionKey: "paperclip:issues-view" },
    });
    // Anyone with company_scope:read can read the activity log, but a saved
    // view is personal. So no text the user typed goes in the entry — not the
    // definition, which can hold their search terms, and not the name.
    expect(JSON.stringify(created.details)).not.toContain("viewState");
    expect(JSON.stringify(created.details)).not.toContain("Ready to start");

    const [, updated] = mockLogActivity.mock.calls[1]!;
    expect(updated.details).toEqual({
      userId: "user-1",
      collectionKey: "paperclip:issues-view",
      changed: ["name"],
    });
    expect(JSON.stringify(updated.details)).not.toContain("Renamed");

    const [, removed] = mockLogActivity.mock.calls[2]!;
    expect(removed.details).toEqual({ userId: "user-1", collectionKey: "paperclip:issues-view" });

    mockLogActivity.mockClear();
    mockSavedTaskViewService.remove.mockResolvedValue(null);
    await request(app).delete("/api/companies/company-1/saved-task-views/gone");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects reads for a company the board user cannot access", async () => {
    const app = await createApp({ ...BOARD_USER, companyIds: ["company-2"] });

    const res = await request(app).get("/api/companies/company-1/saved-task-views");

    expect(res.status).toBe(403);
    expect(mockSavedTaskViewService.list).not.toHaveBeenCalled();
  });

  it("rejects agent callers — saved views are personal", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      companyIds: ["company-1"],
      source: "agent_key",
    });

    const res = await request(app).get("/api/companies/company-1/saved-task-views");

    expect(res.status).toBe(403);
    expect(mockSavedTaskViewService.list).not.toHaveBeenCalled();
  });
});
