import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { recordRoutes } from "../routes/records.js";

const mockRecordService = vi.hoisted(() => ({
  listPlans: vi.fn(),
  createPlan: vi.fn(),
  listResults: vi.fn(),
  createResult: vi.fn(),
  promoteToResult: vi.fn(),
  listBriefings: vi.fn(),
  createBriefing: vi.fn(),
  boardSummary: vi.fn(),
  portfolioSummary: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  addLink: vi.fn(),
  addAttachment: vi.fn(),
  generate: vi.fn(),
  getSchedule: vi.fn(),
  upsertSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  runDueSchedules: vi.fn(),
  publish: vi.fn(),
  markViewed: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockKnowledgeService = vi.hoisted(() => ({
  autoPublishEligibleRecord: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  recordService: () => mockRecordService,
  knowledgeService: () => mockKnowledgeService,
  logActivity: mockLogActivity,
}));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const RECORD_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";

function createRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: RECORD_ID,
    companyId: COMPANY_ID,
    category: "result",
    kind: "status_report",
    scopeType: "company",
    scopeRefId: COMPANY_ID,
    title: "Executive update",
    summary: "Summary",
    bodyMd: "Body",
    status: "draft",
    ownerAgentId: null,
    decisionNeeded: false,
    decisionDueAt: null,
    healthStatus: null,
    healthDelta: null,
    confidence: null,
    publishedAt: null,
    generatedAt: null,
    metadata: null,
    createdByAgentId: null,
    createdByUserId: "board-user",
    updatedByAgentId: null,
    updatedByUserId: "board-user",
    createdAt: new Date("2026-03-08T10:00:00.000Z"),
    updatedAt: new Date("2026-03-08T10:00:00.000Z"),
    links: [],
    attachments: [],
    ...overrides,
  };
}

function createSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: "schedule-1",
    companyId: COMPANY_ID,
    recordId: RECORD_ID,
    enabled: true,
    cadence: "daily",
    timezone: "America/New_York",
    localHour: 9,
    localMinute: 0,
    dayOfWeek: null,
    windowPreset: "24h",
    autoPublish: true,
    lastRunAt: null,
    nextRunAt: new Date("2026-03-10T13:00:00.000Z"),
    lastRunStatus: "idle",
    lastError: null,
    createdAt: new Date("2026-03-08T10:00:00.000Z"),
    updatedAt: new Date("2026-03-08T10:00:00.000Z"),
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", recordRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("record routes", () => {
  beforeEach(() => {
    for (const fn of Object.values(mockRecordService)) {
      fn.mockReset();
    }
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
    mockKnowledgeService.autoPublishEligibleRecord.mockReset();
    mockKnowledgeService.autoPublishEligibleRecord.mockResolvedValue(null);
  });

  it("requires scopeId for project board views", async () => {
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/briefings/board`)
      .query({ scopeType: "project" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("scopeId is required");
    expect(mockRecordService.boardSummary).not.toHaveBeenCalled();
  });

  it("denies cross-company record reads for agents", async () => {
    mockRecordService.getById.mockResolvedValue(createRecord({ companyId: OTHER_COMPANY_ID }));
    const app = createApp({
      type: "agent",
      source: "agent_key",
      agentId: "agent-1",
      companyId: COMPANY_ID,
      runId: null,
    });

    const res = await request(app).get(`/api/records/${RECORD_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("another company");
  });

  it("promotes an issue into a result and logs activity", async () => {
    const created = createRecord({ status: "draft" });
    mockRecordService.promoteToResult.mockResolvedValue(created);

    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/results/promote`)
      .send({ sourceType: "issue", sourceId: ISSUE_ID, kind: "status_report" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(RECORD_ID);
    expect(mockRecordService.promoteToResult).toHaveBeenCalledWith(
      COMPANY_ID,
      { sourceType: "issue", sourceId: ISSUE_ID, kind: "status_report" },
      { agentId: null, userId: "board-user" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        action: "record.promoted_to_result",
        entityId: RECORD_ID,
      }),
    );
  });

  it("publishes a record and logs the publish event", async () => {
    const existing = createRecord();
    const published = createRecord({ status: "published", publishedAt: new Date("2026-03-08T12:00:00.000Z") });
    const knowledgeEntry = {
      id: "knowledge-1",
      companyId: COMPANY_ID,
      title: "Executive update",
      summary: "Summary",
      bodyMd: "Body",
      sourceRecordId: RECORD_ID,
      kind: "status_report",
      scopeType: "company",
      scopeRefId: COMPANY_ID,
      status: "published",
      publishedAt: new Date("2026-03-08T12:00:00.000Z"),
      metadata: null,
      attachments: [],
      links: [],
      createdAt: new Date("2026-03-08T12:00:00.000Z"),
      updatedAt: new Date("2026-03-08T12:00:00.000Z"),
    };
    mockRecordService.getById.mockResolvedValue(existing);
    mockRecordService.publish.mockResolvedValue(published);
    mockKnowledgeService.autoPublishEligibleRecord.mockResolvedValue(knowledgeEntry);

    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/records/${RECORD_ID}/publish`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("published");
    expect(mockRecordService.publish).toHaveBeenCalledWith(RECORD_ID, {
      agentId: null,
      userId: "board-user",
    });
    expect(mockKnowledgeService.autoPublishEligibleRecord).toHaveBeenCalledWith(RECORD_ID);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        action: "record.published",
        entityId: RECORD_ID,
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        action: "knowledge.published",
        entityId: "knowledge-1",
      }),
    );
  });

  it("upserts a briefing schedule and logs the mutation", async () => {
    const existing = createRecord({ category: "briefing", kind: "daily_briefing" });
    const schedule = createSchedule();
    mockRecordService.getById.mockResolvedValue(existing);
    mockRecordService.upsertSchedule.mockResolvedValue(schedule);

    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .put(`/api/records/${RECORD_ID}/schedule`)
      .send({
        enabled: true,
        cadence: "daily",
        timezone: "America/New_York",
        localHour: 9,
        localMinute: 0,
        windowPreset: "24h",
        autoPublish: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.recordId).toBe(RECORD_ID);
    expect(mockRecordService.upsertSchedule).toHaveBeenCalledWith(
      RECORD_ID,
      expect.objectContaining({
        cadence: "daily",
        timezone: "America/New_York",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        action: "record.schedule_upserted",
        entityId: RECORD_ID,
      }),
    );
  });
});
