import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stateRepoRoutes } from "../routes/state-repo.js";

const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));

function createApp(service: Record<string, ReturnType<typeof vi.fn>>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
    next();
  });
  app.use("/api", stateRepoRoutes({} as never, service as never, "/tmp"));
  return app;
}

describe("state repo routes", () => {
  beforeEach(() => mockLogActivity.mockReset());

  it("returns company-scoped mirror health", async () => {
    const service = { health: vi.fn().mockResolvedValue({ configured: true, healthy: true }) };
    const response = await request(createApp(service)).get("/api/companies/company-1/state-repo/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ configured: true, healthy: true });
    expect(service.health).toHaveBeenCalledWith("company-1");
  });

  it("tests the configured mirror", async () => {
    const service = {
      testMirror: vi.fn().mockResolvedValue(undefined),
      health: vi.fn().mockResolvedValue({ configured: true, healthy: true }),
    };
    const response = await request(createApp(service)).post("/api/companies/company-1/state-repo/mirror/test");
    expect(response.status).toBe(200);
    expect(service.testMirror).toHaveBeenCalledWith("company-1");
  });

  it("restores state and records activity", async () => {
    const service = { restore: vi.fn().mockResolvedValue({ restored: ["agents/a/AGENTS.md"], dryRun: false }) };
    const response = await request(createApp(service))
      .post("/api/companies/company-1/state-repo/restore")
      .send({ source: "/backup/state.git", ref: "main" });
    expect(response.status).toBe(200);
    expect(service.restore).toHaveBeenCalledWith("company-1", "/backup/state.git", "main", false);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      action: "company.state_repo_restored",
    }));
  });
});
