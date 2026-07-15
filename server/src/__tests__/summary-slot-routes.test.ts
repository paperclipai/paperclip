import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";
const agentId = "11111111-1111-4111-8111-111111111111";
const projectId = "44444444-4444-4444-8444-444444444444";
const slotId = "55555555-5555-4555-8555-555555555555";
const generatingIssueId = "66666666-6666-4666-8666-666666666666";

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  canUser: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockSummarySlotService = vi.hoisted(() => ({
  getSlot: vi.fn(),
  listRevisions: vi.fn(),
  generate: vi.fn(),
  write: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockHeartbeatWakeup = vi.hoisted(() => vi.fn());

function slot(overrides: Record<string, unknown> = {}) {
  return {
    id: slotId,
    companyId,
    scopeKind: "project",
    scopeId: projectId,
    slotKey: "header",
    documentId: null,
    status: "idle",
    failureReason: null,
    generatingIssueId: null,
    lastGeneratedAt: null,
    lastGeneratedByAgentId: null,
    lastModel: null,
    createdAt: new Date("2026-07-14T00:00:00.000Z"),
    updatedAt: new Date("2026-07-14T00:00:00.000Z"),
    ...overrides,
  };
}

function generatingIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: generatingIssueId,
    identifier: "PAP-1000",
    title: "Summarize project",
    status: "todo",
    assigneeAgentId: agentId,
    ...overrides,
  };
}

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    heartbeatService: () => ({ wakeup: mockHeartbeatWakeup }),
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/summary-slots.js", () => ({
    summarySlotService: () => mockSummarySlotService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ summarySlotRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/summary-slots.js")>("../routes/summary-slots.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", summarySlotRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "board-user",
  companyIds: [companyId],
  source: "session",
  isInstanceAdmin: false,
};

const agentActor = {
  type: "agent",
  agentId,
  companyId,
  source: "agent_jwt",
  runId: "run-123",
};

const slotPath = `/api/companies/${companyId}/summary-slots/project/header?scopeId=${projectId}`;

describe("summary slot routes", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true, explanation: "Allowed." });
    mockAccessService.canUser.mockResolvedValue(true);
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableSummaries: true });
    mockHeartbeatWakeup.mockResolvedValue({ id: "run-1" });
    mockSummarySlotService.getSlot.mockResolvedValue({ slot: slot(), document: null, generatingIssue: null });
    mockSummarySlotService.listRevisions.mockResolvedValue({ slot: slot(), revisions: [] });
    mockSummarySlotService.generate.mockResolvedValue({
      slot: slot({ status: "generating", generatingIssueId }),
      generatingIssue: generatingIssue(),
      alreadyGenerating: false,
    });
    mockSummarySlotService.write.mockResolvedValue({
      slot: slot({ documentId: "doc-1", status: "idle" }),
      document: { id: "doc-1", companyId, format: "markdown", body: "# Summary" },
      revision: { id: "rev-1", documentId: "doc-1", revisionNumber: 1 },
    });
  });

  describe("read routes", () => {
    it("returns slot state for actors with company access", async () => {
      const app = await createApp(boardActor);
      const res = await request(app).get(slotPath);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockSummarySlotService.getSlot).toHaveBeenCalledWith({
        companyId,
        scopeKind: "project",
        slotKey: "header",
        scopeId: projectId,
      });
    });

    it("lists revisions for actors with company access", async () => {
      const app = await createApp(boardActor);
      const res = await request(app).get(
        `/api/companies/${companyId}/summary-slots/project/header/revisions?scopeId=${projectId}`,
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockSummarySlotService.listRevisions).toHaveBeenCalledOnce();
    });

    it("returns 404 and does not load state when the summaries flag is disabled", async () => {
      mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableSummaries: false });
      const app = await createApp(boardActor);
      const res = await request(app).get(slotPath);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(mockSummarySlotService.getSlot).not.toHaveBeenCalled();
    });

    it("denies reads outside the actor company boundary", async () => {
      const app = await createApp({ ...boardActor, companyIds: [otherCompanyId] });
      const res = await request(app).get(slotPath);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockSummarySlotService.getSlot).not.toHaveBeenCalled();
    });
  });

  describe("generate route", () => {
    it("creates a generation task and logs activity for board operators", async () => {
      const app = await createApp(boardActor);
      const res = await request(app).post(
        `/api/companies/${companyId}/summary-slots/project/header/generate`,
      ).send({ scopeId: projectId });
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(res.body.alreadyGenerating).toBe(false);
      expect(mockSummarySlotService.generate).toHaveBeenCalledWith(
        { companyId, scopeKind: "project", slotKey: "header", scopeId: projectId },
        expect.objectContaining({ userId: "board-user", agentId: null }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "summary_slot.generate_requested",
          entityType: "summary_slot",
          entityId: slotId,
        }),
      );
      expect(mockHeartbeatWakeup).toHaveBeenCalledWith(
        agentId,
        expect.objectContaining({
          reason: "summary_slot_generation_requested",
          payload: expect.objectContaining({
            issueId: generatingIssueId,
            taskKey: `summary-slot:${companyId}:project:${projectId}:header`,
          }),
          contextSnapshot: expect.objectContaining({
            issueId: generatingIssueId,
            taskKey: `summary-slot:${companyId}:project:${projectId}:header`,
          }),
        }),
      );
    });

    it("returns 200 without re-creating a task when a generation is already active", async () => {
      mockSummarySlotService.generate.mockResolvedValue({
        slot: slot({ status: "generating", generatingIssueId }),
        generatingIssue: generatingIssue(),
        alreadyGenerating: true,
      });
      const app = await createApp(boardActor);
      const res = await request(app).post(
        `/api/companies/${companyId}/summary-slots/project/header/generate`,
      ).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.alreadyGenerating).toBe(true);
      expect(mockHeartbeatWakeup).not.toHaveBeenCalled();
    });

    it("denies generate when the operator lacks tasks:assign", async () => {
      mockAccessService.canUser.mockResolvedValue(false);
      const app = await createApp(boardActor);
      const res = await request(app).post(
        `/api/companies/${companyId}/summary-slots/project/header/generate`,
      ).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockSummarySlotService.generate).not.toHaveBeenCalled();
    });

    it("denies generate for agent actors", async () => {
      const app = await createApp(agentActor);
      const res = await request(app).post(
        `/api/companies/${companyId}/summary-slots/project/header/generate`,
      ).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockSummarySlotService.generate).not.toHaveBeenCalled();
    });

    it("returns 404 when the summaries flag is disabled", async () => {
      mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableSummaries: false });
      const app = await createApp(boardActor);
      const res = await request(app).post(
        `/api/companies/${companyId}/summary-slots/project/header/generate`,
      ).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(mockSummarySlotService.generate).not.toHaveBeenCalled();
    });
  });

  describe("write route", () => {
    it("accepts Summarizer agent writes and logs activity", async () => {
      const app = await createApp(agentActor);
      const res = await request(app).put(slotPath).send({
        markdown: "# Summary\n\nNeeds you: nothing.",
        generationIssueId: generatingIssueId,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockSummarySlotService.write).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId,
          scopeKind: "project",
          slotKey: "header",
          scopeId: projectId,
          markdown: "# Summary\n\nNeeds you: nothing.",
          generationIssueId: generatingIssueId,
        }),
        expect.objectContaining({ agentId, runId: "run-123" }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "summary_slot.write", entityType: "summary_slot" }),
      );
    });

    it("rejects writes from board actors", async () => {
      const app = await createApp(boardActor);
      const res = await request(app).put(slotPath).send({ markdown: "# Summary" });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockSummarySlotService.write).not.toHaveBeenCalled();
    });

    it("returns 404 when the summaries flag is disabled", async () => {
      mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableSummaries: false });
      const app = await createApp(agentActor);
      const res = await request(app).put(slotPath).send({ markdown: "# Summary" });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(mockSummarySlotService.write).not.toHaveBeenCalled();
    });

    it("rejects writes with an empty markdown body", async () => {
      const app = await createApp(agentActor);
      const res = await request(app).put(slotPath).send({ markdown: "" });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(mockSummarySlotService.write).not.toHaveBeenCalled();
    });
  });
});
