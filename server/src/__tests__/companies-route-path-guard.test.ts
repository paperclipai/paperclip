import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      list: vi.fn(),
      stats: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      remove: vi.fn(),
    }),
    companyPortabilityService: () => ({
      exportBundle: vi.fn(),
      previewExport: vi.fn(),
      previewImport: vi.fn(),
      importBundle: vi.fn(),
    }),
    accessService: () => ({
      canUser: vi.fn(),
      ensureMembership: vi.fn(),
    }),
    budgetService: () => ({
      upsertPolicy: vi.fn(),
    }),
    agentService: () => ({
      getById: vi.fn(),
    }),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(),
      listFeedbackTraces: vi.fn(),
      getFeedbackTraceById: vi.fn(),
      saveIssueVote: vi.fn(),
    }),
    logActivity: vi.fn(),
  }));
}

describe("company routes malformed issue path guard", () => {
  it("returns a clear error when companyId is missing for issues list path", async () => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/companies.js");
    registerModuleMocks();
    const { companyRoutes } = await import("../routes/companies.js");

    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      };
      next();
    });
    app.use("/api/companies", companyRoutes({} as any));

    const res = await request(app).get("/api/companies/issues");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });
});
