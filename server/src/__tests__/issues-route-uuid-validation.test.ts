import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  listComments: vi.fn(),
  getByIdentifier: vi.fn(),
  getAttachmentById: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  getById: vi.fn(),
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
  workProductService: () => mockWorkProductService,
}));

function createApp() {
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

describe("issues routes UUID validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      status: "todo",
    });
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.getAttachmentById.mockResolvedValue(null);
    mockWorkProductService.getById.mockResolvedValue(null);
  });

  it("returns 400 for invalid UUID-based list filters", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/issues?projectId=not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("projectId");
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid issue id path on comments routes", async () => {
    const res = await request(createApp()).get("/api/issues/not-a-uuid/comments");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid issue id");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid comment cursor in comment list query", async () => {
    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/comments?after=not-a-uuid",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("after comment cursor");
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
  });

  it("returns 400 when duplicate after cursors resolve to an invalid first value", async () => {
    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/comments?after=not-a-uuid&after=22222222-2222-4222-8222-222222222222",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("after comment cursor");
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid attachment ids before attachment lookup", async () => {
    const res = await request(createApp()).get("/api/attachments/not-a-uuid/content");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("attachmentId");
    expect(mockIssueService.getAttachmentById).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid work-product ids before work-product lookup", async () => {
    const res = await request(createApp())
      .patch("/api/work-products/not-a-uuid")
      .send({ title: "noop" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("work product id");
    expect(mockWorkProductService.getById).not.toHaveBeenCalled();
  });
});
