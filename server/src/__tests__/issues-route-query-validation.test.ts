import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";

const listMock = vi.fn();

vi.mock("../services/index.js", () => ({
  issueService: () => ({
    list: listMock,
  }),
  accessService: () => ({}),
  agentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  documentService: () => ({}),
  logActivity: vi.fn(),
  projectService: () => ({}),
  routineService: () => ({}),
  workProductService: () => ({}),
}));

describe("issue routes query validation", () => {
  beforeEach(() => {
    listMock.mockReset();
    listMock.mockResolvedValue([]);
  });

  it("rejects invalid assigneeAgentId query strings with a 400", async () => {
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
    app.use("/api", issueRoutes({} as any, {} as any));

    const res = await request(app).get("/api/companies/company-1/issues?assigneeAgentId=null");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "assigneeAgentId must be a valid UUID",
    });
    expect(listMock).not.toHaveBeenCalled();
  });

  it("passes valid UUID assigneeAgentId values through to the service", async () => {
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
    app.use("/api", issueRoutes({} as any, {} as any));

    const assigneeAgentId = "11111111-1111-4111-8111-111111111111";
    const res = await request(app).get(`/api/companies/company-1/issues?assigneeAgentId=${assigneeAgentId}`);

    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        assigneeAgentId,
      }),
    );
  });
});
