/**
 * Tests for SAG-2189: heartbeat-context priorRunKnowledge block.
 *
 * Three suites:
 *   1. Contract — SSI Director assignee returns priorRunKnowledge in decided_at DESC order.
 *   2. Negative  — non-SSI Director assignee omits the field entirely.
 *   3. Performance — 100-entry seed: response-time delta < 100ms.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { readPriorRunKnowledge } from "../services/knowledge-reader.js";

// ─────────────────────────────────────────────────────────────────────────────
// Service mocks (mirrors the pattern in issues-goal-context-routes.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getAncestors: vi.fn(),
  getRelationSummaries: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
  listBlockerAttention: vi.fn(),
  listProductivityReviews: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  listAttachments: vi.fn(),
  findMentionedProjectIds: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(),
  getIssueDocumentByKey: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
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
  listCompanyIds: vi.fn(async () => ["company-1"]),
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

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
}));
const mockEnvironmentService = vi.hoisted(() => ({}));
const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => mockDocumentsService,
  environmentService: () => mockEnvironmentService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  feedbackService: () => mockFeedbackService,
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueReferenceService: () => mockIssueReferenceService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

// ─────────────────────────────────────────────────────────────────────────────
// Test data helpers
// ─────────────────────────────────────────────────────────────────────────────

const SSI_DIRECTOR_AGENT_ID = "7cc4dafd-b41f-469c-b8ea-7b4110a11fe8";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000000001";

function ssiDirectorIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    identifier: "SAG-9999",
    title: "SSI Director task",
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    goalId: null,
    parentId: null,
    assigneeAgentId: SSI_DIRECTOR_AGENT_ID,
    assigneeUserId: null,
    executionWorkspaceId: null,
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

function ssiProject() {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    companyId: "company-1",
    urlKey: "ssi",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "SSI",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: null,
      effectiveLocalFolder: null,
      origin: "none",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/**
 * Write a minimal JSONL pointer row + YAML task file for one knowledge entry.
 * Intentionally mirrors the format produced by SAG-2187's writeEntry().
 */
function seedKnowledgeEntry(
  knowledgeDir: string,
  entry: {
    taskId: string;
    identifier: string;
    domain: string;
    summary: string;
    antiPatterns?: string[];
    decisions?: string[];
    decidedAt: string;
  },
) {
  const specialty = "ssi_director";

  // Write JSONL pointer row
  const indexDir = path.join(knowledgeDir, "index", "by_specialty");
  fs.mkdirSync(indexDir, { recursive: true });
  const pointerRow = {
    task_id: entry.taskId,
    identifier: entry.identifier,
    specialty,
    domain: entry.domain,
    summary: entry.summary,
    ...(entry.antiPatterns ? { anti_patterns: entry.antiPatterns } : {}),
    decided_at: entry.decidedAt,
  };
  fs.appendFileSync(path.join(indexDir, `${specialty}.jsonl`), JSON.stringify(pointerRow) + "\n");

  // Write YAML task file
  const dt = new Date(entry.decidedAt);
  const yyyy = dt.getUTCFullYear().toString();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const taskDir = path.join(knowledgeDir, "tasks", yyyy, mm);
  fs.mkdirSync(taskDir, { recursive: true });

  const lines = [
    `task_id: ${entry.taskId}`,
    `identifier: ${entry.identifier}`,
    `title: Test entry ${entry.identifier}`,
    `specialty: ${specialty}`,
    `domain: ${entry.domain}`,
    `outcome: done`,
    `summary: "${entry.summary}"`,
    `decided_at: ${entry.decidedAt}`,
    `digest_model: test-model`,
    `digest_version: 1`,
    `source: manual`,
  ];
  if (entry.antiPatterns && entry.antiPatterns.length > 0) {
    lines.push("anti_patterns:");
    for (const ap of entry.antiPatterns) lines.push(`  - "${ap}"`);
  }
  if (entry.decisions && entry.decisions.length > 0) {
    lines.push("decisions:");
    for (const d of entry.decisions) lines.push(`  - "${d}"`);
  }
  fs.writeFileSync(path.join(taskDir, `${entry.identifier}.yaml`), lines.join("\n") + "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared beforeEach defaults
// ─────────────────────────────────────────────────────────────────────────────

function setupDefaultMocks() {
  vi.clearAllMocks();
  mockAccessService.decide.mockResolvedValue({
    allowed: true,
    action: "issue:read",
    reason: "allow_test",
    explanation: "Allowed by test mock.",
  });
  mockIssueService.getAncestors.mockResolvedValue([]);
  mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
  mockIssueService.getCommentCursor.mockResolvedValue({
    totalComments: 0,
    latestCommentId: null,
    latestCommentAt: null,
  });
  mockIssueService.getComment.mockResolvedValue(null);
  mockIssueService.listBlockerAttention.mockResolvedValue(new Map());
  mockIssueService.listProductivityReviews.mockResolvedValue(new Map());
  mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
  mockIssueService.listAttachments.mockResolvedValue([]);
  mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
  mockDocumentsService.getIssueDocumentPayload.mockResolvedValue({});
  mockDocumentsService.getIssueDocumentByKey.mockResolvedValue(null);
  mockExecutionWorkspaceService.getById.mockResolvedValue(null);
  mockDb.select.mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(async () => []),
      })),
    })),
  });
  mockDb.execute.mockResolvedValue([]);
  mockProjectService.listByIds.mockResolvedValue([]);
  mockGoalService.getById.mockResolvedValue(null);
  mockGoalService.getDefaultCompanyGoal.mockResolvedValue(null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: Contract — SSI Director gets priorRunKnowledge in DESC order
// ─────────────────────────────────────────────────────────────────────────────

describe.sequential("heartbeat-context priorRunKnowledge — contract", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sag-2189-contract-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(setupDefaultMocks);

  it("returns 5 priorRunKnowledge entries for SSI Director, newest-first", async () => {
    // Seed 5 entries with distinct decided_at times (out-of-order intentionally)
    // task_id uses UUID format (matches real digester output); identifier is the SAG ticket.
    // These must be distinct so the test catches the taskId←identifier mapping.
    const entries = [
      { taskId: "11111111-0000-4000-8000-000000000001", identifier: "SAG-1001", domain: "ssi-hp", summary: "Entry 1 — oldest", decidedAt: "2026-03-01T00:00:00.000Z", decisions: ["Decision A"] },
      { taskId: "22222222-0000-4000-8000-000000000002", identifier: "SAG-1002", domain: "ssi-hp", summary: "Entry 2", decidedAt: "2026-04-01T00:00:00.000Z", decisions: ["Decision B"] },
      { taskId: "33333333-0000-4000-8000-000000000003", identifier: "SAG-1003", domain: "ssi-hp", summary: "Entry 3", decidedAt: "2026-05-01T00:00:00.000Z", antiPatterns: ["AP 3"] },
      { taskId: "44444444-0000-4000-8000-000000000004", identifier: "SAG-1004", domain: "ssi-hp", summary: "Entry 4", decidedAt: "2026-06-01T00:00:00.000Z" },
      { taskId: "55555555-0000-4000-8000-000000000005", identifier: "SAG-1005", domain: "ssi-hp", summary: "Entry 5 — newest", decidedAt: "2026-07-01T00:00:00.000Z", decisions: ["Decision E"] },
    ];
    for (const e of entries) seedKnowledgeEntry(tmpDir, e);

    mockIssueService.getById.mockResolvedValue(ssiDirectorIssue());
    mockProjectService.getById.mockResolvedValue(ssiProject());

    const reader = (companyId: string, specialty: string, domain: string, currentIdentifier: string) =>
      readPriorRunKnowledge(companyId, specialty, domain, currentIdentifier, { knowledgeDir: tmpDir });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueRoutes(mockDb as any, {} as any, { priorRunKnowledgeReader: reader }));
    app.use(errorHandler);

    const res = await request(app).get("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/heartbeat-context");

    expect(res.status).toBe(200);
    expect(res.body.priorRunKnowledge).toBeDefined();
    expect(res.body.priorRunKnowledge).toHaveLength(5);

    // taskId must be the human ticket identifier, NOT the UUID task_id stored in the JSONL
    const returnedTaskIds = res.body.priorRunKnowledge.map((e: { taskId: string }) => e.taskId);
    expect(returnedTaskIds).toEqual(["SAG-1005", "SAG-1004", "SAG-1003", "SAG-1002", "SAG-1001"]);

    // Spot-check fields on newest entry
    const newest = res.body.priorRunKnowledge[0];
    expect(newest.taskId).toBe("SAG-1005");  // identifier, not the UUID
    expect(newest.summary).toBe("Entry 5 — newest");
    expect(newest.decisions).toContain("Decision E");
    expect(newest.link).toBe("/SAG/issues/SAG-1005");

    // Verify antiPatterns from YAML
    const entry3 = res.body.priorRunKnowledge[2];
    expect(entry3.antiPatterns).toContain("AP 3");
  });

  it("skips the current issue's own entry if present in the index", async () => {
    // SAG-9999 is the current issue; add it to the index — it must be excluded
    seedKnowledgeEntry(tmpDir, {
      taskId: "ffffffff-0000-4000-8000-000000000099",  // UUID distinct from identifier
      identifier: "SAG-9999",
      domain: "ssi-hp",
      summary: "The current issue itself",
      decidedAt: "2026-08-01T00:00:00.000Z",
    });

    mockIssueService.getById.mockResolvedValue(ssiDirectorIssue());
    mockProjectService.getById.mockResolvedValue(ssiProject());

    const reader = (companyId: string, specialty: string, domain: string, currentIdentifier: string) =>
      readPriorRunKnowledge(companyId, specialty, domain, currentIdentifier, { knowledgeDir: tmpDir });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueRoutes(mockDb as any, {} as any, { priorRunKnowledgeReader: reader }));
    app.use(errorHandler);

    const res = await request(app).get("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/heartbeat-context");

    expect(res.status).toBe(200);
    const taskIds = res.body.priorRunKnowledge.map((e: { taskId: string }) => e.taskId);
    // taskId is the identifier, not the UUID — confirm "SAG-9999" (self) is excluded
    expect(taskIds).not.toContain("SAG-9999");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Negative — non-SSI Director does not receive the field
// ─────────────────────────────────────────────────────────────────────────────

describe.sequential("heartbeat-context priorRunKnowledge — negative", () => {
  beforeEach(setupDefaultMocks);

  it("omits priorRunKnowledge entirely for a non-SSI Director assignee", async () => {
    const readerCalled = vi.fn();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    app.use(
      "/api",
      issueRoutes(mockDb as any, {} as any, { priorRunKnowledgeReader: readerCalled }),
    );
    app.use(errorHandler);

    // Issue assigned to a different agent
    mockIssueService.getById.mockResolvedValue(ssiDirectorIssue({ assigneeAgentId: OTHER_AGENT_ID }));
    mockProjectService.getById.mockResolvedValue(ssiProject());

    const res = await request(app).get("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/heartbeat-context");

    expect(res.status).toBe(200);
    // The field must be absent, not an empty array
    expect(res.body).not.toHaveProperty("priorRunKnowledge");
    expect(readerCalled).not.toHaveBeenCalled();
  });

  it("omits priorRunKnowledge when issue has no assignee", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueRoutes(mockDb as any, {} as any));
    app.use(errorHandler);

    mockIssueService.getById.mockResolvedValue(ssiDirectorIssue({ assigneeAgentId: null }));
    mockProjectService.getById.mockResolvedValue(ssiProject());

    const res = await request(app).get("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/heartbeat-context");

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("priorRunKnowledge");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Performance — 100-entry seed, response delta < 100ms
// ─────────────────────────────────────────────────────────────────────────────

describe.sequential("heartbeat-context priorRunKnowledge — performance", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sag-2189-perf-"));

    // Baseline: get response time WITHOUT priorRunKnowledge
    for (let i = 0; i < 100; i++) {
      const n = String(i + 1).padStart(3, "0");
      seedKnowledgeEntry(tmpDir, {
        taskId: `perf-task-${n}`,
        identifier: `SAG-P${n}`,
        domain: "ssi-hp",
        summary: `Perf entry ${n}`,
        decidedAt: new Date(2026, 0, i + 1).toISOString(),
        decisions: [`Decision for entry ${n}`],
      });
    }
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(setupDefaultMocks);

  it("reads up to 5 entries from 100-entry seed in < 100ms delta", async () => {
    const reader = (companyId: string, specialty: string, domain: string, currentIdentifier: string) =>
      readPriorRunKnowledge(companyId, specialty, domain, currentIdentifier, { knowledgeDir: tmpDir });

    // App WITHOUT knowledge reader (baseline)
    const baselineApp = express();
    baselineApp.use(express.json());
    baselineApp.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    baselineApp.use("/api", issueRoutes(mockDb as any, {} as any));
    baselineApp.use(errorHandler);

    // App WITH knowledge reader
    const fullApp = express();
    fullApp.use(express.json());
    fullApp.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    fullApp.use("/api", issueRoutes(mockDb as any, {} as any, { priorRunKnowledgeReader: reader }));
    fullApp.use(errorHandler);

    mockIssueService.getById.mockResolvedValue(ssiDirectorIssue({ assigneeAgentId: OTHER_AGENT_ID }));
    mockProjectService.getById.mockResolvedValue(ssiProject());

    const t0 = performance.now();
    await request(baselineApp).get("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/heartbeat-context");
    const baselineMs = performance.now() - t0;

    // Now measure the full path with SSI Director + 100-entry index
    mockIssueService.getById.mockResolvedValue(ssiDirectorIssue());
    mockProjectService.getById.mockResolvedValue(ssiProject());

    const t1 = performance.now();
    const res = await request(fullApp).get("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/heartbeat-context");
    const fullMs = performance.now() - t1;

    expect(res.status).toBe(200);
    expect(res.body.priorRunKnowledge).toHaveLength(5); // top 5 only

    const delta = fullMs - baselineMs;
    // p50 budget is 100ms — we assert against 100ms here which is already generous
    // for a cold-start test; in production (warm FS cache) it will be much faster.
    expect(delta).toBeLessThan(100);
  });
});
