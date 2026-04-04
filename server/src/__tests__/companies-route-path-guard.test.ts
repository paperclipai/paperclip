import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";

vi.mock("../services/index.js", () => ({
  executionWorkspaceService: () => ({ findById: vi.fn(async () => null) }),
  goalService: () => ({ findById: vi.fn(async () => null) }),
  heartbeatService: () => ({ findRunById: vi.fn(async () => null), queueIssueAssignmentWakeup: vi.fn() }),
  instanceSettingsService: () => ({ getSettings: vi.fn(async () => ({})), findByCompany: vi.fn(async () => null) }),
  issueApprovalService: () => ({ findById: vi.fn(async () => null) }),
  issueService: () => ({ findById: vi.fn(async () => null), update: vi.fn(async (id: string, data: any) => ({ id, ...data })), countRecentByAgent: vi.fn(async () => 0) }),
  documentService: () => ({ findByIssueAndKey: vi.fn(async () => null) }),
  projectService: () => ({ findById: vi.fn(async () => null) }),
  routineService: () => ({ findById: vi.fn(async () => null) }),
  workProductService: () => ({ findByIssue: vi.fn(async () => []) }),
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

describe("company routes malformed issue path guard", () => {
  it("returns a clear error when companyId is missing for issues list path", async () => {
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
