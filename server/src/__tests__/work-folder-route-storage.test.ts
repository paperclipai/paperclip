import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  loadConfig: vi.fn(() => ({ storageProvider: "local_disk" })),
  provider: vi.fn(() => ({})),
  ensure: vi.fn(async (owner) => owner),
  list: vi.fn(async () => ({ files: [] })),
}));
vi.mock("../config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../storage/provider-registry.js", () => ({ createStorageProviderFromConfig: mocks.provider }));
vi.mock("../services/work-folder-access.js", () => ({ assertWorkFolderAccess: mocks.access }));
vi.mock("../services/work-folders.js", () => ({
  workFolderService: () => ({ ensure: mocks.ensure, list: mocks.list }),
}));
import { workFolderRoutes } from "../routes/work-folders.js";

beforeEach(() => vi.clearAllMocks());

it("initializes storage only after access succeeds and reuses it while checking every request", async () => {
  const app = express();
  app.use("/api", workFolderRoutes({} as Db));
  app.use((_error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.sendStatus(403);
  });
  const base = "/api/companies/11111111-1111-4111-8111-111111111111/work-folders/task/22222222-2222-4222-8222-222222222222";
  expect(mocks.loadConfig).not.toHaveBeenCalled();
  mocks.access.mockRejectedValueOnce(new Error("denied"));
  await request(app).get(base).expect(403);
  expect(mocks.loadConfig).not.toHaveBeenCalled();
  await request(app).get(base).expect(200);
  await request(app).get(`${base}?trash=true`).expect(200);
  expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
  expect(mocks.provider).toHaveBeenCalledTimes(1);
  mocks.access.mockRejectedValueOnce(new Error("revoked"));
  await request(app).get(base).expect(403);
  expect(mocks.access).toHaveBeenCalledTimes(4);
  expect(mocks.list).toHaveBeenCalledTimes(2);
});

it.each([
  ["same-sandbox", "saved"], ["replacement-sandbox", "saved"],
  ["same-sandbox", "failed"], ["replacement-sandbox", "failed"],
])("keeps the last successful checkpoint visible after an interrupted run on %s (prior state %s)", async (sandboxKey, priorState) => {
  const oldSave = {
    folderRun: { runId: "saved-run", manifest: { agentId: "agent", sandboxKey: "same-sandbox" },
      state: priorState, lastSavedAt: new Date("2026-09-08T12:00:00Z"), error: null, refreshRequested: false },
    status: priorState === "failed" ? "failed" : "succeeded",
  };
  const interrupted = {
    folderRun: { runId: "interrupted-run", manifest: { agentId: "agent", sandboxKey },
      state: "starting", lastSavedAt: null, error: null, refreshRequested: false },
    status: "failed",
  };
  const query = { from: () => query, innerJoin: () => query, where: () => query,
    orderBy: () => query, limit: async () => [interrupted, oldSave] };
  const app = express();
  app.use("/api", workFolderRoutes({ select: () => query } as unknown as Db));
  const response = await request(app).get("/api/companies/11111111-1111-4111-8111-111111111111/work-folders/task/22222222-2222-4222-8222-222222222222/sync").expect(200);
  expect(response.body).toEqual([
    expect.objectContaining({ runId: "interrupted-run", state: "failed", active: false,
      error: "Run ended before its final file save completed.", lastSavedAt: null }),
    expect.objectContaining({ runId: "saved-run", state: priorState, lastSavedAt: "2026-09-08T12:00:00.000Z" }),
  ]);
});

it.each([true, false])("only retains unresolved failures when another sandbox saved the shared folder last (recovered: %s)", async (recovered) => {
  const entry = (runId: string, sandboxKey: string, state: string, at: string | null) => ({
    folderRun: { runId, manifest: { agentId: "agent", sandboxKey }, state,
      lastSavedAt: at ? new Date(at) : null, error: state === "failed" ? "Storage unavailable" : null,
      refreshRequested: false },
    status: state === "failed" ? "failed" : "succeeded",
  });
  const latest = entry("other-sandbox-save", "other", "saved", "2026-09-09T12:03:00Z");
  const success = entry("same-sandbox-save", "same", "saved", "2026-09-09T12:01:00Z");
  const failure = entry("failed-run", "same", "failed", null);
  // The query orders by updatedAt descending. The order within one sandbox
  // determines whether its failure remains unresolved, independently of the
  // newest checkpoint from another sandbox sharing this folder.
  const rows = recovered ? [latest, success, failure] : [latest, failure, success];
  const query = { from: () => query, innerJoin: () => query, where: () => query,
    orderBy: () => query, limit: async () => rows };
  const app = express();
  app.use("/api", workFolderRoutes({ select: () => query } as unknown as Db));
  const response = await request(app).get("/api/companies/11111111-1111-4111-8111-111111111111/work-folders/user/22222222-2222-4222-8222-222222222222/sync").expect(200);
  expect(response.body.map((status: { runId: string }) => status.runId))
    .toEqual(recovered ? ["other-sandbox-save"] : ["other-sandbox-save", "failed-run"]);
});

it.each([undefined, "2026-09-09T04:00:00.000Z"])(
  "distinguishes periodic saves from explicit finalization (%s)",
  async (finalCheckpointAt) => {
    const saved = {
      folderRun: { runId: "run", manifest: { agentId: "agent", sandboxKey: "sandbox", finalCheckpointAt },
        state: "saved", lastSavedAt: new Date("2026-09-09T04:00:00Z"), error: null, refreshRequested: false },
      status: "succeeded",
    };
    const query = { from: () => query, innerJoin: () => query, where: () => query,
      orderBy: () => query, limit: async () => [saved] };
    const app = express();
    app.use("/api", workFolderRoutes({ select: () => query } as unknown as Db));
    const response = await request(app).get("/api/companies/11111111-1111-4111-8111-111111111111/work-folders/task/22222222-2222-4222-8222-222222222222/sync").expect(200);
    expect(response.body).toEqual([expect.objectContaining({ runId: "run", state: "saved", active: false,
      lastSavedAt: "2026-09-09T04:00:00.000Z", finalCheckpointAt: finalCheckpointAt ?? null })]);
  },
);
