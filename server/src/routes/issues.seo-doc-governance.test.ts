import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "./issues.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => mockDocumentsService,
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => ({ wakeup: vi.fn(async () => undefined), reportRunActivity: vi.fn(async () => undefined) }),
  instanceSettingsService: () => ({
    getExperimental: vi.fn(async () => ({})),
    getGeneral: vi.fn(async () => ({ feedbackDataSharingPreference: "prompt" })),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as {
      actor: {
        type: string;
        userId: string;
        companyIds: string[];
        source: string;
        isInstanceAdmin: boolean;
      };
    }).actor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as never, {} as never));
  app.use(errorHandler);
  return app;
}

describe("issues route seo governance validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "INS-316",
      title: "Governed doc",
      status: "in_progress",
    });
  });

  it("returns actionable 422 details for seo governance validation failures", async () => {
    mockDocumentsService.upsertIssueDocument.mockRejectedValue(
      new HttpError(422, "Invalid seo_governance metadata", {
        code: "missing_update_cadence",
        fields: [{ field: "seo_governance.update_cadence", message: "update_cadence is required" }],
      }),
    );

    const res = await request(createApp())
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({
        title: "Plan",
        format: "markdown",
        body: "---\nseo_governance:\n  owner: cto\n---\n",
      });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Invalid seo_governance metadata",
      details: {
        code: "missing_update_cadence",
        fields: [{ field: "seo_governance.update_cadence", message: "update_cadence is required" }],
      },
    });
  });
});
