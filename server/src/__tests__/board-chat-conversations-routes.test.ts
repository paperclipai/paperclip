import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  getById: vi.fn(),
}));
const mockAssertInstanceAdmin = vi.hoisted(() => vi.fn());
const mockAssertCompanyAccess = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  issueService: () => mockIssueService,
}));

vi.mock("../routes/authz.js", () => ({
  getActorInfo: () => ({ actorType: "user", actorId: "user-1", agentId: null, runId: null }),
  assertCompanyAccess: mockAssertCompanyAccess,
  assertInstanceAdmin: mockAssertInstanceAdmin,
}));

async function createApp(
  deploymentMode: "local_trusted" | "authenticated" = "local_trusted",
  deploymentExposure: "private" | "public" = "private",
) {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const app = express();
  app.use(express.json());
  app.use("/api", boardChatRoutes({} as any, { deploymentMode, deploymentExposure }));
  return app;
}

const OPEN_BOARD_ISSUE = {
  id: "issue-open",
  companyId: "company-1",
  identifier: "PAP-1",
  title: "How is hiring going?",
  originKind: "board_chat",
  status: "todo",
  assigneeAgentId: null,
  assigneeUserId: null,
};

describe("POST /api/board/chat/conversations (PAP-11123)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.create.mockResolvedValue({ id: "issue-new", originKind: "board_chat" });
    mockIssueService.update.mockResolvedValue(undefined);
    mockIssueService.getById.mockResolvedValue(null);
  });

  it("returns 403 FEATURE_DISABLED when enableConferenceRoomChat is off", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: false });
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/conversations")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Conference Room Chat is not enabled",
      code: "FEATURE_DISABLED",
    });
    // The guard must fire before any authz check or persistence.
    expect(mockAssertInstanceAdmin).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("returns 400 when companyId is missing", async () => {
    const app = await createApp();

    const res = await request(app).post("/api/board/chat/conversations").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "companyId is required" });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("enforces instance-admin + company access before resolving", async () => {
    const app = await createApp();

    await request(app)
      .post("/api/board/chat/conversations")
      .send({ companyId: "company-1" });

    expect(mockAssertInstanceAdmin).toHaveBeenCalledTimes(1);
    expect(mockAssertCompanyAccess).toHaveBeenCalledWith(expect.anything(), "company-1");
  });

  it("reuses the most-recent open board_chat issue without creating", async () => {
    mockIssueService.list.mockResolvedValue([OPEN_BOARD_ISSUE]);
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/conversations")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(res.body.issue.id).toBe("issue-open");
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ originKind: "board_chat" }),
    );
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("reuses a done board_chat issue because stable URLs stay available until cancellation", async () => {
    mockIssueService.list.mockResolvedValue([{ ...OPEN_BOARD_ISSUE, id: "issue-done", status: "done" }]);
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/conversations")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(res.body.issue.id).toBe("issue-done");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("mints an origin-tagged todo issue when no conversation is open", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/conversations")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(res.body.issue.id).toBe("issue-new");
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        originKind: "board_chat",
        status: "todo",
        title: "New chat",
      }),
    );
  });

  it("forces a fresh conversation when newConversation is set, even with an open one", async () => {
    mockIssueService.list.mockResolvedValue([OPEN_BOARD_ISSUE]);
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/conversations")
      .send({ companyId: "company-1", newConversation: true });

    expect(res.status).toBe(200);
    expect(res.body.issue.id).toBe("issue-new");
    // newConversation skips reuse — no list lookup, straight to create.
    expect(mockIssueService.list).not.toHaveBeenCalled();
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ originKind: "board_chat" }),
    );
  });

  it("does not expose the retired legacy stream endpoint", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(404);
    expect(mockGetExperimental).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("resolves a valid direct board_chat conversation ref without creating", async () => {
    mockIssueService.getById.mockResolvedValue(OPEN_BOARD_ISSUE);
    const app = await createApp();

    const res = await request(app)
      .get("/api/board/chat/conversations/PAP-1")
      .query({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issue: expect.objectContaining({ id: "issue-open", identifier: "PAP-1" }),
      unavailableReason: null,
    });
    expect(mockIssueService.getById).toHaveBeenCalledWith("PAP-1");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", null],
    ["cancelled", { ...OPEN_BOARD_ISSUE, status: "cancelled" }],
    ["wrong_company", { ...OPEN_BOARD_ISSUE, companyId: "company-2" }],
    ["wrong_kind", { ...OPEN_BOARD_ISSUE, originKind: "manual" }],
  ])("returns %s for unavailable direct conversation refs", async (reason, issue) => {
    mockIssueService.getById.mockResolvedValue(issue);
    const app = await createApp();

    const res = await request(app)
      .get("/api/board/chat/conversations/some-ref")
      .query({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issue: null, unavailableReason: reason });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });
});
