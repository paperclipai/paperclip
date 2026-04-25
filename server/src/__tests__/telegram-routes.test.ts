import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { telegramRoutes } from "../routes/telegram.js";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getByIdentifier: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  processWakeupRequest: vi.fn(),
}));

const mockRoutineService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  runRoutine: vi.fn(),
}));

const mockQueueIssueAssignmentWakeup = vi.hoisted(() => vi.fn());

const mockTelegramNotify = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  heartbeatService: () => mockHeartbeatService,
  routineService: () => mockRoutineService,
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockQueueIssueAssignmentWakeup,
}));

vi.mock("../services/telegram-notify.js", () => ({
  telegramNotify: mockTelegramNotify,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", telegramRoutes({} as any));
  return app;
}

describe("telegram /routines command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists routines with full UUID, escaped title/status, and schedule", async () => {
    mockRoutineService.list.mockResolvedValue([
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        companyId: "dbc742c7-9a38-4542-936b-523dfa3a7fd2",
        title: "Daily <script>alert('xss')</script> Report",
        status: "active & running",
        triggers: [{ kind: "schedule", label: "daily 9am" }],
      },
      {
        id: "660e8400-e29b-41d4-a716-446655440001",
        companyId: "dbc742c7-9a38-4542-936b-523dfa3a7fd2",
        title: "Weekly Sync",
        status: "active",
        triggers: [],
      },
    ]);

    const res = await request(createApp())
      .post("/api/telegram/ingest")
      .send({ chat_id: 123, text: "/routines" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: "routines", count: 2 });
    expect(mockRoutineService.list).toHaveBeenCalledWith("dbc742c7-9a38-4542-936b-523dfa3a7fd2");

    // P1: full UUID displayed
    expect(mockTelegramNotify.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("550e8400-e29b-41d4-a716-446655440000"),
        parse_mode: "HTML",
      }),
    );

    // P2: HTML escaping prevents injection
    const sentMessage = mockTelegramNotify.send.mock.calls[0][0].text;
    expect(sentMessage).toContain("&lt;script&gt;");
    expect(sentMessage).toContain("active &amp; running");
    expect(sentMessage).not.toContain("<script>");
  });

  it("handles empty routine list", async () => {
    mockRoutineService.list.mockResolvedValue([]);

    const res = await request(createApp())
      .post("/api/telegram/ingest")
      .send({ chat_id: 123, text: "/routines" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: "routines", count: 0 });
    expect(mockTelegramNotify.info).toHaveBeenCalledWith("📋 No routines configured.");
  });

  it("only matches exact /routines command (no trailing text)", async () => {
    mockIssueService.create.mockResolvedValue({
      id: "issue-1",
      identifier: "ANGA-100",
      title: "/routines with extra text",
    });

    const res = await request(createApp())
      .post("/api/telegram/ingest")
      .send({ chat_id: 123, text: "/routines with extra text" });

    // Should create issue instead of listing routines
    expect(res.status).toBe(200);
    expect(res.body.action).toBe("issue");
    expect(mockRoutineService.list).not.toHaveBeenCalled();
    expect(mockIssueService.create).toHaveBeenCalled();
  });
});

describe("telegram /run_routine command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes routine after company-scoped validation", async () => {
    const routineId = "550e8400-e29b-41d4-a716-446655440000";
    mockRoutineService.get.mockResolvedValue({
      id: routineId,
      companyId: "dbc742c7-9a38-4542-936b-523dfa3a7fd2",
      title: "Test Routine",
      status: "active",
    });
    mockRoutineService.runRoutine.mockResolvedValue({
      id: "run-123",
      status: "queued",
    });

    const res = await request(createApp())
      .post("/api/telegram/ingest")
      .send({ chat_id: 123, text: `/run_routine ${routineId}` });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      action: "run_routine",
      routineId,
      runId: "run-123",
      status: "queued",
    });

    // P0 security: company validation called before execution
    expect(mockRoutineService.get).toHaveBeenCalledWith(routineId);
    expect(mockRoutineService.runRoutine).toHaveBeenCalledWith(
      routineId,
      { source: "manual" },
    );
  });

  it("rejects routine from different company (P0 security)", async () => {
    const routineId = "550e8400-e29b-41d4-a716-446655440000";
    mockRoutineService.get.mockResolvedValue({
      id: routineId,
      companyId: "different-company-id",
      title: "Cross-company routine",
      status: "active",
    });

    const res = await request(createApp())
      .post("/api/telegram/ingest")
      .send({ chat_id: 123, text: `/run_routine ${routineId}` });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("not found or access denied");
    expect(mockRoutineService.runRoutine).not.toHaveBeenCalled();
    expect(mockTelegramNotify.error).toHaveBeenCalledWith(
      expect.stringContaining("not found or access denied"),
    );
  });

  it("handles invalid routine ID gracefully", async () => {
    mockRoutineService.get.mockRejectedValue(new Error("Routine not found"));

    const res = await request(createApp())
      .post("/api/telegram/ingest")
      .send({ chat_id: 123, text: "/run_routine invalid-id" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Routine not found");
    expect(mockTelegramNotify.info).toHaveBeenCalledWith(
      expect.stringContaining("Failed to run routine"),
    );
  });

  it("handles service error during routine execution", async () => {
    const routineId = "550e8400-e29b-41d4-a716-446655440000";
    mockRoutineService.get.mockResolvedValue({
      id: routineId,
      companyId: "dbc742c7-9a38-4542-936b-523dfa3a7fd2",
    });
    mockRoutineService.runRoutine.mockRejectedValue(new Error("Execution service unavailable"));

    const res = await request(createApp())
      .post("/api/telegram/ingest")
      .send({ chat_id: 123, text: `/run_routine ${routineId}` });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Execution service unavailable");
    expect(mockTelegramNotify.info).toHaveBeenCalledWith(
      expect.stringContaining("Execution service unavailable"),
    );
  });

  it("parses routine ID correctly and rejects malformed input", async () => {
    mockIssueService.create.mockResolvedValue({
      id: "issue-1",
      identifier: "ANGA-101",
    });

    // Missing routine ID
    const res1 = await request(createApp())
      .post("/api/telegram/ingest")
      .send({ chat_id: 123, text: "/run_routine" });

    expect(res1.body.action).toBe("issue");
    expect(mockRoutineService.get).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockIssueService.create.mockResolvedValue({
      id: "issue-2",
      identifier: "ANGA-102",
    });

    // Multiple arguments (should fail regex)
    const res2 = await request(createApp())
      .post("/api/telegram/ingest")
      .send({ chat_id: 123, text: "/run_routine id1 id2" });

    expect(res2.body.action).toBe("issue");
    expect(mockRoutineService.get).not.toHaveBeenCalled();
  });
});

describe("telegram command precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prioritizes /routines over /comment and /issue", async () => {
    mockRoutineService.list.mockResolvedValue([]);

    await request(createApp())
      .post("/api/telegram/ingest")
      .send({ chat_id: 123, text: "/routines" });

    expect(mockRoutineService.list).toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("prioritizes /run_routine over /comment and /issue", async () => {
    const routineId = "550e8400-e29b-41d4-a716-446655440000";
    mockRoutineService.get.mockResolvedValue({
      id: routineId,
      companyId: "dbc742c7-9a38-4542-936b-523dfa3a7fd2",
    });
    mockRoutineService.runRoutine.mockResolvedValue({ id: "run-1", status: "queued" });

    await request(createApp())
      .post("/api/telegram/ingest")
      .send({ chat_id: 123, text: `/run_routine ${routineId}` });

    expect(mockRoutineService.runRoutine).toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });
});

describe("telegram input validation", () => {
  it("rejects missing text field", async () => {
    const res = await request(createApp())
      .post("/api/telegram/ingest")
      .send({ chat_id: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("text is required");
  });

  it("rejects non-string text field", async () => {
    const res = await request(createApp())
      .post("/api/telegram/ingest")
      .send({ chat_id: 123, text: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("text is required");
  });
});
