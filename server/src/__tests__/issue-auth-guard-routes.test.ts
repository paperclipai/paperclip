import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const stubIssue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "c1",
  status: "todo",
  title: "stub",
  identifier: "PAP-1",
  assigneeAgentId: null,
  assigneeUserId: null,
  executionPolicy: null,
  executionState: null,
};

const stubAttachment = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "c1",
  issueId: "issue-1",
  objectKey: "issues/issue-1/file.txt",
  contentType: "text/plain",
  byteSize: 0,
  originalFilename: "file.txt",
};

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => ({}),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => ({ wakeup: vi.fn(), reportRunActivity: vi.fn() }),
  issueApprovalService: () => ({}),
  issueService: () => ({
    getById: vi.fn(async () => stubIssue),
    getAttachmentById: vi.fn(async () => stubAttachment),
  }),
  logActivity: vi.fn(),
  projectService: () => ({}),
  routineService: () => ({ syncRunStatusForIssue: vi.fn() }),
  workProductService: () => ({}),
  feedbackService: () => ({}),
  instanceSettingsService: () => ({}),
  assetService: () => ({}),
  chatService: () => ({}),
}));

function createApp(actorType: "none" | "board") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor =
      actorType === "board"
        ? { type: "board", userId: "local-board", companyIds: ["c1"], source: "local_implicit", isInstanceAdmin: true }
        : { type: "none", source: "none" };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue-scoped auth guard", () => {
  const issueId = "11111111-1111-4111-8111-111111111111";

  it("returns 401 for unauthenticated GET /api/issues/:id", async () => {
    const res = await request(createApp("none")).get(`/api/issues/${issueId}`);
    expect(res.status).toBe(401);
  });

  it("returns 401 for unauthenticated GET /api/issues/:id/comments", async () => {
    const res = await request(createApp("none")).get(`/api/issues/${issueId}/comments`);
    expect(res.status).toBe(401);
  });

  it("returns 401 for unauthenticated POST /api/issues/:id/checkout", async () => {
    const res = await request(createApp("none"))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: "22222222-2222-4222-8222-222222222222", expectedStatuses: ["todo"] });
    expect(res.status).toBe(401);
  });

  it("returns 401 for unauthenticated GET /api/attachments/:id/content", async () => {
    const res = await request(createApp("none")).get(`/api/attachments/${issueId}/content`);
    expect(res.status).toBe(401);
  });

  it("does not block authenticated requests", async () => {
    // Authenticated request reaches the handler (which returns 404 for missing issue — that's fine)
    const res = await request(createApp("board")).get(`/api/issues/${issueId}`);
    expect(res.status).not.toBe(401);
  });
});
