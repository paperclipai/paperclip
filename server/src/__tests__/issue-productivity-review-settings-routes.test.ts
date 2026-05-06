import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  getByIdentifier: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getRelationSummaries: vi.fn(),
  getDependencyReadiness: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueReferenceService = vi.hoisted(() => ({
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  companyService: () => mockCompanyService,
  environmentService: () => mockEnvironmentService,
  issueReferenceService: () => mockIssueReferenceService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  executionWorkspaceService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    getRun: vi.fn(),
    getActiveRunForAgent: vi.fn(),
  }),
  issueApprovalService: () => ({
    listApprovalsForIssue: vi.fn(),
    unlink: vi.fn(),
  }),
  documentService: () => ({}),
  routineService: () => ({}),
  workProductService: () => ({}),
  projectService: () => ({}),
  ISSUE_LIST_DEFAULT_LIMIT: 500,
  ISSUE_LIST_MAX_LIMIT: 1000,
  clampIssueListLimit: (value: number) => value,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    normalizeEnvBindingsForPersistence: vi.fn(async (_companyId: string, env: Record<string, unknown>) => env),
  }),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

let server: Server | null = null;

function createApp() {
  server ??= buildApp().listen(0);
  return server;
}

describe.sequential("productivity review settings route validation", () => {
  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    }
  });

  beforeEach(() => {
    mockIssueService.create.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.getRelationSummaries.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockCompanyService.getById.mockReset();
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      attachmentMaxBytes: 10 * 1024 * 1024,
    });
    mockLogActivity.mockReset();
  });

  it("returns 422 when issue create body has an unknown disabled trigger", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Bad triggers",
        productivityReviewSettings: { disabledTriggers: ["bogus_trigger"] },
      });

    expect(res.status).toBe(422);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("returns 422 when issue PATCH body has an unknown disabled trigger", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: null,
      assigneeUserId: "user-1",
      executionWorkspaceId: null,
      executionWorkspaceSettings: null,
      productivityReviewSettings: null,
    });

    const res = await request(createApp())
      .patch("/api/issues/issue-1")
      .send({
        productivityReviewSettings: { disabledTriggers: ["not_a_real_trigger"] },
      });

    expect(res.status).toBe(422);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("accepts valid disabled triggers on issue create body", async () => {
    mockIssueService.create.mockResolvedValue({
      id: "issue-2",
      companyId: "company-1",
      title: "Valid triggers",
      identifier: "ABC-2",
      status: "backlog",
      productivityReviewSettings: { disabledTriggers: ["long_active_duration"] },
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Valid triggers",
        productivityReviewSettings: { disabledTriggers: ["long_active_duration"] },
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        productivityReviewSettings: { disabledTriggers: ["long_active_duration"] },
      }),
    );
  });
});
