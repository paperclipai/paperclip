import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listComments: vi.fn(),
  markRead: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
    })),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({
      vote: null,
      consentEnabledNow: false,
      sharingEnabled: false,
    })),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

async function createApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Alias test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("nested-route aliases for flat issue routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("PATCH /companies/:companyId/issues/:id routes to the flat PATCH handler", async () => {
    const existing = makeIssue();
    const updated = makeIssue({ title: "Renamed" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const res = await request(await createApp())
      .patch(`/api/companies/company-1/issues/${existing.id}`)
      .send({ title: "Renamed" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledTimes(1);
    expect(res.body.title).toBe("Renamed");
  });

  it("POST /companies/:companyId/issues/:id/comments routes to the flat comment handler", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-alias-1",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "hello via nested",
    });

    const res = await request(await createApp())
      .post(`/api/companies/company-1/issues/${existing.id}/comments`)
      .send({ body: "hello via nested" });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(res.body.body).toBe("hello via nested");
  });

  it("POST /companies/:companyId/issues/:id/read routes to the flat handler", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.markRead.mockResolvedValue({
      issueId: existing.id,
      userId: "local-board",
      lastReadAt: new Date("2026-04-19T00:00:00Z"),
    });

    const res = await request(await createApp()).post(
      `/api/companies/company-1/issues/${existing.id}/read`,
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.markRead).toHaveBeenCalledTimes(1);
  });

  it("flat PATCH /issues/:id still works (no regression)", async () => {
    const existing = makeIssue();
    const updated = makeIssue({ title: "Still flat" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ title: "Still flat" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Still flat");
  });
});
