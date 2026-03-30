import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
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

function createApp(actorOverride?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...actorOverride,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issues list query parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([]);
  });

  it("normalizes duplicate query params to safe strings for issue listing", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_ID}/issues?status=todo&status=done&q=alpha&q=beta&includeRoutineExecutions=true&includeRoutineExecutions=false`,
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        status: "todo",
        q: "alpha",
        includeRoutineExecutions: true,
      }),
    );
  });

  it("prefers first non-empty duplicate query values", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_ID}/issues?status=&status=done&q=&q=beta`,
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        status: "done",
        q: "beta",
      }),
    );
  });

  it("normalizes comma-separated status filters before calling service", async () => {
    const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/issues?status=todo,,in_progress,`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        status: "todo,in_progress",
      }),
    );
  });

  it("normalizes status/origin filters for case and surrounding whitespace", async () => {
    const originId = "22222222-2222-4222-8222-222222222222";
    const uppercaseOriginId = originId.toUpperCase();
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_ID}/issues?status=%20TODO,%20IN_PROGRESS%20&originKind=%20ROUTINE_EXECUTION%20&originId=%20${uppercaseOriginId}%20`,
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        status: "todo,in_progress",
        originKind: "routine_execution",
        originId,
      }),
    );
  });

  it("normalizes me user filters for case and surrounding whitespace", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_ID}/issues?assigneeUserId=%20ME%20&touchedByUserId=%20Me%20&unreadForUserId=%20mE%20`,
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        assigneeUserId: "local-board",
        touchedByUserId: "local-board",
        unreadForUserId: "local-board",
      }),
    );
  });

  it("returns 403 for me user filters when board user id is malformed", async () => {
    const res = await request(createApp({ userId: { bad: true } })).get(
      `/api/companies/${COMPANY_ID}/issues?assigneeUserId=me`,
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("assigneeUserId=me");
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid status filters instead of passing bad enum values to service", async () => {
    const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/issues?status=todo,not_a_status`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid status filter");
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid originKind filters instead of passing bad enum values to service", async () => {
    const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/issues?originKind=unexpected`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid originKind filter");
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("returns 400 for routine_execution origin filters with malformed originId", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_ID}/issues?originKind=routine_execution&originId=not-a-uuid`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("originId");
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid includeRoutineExecutions query values", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_ID}/issues?includeRoutineExecutions=maybe`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("includeRoutineExecutions");
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });
});
