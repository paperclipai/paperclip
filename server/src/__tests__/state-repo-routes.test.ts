import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stateRepoRoutes } from "../routes/state-repo.js";

const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));

const mockRemotes = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), clear: vi.fn() }));
vi.mock("../services/state-repo-remote.js", () => ({ stateRepoRemoteService: () => mockRemotes }));

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
  beforeEach(() => {
    mockLogActivity.mockReset();
    mockRemotes.get.mockReset();
    mockRemotes.set.mockReset();
    mockRemotes.clear.mockReset();
  });

  it("returns the per-company commit log", async () => {
    const commits = [{ hash: "a".repeat(40), shortHash: "aaaaaaaa", author: "Fable", authorEmail: "f@p.invalid", committer: "paperclip-state-bot", date: "2026-07-21T00:00:00Z", subject: "agent-instructions: update Fable" }];
    const service = { log: vi.fn().mockResolvedValue(commits) };
    const response = await request(createApp(service)).get("/api/companies/company-1/state-repo/log?limit=10");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ commits });
    expect(service.log).toHaveBeenCalledWith("company-1", 10);
  });

  it("reads and writes the mirror remote config, rejecting non-https urls", async () => {
    mockRemotes.get.mockResolvedValue(null);
    const readEmpty = await request(createApp({})).get("/api/companies/company-1/state-repo/remote");
    expect(readEmpty.body).toEqual({ remote: null });

    const bad = await request(createApp({}))
      .put("/api/companies/company-1/state-repo/remote")
      .send({ remoteUrl: "git@github.com:me/repo.git" });
    expect(bad.status).toBe(422);

    const saved = { companyId: "company-1", remoteUrl: "https://github.com/me/repo.git", secretId: "sec-1", secretVersion: "latest", updatedAt: "2026-07-21T00:00:00Z" };
    mockRemotes.set.mockResolvedValue(saved);
    const ok = await request(createApp({}))
      .put("/api/companies/company-1/state-repo/remote")
      .send({ remoteUrl: "https://github.com/me/repo.git", secretId: "sec-1", secretVersion: "latest" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ remote: saved });
    expect(mockRemotes.set).toHaveBeenCalledWith("company-1", { remoteUrl: "https://github.com/me/repo.git", secretId: "sec-1", secretVersion: "latest" });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "company.state_repo_remote_configured" }));
  });

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
