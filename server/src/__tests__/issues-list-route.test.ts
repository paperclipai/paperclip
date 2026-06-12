import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const VALID_UUID = "33333333-3333-4333-8333-333333333333";
const OTHER_UUID = "44444444-4444-4444-8444-444444444444";
const COMPANY_ID = "company-1";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  decide: vi.fn(async () => ({ allowed: true })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => [COMPANY_ID]),
}));

function chainable(): any {
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (value: unknown) => unknown) => resolve([]);
      }
      return () => proxy;
    },
  };
  const proxy: any = new Proxy(() => proxy, handler);
  return proxy;
}

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  execute: vi.fn(async () => []),
}));

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    companyService: () => ({
      getById: vi.fn(async () => ({ id: COMPANY_ID, attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({ getById: vi.fn() }),
    documentService: () => ({}),
    environmentService: () => ({}),
    executionWorkspaceService: () => ({ getById: vi.fn() }),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({ getById: vi.fn(), getDefaultCompanyGoal: vi.fn() }),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
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
    }),
    issueService: () => mockIssueService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({ getById: vi.fn(), listByIds: vi.fn() }),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
  };
});

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({ getById: vi.fn() }),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("GET /api/companies/:companyId/issues — assigneeAgentId filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnValue(chainable());
    mockIssueService.list.mockResolvedValue([]);
  });

  it("maps assigneeAgentId=null query string to a JS null filter (unassigned sentinel)", async () => {
    const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/issues?assigneeAgentId=null`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledTimes(1);
    expect(mockIssueService.list.mock.calls[0]?.[1]).toMatchObject({ assigneeAgentId: null });
  });

  it("preserves the original reproducer combination (assigneeAgentId=null & status=todo)", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_ID}/issues?assigneeAgentId=null&status=todo`,
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.list.mock.calls[0]?.[1]).toMatchObject({
      assigneeAgentId: null,
      status: "todo",
    });
  });

  it("passes a valid UUID through unchanged", async () => {
    const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/issues?assigneeAgentId=${VALID_UUID}`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list.mock.calls[0]?.[1]).toMatchObject({ assigneeAgentId: VALID_UUID });
  });

  it("rejects a non-UUID, non-sentinel assigneeAgentId with HTTP 400", async () => {
    const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/issues?assigneeAgentId=not-a-uuid`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "assigneeAgentId must be a UUID or 'null'" });
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("treats an absent assigneeAgentId as undefined (no filter)", async () => {
    const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/issues`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list.mock.calls[0]?.[1]?.assigneeAgentId).toBeUndefined();
  });

  it("rejects a non-UUID participantAgentId with HTTP 400", async () => {
    const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/issues?participantAgentId=not-a-uuid`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "participantAgentId must be a UUID" });
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("does not treat the literal 'null' string as a sentinel for participantAgentId", async () => {
    const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/issues?participantAgentId=null`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "participantAgentId must be a UUID" });
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("passes a valid participantAgentId UUID through unchanged alongside a sentinel assignee filter", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_ID}/issues?assigneeAgentId=null&participantAgentId=${OTHER_UUID}`,
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.list.mock.calls[0]?.[1]).toMatchObject({
      assigneeAgentId: null,
      participantAgentId: OTHER_UUID,
    });
  });
});

describe.sequential("GET /api/companies/:companyId/issues/count — assigneeAgentId filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnValue(chainable());
    mockIssueService.count.mockResolvedValue(0);
  });

  it("maps assigneeAgentId=null query string to a JS null filter (unassigned sentinel)", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_ID}/issues/count?attention=blocked&assigneeAgentId=null`,
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.count).toHaveBeenCalledTimes(1);
    expect(mockIssueService.count.mock.calls[0]?.[1]).toMatchObject({
      attention: "blocked",
      assigneeAgentId: null,
    });
  });

  it("passes a valid UUID assigneeAgentId through unchanged", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_ID}/issues/count?attention=blocked&assigneeAgentId=${VALID_UUID}`,
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.count.mock.calls[0]?.[1]).toMatchObject({
      attention: "blocked",
      assigneeAgentId: VALID_UUID,
    });
  });

  it("rejects a non-UUID, non-sentinel assigneeAgentId with HTTP 400", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_ID}/issues/count?attention=blocked&assigneeAgentId=not-a-uuid`,
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "assigneeAgentId must be a UUID or 'null'" });
    expect(mockIssueService.count).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID participantAgentId with HTTP 400", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_ID}/issues/count?attention=blocked&participantAgentId=not-a-uuid`,
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "participantAgentId must be a UUID" });
    expect(mockIssueService.count).not.toHaveBeenCalled();
  });
});
