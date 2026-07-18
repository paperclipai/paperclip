import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockFindExistingIssueBlockersResolvedWake = vi.hoisted(() => vi.fn(async () => null));
const mockFindExistingIssueBlockerStrandedWake = vi.hoisted(() => vi.fn(async () => null));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  listAssignedDependentsBlockedBy: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
    getRun: vi.fn(async () => null),
    getActiveRunForAgent: vi.fn(async () => null),
    cancelRun: vi.fn(async () => null),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/issue-dependency-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-dependency-wakeups.js")>(
    "../services/issue-dependency-wakeups.js",
  );
  return {
    ...actual,
    findExistingIssueBlockersResolvedWake: mockFindExistingIssueBlockersResolvedWake,
    findExistingIssueBlockerStrandedWake: mockFindExistingIssueBlockerStrandedWake,
  };
});
async function createApp(db: ReturnType<typeof createDb> | Record<string, never> = {}) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
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
  app.use("/api", issueRoutes(db as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue dependency wakeups in issue routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockFindExistingIssueBlockersResolvedWake.mockResolvedValue(null);
    mockFindExistingIssueBlockerStrandedWake.mockResolvedValue(null);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "issue-1",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.listAssignedDependentsBlockedBy.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("wakes dependents when the final blocker transitions to done", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "done",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1", "issue-3"],
      },
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: "issue-2",
            resolvedBlockerIssueId: "issue-1",
          }),
        }),
      );
    });
  });

  it("wakes dependents with issue_blocker_stranded when a blocker is cancelled", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Dead blocker",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Dead blocker",
      description: null,
      status: "cancelled",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.listAssignedDependentsBlockedBy.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1"],
      },
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "cancelled" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blocker_stranded",
          payload: expect.objectContaining({
            dependentIssueId: "issue-2",
            deadBlockerIssueId: "issue-1",
            blockerFate: "cancelled",
            message: expect.stringContaining("will not reach done"),
          }),
          contextSnapshot: expect.objectContaining({
            wakeReason: "issue_blocker_stranded",
            source: "issue.blocker_stranded",
            deadBlockerIssueId: "issue-1",
            blockerFate: "cancelled",
          }),
        }),
      );
    });
    expect(mockIssueService.listAssignedDependentsBlockedBy).toHaveBeenCalledWith("issue-1");
    expect(mockIssueService.listWakeableBlockedDependents).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({ reason: "issue_blockers_resolved" }),
    );
  });

  it("does not wake dependents when a blocker becomes transitively blocked", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Transitively blocked blocker",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Transitively blocked blocker",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1"],
      },
    ]);

    const res = await request(await createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "blocked" });
    expect(res.status).toBe(200);
    // Allow async wake side-effects (parent/sandbox) to settle without stranded wake.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockIssueService.listWakeableBlockedDependents).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({ reason: "issue_blocker_stranded" }),
    );
    expect(mockWakeup).not.toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({ reason: "issue_blockers_resolved" }),
    );
  });

  it("wakes an assigned blocked issue when blockers are applied after the blocker is already done", async () => {
    const parentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "todo",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: parentIssueId,
      blockerIssueIds: [childIssueId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${parentIssueId}`)
      .send({ status: "blocked", blockedByIssueIds: [childIssueId] });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: parentIssueId,
            resolvedBlockerIssueId: childIssueId,
            mutation: "blocked_dependency_restored",
          }),
          contextSnapshot: expect.objectContaining({
            source: "issue.blockers_restored",
          }),
        }),
      );
    });
  });

  it("wakes the parent when all direct children become terminal", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "done",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-9",
      childIssueIds: ["child-0", "child-1"],
      childIssueSummaries: [
        {
          id: "child-0",
          identifier: "PAP-100",
          title: "First child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:00:00.000Z"),
          summary: "First child finished.",
        },
        {
          id: "child-1",
          identifier: "PAP-101",
          title: "Last child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:05:00.000Z"),
          summary: "Last child finished.",
        },
      ],
      childIssueSummaryTruncated: false,
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-9",
        expect.objectContaining({
          reason: "issue_children_completed",
          payload: expect.objectContaining({
            issueId: "parent-1",
            completedChildIssueId: "child-1",
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-101", summary: "Last child finished." }),
            ]),
          }),
          contextSnapshot: expect.objectContaining({
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-100", summary: "First child finished." }),
            ]),
          }),
        }),
      );
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cancelled-blocker wakeup tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue cancelled-blocker dependency wakeups (integration)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cancelled-blocker-wakeups-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockerIssueId = randomUUID();
    const prefix = `CW${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Cancelled Wake Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Dead blocker",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    return { companyId, managerId, coderId, blockerIssueId, prefix };
  }

  function wireRealIssueService() {
    // Bypass the services/index mock: import the real factory and bind route
    // mocks to it so PATCH exercises real isDependencyReady filtering.
    return vi.importActual<typeof import("../services/issues.js")>("../services/issues.js").then(({ issueService }) => {
      const realSvc = issueService(db);
      mockIssueService.getById.mockImplementation((id: string) => realSvc.getById(id));
      mockIssueService.update.mockImplementation(
        (id: string, data: unknown, tx?: unknown) => realSvc.update(id, data as never, tx as never),
      );
      mockIssueService.getRelationSummaries.mockImplementation((id: string) => realSvc.getRelationSummaries(id));
      mockIssueService.getDependencyReadiness.mockImplementation((id: string) => realSvc.getDependencyReadiness(id));
      mockIssueService.getAncestors.mockImplementation((id: string) => realSvc.getAncestors(id));
      mockIssueService.getCommentCursor.mockImplementation((id: string) => realSvc.getCommentCursor(id));
      mockIssueService.getComment.mockImplementation((id: string) => realSvc.getComment(id));
      mockIssueService.getWakeableParentAfterChildCompletion.mockImplementation((id: string) =>
        realSvc.getWakeableParentAfterChildCompletion(id),
      );
      mockIssueService.findMentionedAgents.mockImplementation(
        (companyId: string, body: string) => realSvc.findMentionedAgents(companyId, body),
      );
      mockIssueService.listWakeableBlockedDependents.mockImplementation((id: string) =>
        realSvc.listWakeableBlockedDependents(id),
      );
      mockIssueService.listAssignedDependentsBlockedBy.mockImplementation((id: string) =>
        realSvc.listAssignedDependentsBlockedBy(id),
      );
      return realSvc;
    });
  }

  it("unblocks dependents to todo and wakes assignee when blocker is cancelled via PATCH", async () => {
    const { companyId, managerId, blockerIssueId, prefix } = await seedCompany();
    const dependentIssueId = randomUUID();
    await db.insert(issues).values({
      id: dependentIssueId,
      companyId,
      title: "Waiting on cancelled blocker",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
    });

    vi.clearAllMocks();
    mockFindExistingIssueBlockersResolvedWake.mockResolvedValue(null);
    mockFindExistingIssueBlockerStrandedWake.mockResolvedValue(null);
    await wireRealIssueService();

    const res = await request(await createApp(db))
      .patch(`/api/issues/${blockerIssueId}`)
      .send({ status: "cancelled" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    // Side-effects run in a void async IIFE after the HTTP response — wait for outcome.
    await vi.waitFor(async () => {
      const [dependent] = await db.select().from(issues).where(eq(issues.id, dependentIssueId));
      expect(dependent.status).toBe("todo");
    });
    const remainingBlockers = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.relatedIssueId, dependentIssueId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(remainingBlockers.map((row) => row.issueId)).not.toContain(blockerIssueId);
    expect(remainingBlockers).toHaveLength(0);

    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        managerId,
        expect.objectContaining({
          reason: "issue_blocker_stranded",
          payload: expect.objectContaining({
            dependentIssueId,
            deadBlockerIssueId: blockerIssueId,
            blockerFate: "cancelled",
            mutation: "blocker_cancelled",
            message: expect.stringContaining("will not reach done"),
          }),
          contextSnapshot: expect.objectContaining({
            wakeReason: "issue_blocker_stranded",
            blockerFate: "cancelled",
            deadBlockerIssueId: blockerIssueId,
          }),
        }),
      );
    });
  });

  it("keeps dependent blocked when another live blocker remains after cancel", async () => {
    const { companyId, managerId, coderId, blockerIssueId, prefix } = await seedCompany();
    const liveBlockerId = randomUUID();
    const dependentIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: liveBlockerId,
        companyId,
        title: "Still-live blocker",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 2,
        identifier: `${prefix}-2`,
      },
      {
        id: dependentIssueId,
        companyId,
        title: "Waiting on two blockers",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: managerId,
        issueNumber: 3,
        identifier: `${prefix}-3`,
      },
    ]);
    await db.insert(issueRelations).values([
      {
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: dependentIssueId,
        type: "blocks",
      },
      {
        companyId,
        issueId: liveBlockerId,
        relatedIssueId: dependentIssueId,
        type: "blocks",
      },
    ]);

    vi.clearAllMocks();
    mockFindExistingIssueBlockersResolvedWake.mockResolvedValue(null);
    mockFindExistingIssueBlockerStrandedWake.mockResolvedValue(null);
    await wireRealIssueService();

    const res = await request(await createApp(db))
      .patch(`/api/issues/${blockerIssueId}`)
      .send({ status: "cancelled" });
    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      const remainingBlockers = await db
        .select()
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.relatedIssueId, dependentIssueId),
            eq(issueRelations.type, "blocks"),
          ),
        );
      expect(remainingBlockers.map((row) => row.issueId)).toEqual([liveBlockerId]);
    });
    const [dependent] = await db.select().from(issues).where(eq(issues.id, dependentIssueId));
    expect(dependent.status).toBe("blocked");

    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        managerId,
        expect.objectContaining({
          reason: "issue_blocker_stranded",
          payload: expect.objectContaining({
            dependentIssueId,
            deadBlockerIssueId: blockerIssueId,
            blockerIssueIds: [liveBlockerId],
          }),
        }),
      );
    });
  });
});
