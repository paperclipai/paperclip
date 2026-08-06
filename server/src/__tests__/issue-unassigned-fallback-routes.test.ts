import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level proof for RBR-767: `POST /api/companies/:companyId/issues` and
 * `POST /api/issues/:id/children` must never mint an issue that no heartbeat will pick up.
 *
 * An issue with `assigneeAgentId: null` and `assigneeUserId: null` is in nobody's queue.
 * These tests drive the real Express handlers over HTTP via supertest.
 */

const CEO = "11111111-1111-4111-8111-111111111111";
const CTO = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const CISO = "44444444-4444-4444-8444-444444444444";

type Row = { id: string; companyId: string; name: string; reportsTo: string | null; status: string };

const roster = vi.hoisted(() => ({
  rows: [] as Row[],
}));

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  createChild: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
      ambiguous: false,
      agent: {
        id: reference,
        companyId: "company-1",
        status: "active",
        orgChainHealth: { status: "healthy" },
      },
    })),
  }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
    markTestRunRunning: vi.fn(async () => undefined),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({ getIssueDocumentPayload: vi.fn(async () => ({})) }),
  executionWorkspaceService: () => ({ getById: vi.fn(async () => null) }),
  feedbackService: () => ({ listIssueVotesForUser: vi.fn(async () => []) }),
  forceReassignService: () => ({
    forceReassign: vi.fn(async () => ({ ok: true })),
    listActiveOverridesForAgent: vi.fn(async () => []),
    hasActiveOverride: vi.fn(async () => false),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
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
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
}));

/** Minimal drizzle-shaped stub: `db.select({...}).from(x).where(y)` resolves to the roster. */
function makeDb() {
  return {
    select: () => ({
      from: () => ({
        where: async () => roster.rows,
      }),
    }),
  } as any;
}

function agent(id: string, reportsTo: string | null, status = "idle"): Row {
  return { id, companyId: "company-1", name: id, reportsTo, status };
}

function makeIssue(input: {
  id: string;
  title: string;
  status?: string;
  parentId?: string | null;
  assigneeAgentId?: string | null;
}) {
  return {
    id: input.id,
    companyId: "company-1",
    identifier: input.id === "child-1" ? "PAP-3701" : "PAP-3700",
    title: input.title,
    description: null,
    status: input.status ?? "todo",
    priority: "medium",
    parentId: input.parentId ?? null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
  };
}

async function createApp(actorAgentId: string | null = null) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actorAgentId
      ? {
        type: "agent",
        agentId: actorAgentId,
        companyId: "company-1",
        companyIds: ["company-1"],
        source: "agent_key",
        isInstanceAdmin: false,
      }
      : {
        type: "board",
        userId: "local-board",
        companyIds: ["company-1"],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
    next();
  });
  app.use("/api", issueRoutes(makeDb(), {} as any));
  app.use(errorHandler);
  return app;
}

// The issue-routes test harness is heavy to construct on this branch (~20s per app build),
// so allow generous per-test time. Without this, a timeout mid-request lets an in-flight
// create() land in the next test's mock and cascades unrelated failures.
describe("RBR-767: unassigned issues cannot be created invisible", { timeout: 120_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roster.rows = [agent(CEO, null), agent(CTO, CEO), agent(STAFF, CTO), agent(CISO, CEO)];
    mockIssueService.create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) =>
      makeIssue({
        id: "issue-1",
        title: String(data.title),
        status: String(data.status),
        assigneeAgentId: data.assigneeAgentId as string | null | undefined,
      }));
    mockIssueService.createChild.mockImplementation(async (_parentId: string, data: Record<string, unknown>) => ({
      issue: makeIssue({
        id: "child-1",
        title: String(data.title),
        status: String(data.status),
        parentId: "parent-1",
        assigneeAgentId: data.assigneeAgentId as string | null | undefined,
      }),
      parentBlockerAdded: false,
    }));
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getById.mockResolvedValue(null);
  });

  it("THE REGRESSION: a null/null create no longer yields an unowned issue", async () => {
    const res = await request(await createApp(STAFF))
      .post("/api/companies/company-1/issues")
      .send({
        title: "Filed with no owner",
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: null,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // The whole point: the created issue has a real owner.
    expect(res.body.assigneeAgentId).not.toBeNull();
    // Creator is Staff -> nearest invokable manager is the CTO.
    expect(res.body.assigneeAgentId).toBe(CTO);
  });

  it("omitting the assignee field entirely behaves the same as explicit null", async () => {
    const res = await request(await createApp(STAFF))
      .post("/api/companies/company-1/issues")
      .send({ title: "No assignee key at all", status: "todo" });

    expect(res.status).toBe(201);
    expect(res.body.assigneeAgentId).toBe(CTO);
  });

  it("an explicit assignee is never overridden by the fallback", async () => {
    const res = await request(await createApp(STAFF))
      .post("/api/companies/company-1/issues")
      .send({ title: "Explicitly owned", status: "todo", assigneeAgentId: CISO });

    expect(res.status).toBe(201);
    expect(res.body.assigneeAgentId).toBe(CISO);
  });

  it("a user-assigned issue is left alone (a user is a real owner)", async () => {
    const res = await request(await createApp(STAFF))
      .post("/api/companies/company-1/issues")
      .send({ title: "Owned by a human", status: "todo", assigneeUserId: "local-board" });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ assigneeUserId: "local-board" }),
    );
    expect(mockIssueService.create.mock.calls[0][1].assigneeAgentId ?? null).toBeNull();
  });

  it("backlog is not excluded: a backlog issue still gets a deterministic owner", async () => {
    const res = await request(await createApp(STAFF))
      .post("/api/companies/company-1/issues")
      .send({ title: "Backlog item", status: "backlog", assigneeAgentId: null });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("backlog");
    expect(res.body.assigneeAgentId).toBe(CTO);
  });

  it("the applied fallback is auditable in the issue.created activity details", async () => {
    await request(await createApp(STAFF))
      .post("/api/companies/company-1/issues")
      .send({ title: "Audited fallback", status: "todo", assigneeAgentId: null });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.created",
        details: expect.objectContaining({
          assigneeFallbackApplied: true,
          assigneeFallbackReason: "creator_manager",
          assigneeFallbackAgentId: CTO,
        }),
      }),
    );
  });

  it("a board-created issue with no creating agent falls back to the company root", async () => {
    const res = await request(await createApp(null))
      .post("/api/companies/company-1/issues")
      .send({ title: "Board filed, no owner", status: "todo", assigneeAgentId: null });

    expect(res.status).toBe(201);
    expect(res.body.assigneeAgentId).toBe(CEO);
  });

  it("a child issue inherits the parent's assignee rather than being born invisible", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      id: "parent-1",
      title: "Parent issue",
      status: "in_progress",
      assigneeAgentId: CISO,
    }));

    const res = await request(await createApp(STAFF))
      .post("/api/issues/parent-1/children")
      .send({ title: "Child with no owner", status: "todo", assigneeAgentId: null });

    expect(res.status).toBe(201);
    expect(res.body.assigneeAgentId).toBe(CISO);
  });

  // RBR-796 §2: fail VISIBLE, never fail CLOSED.
  //
  // The first cut of this route rejected the create with 422 when no rung of the ladder was
  // invokable. Read that failure mode out loud: "the roster is degraded, therefore no new
  // issue may be filed." The moment every agent is paused or erroring is precisely the moment
  // someone needs to file an escalation or an incident -- so that behaviour converted a silent
  // failure into a total company-wide write outage and called it a safety improvement.
  //
  // An issue that exists with a warning flag beats an issue that was never created. Always.
  describe("degraded roster: fail visible, never fail closed", () => {
    beforeEach(() => {
      roster.rows = [
        agent(CEO, null, "terminated"),
        agent(CTO, CEO, "terminated"),
        agent(STAFF, CTO, "terminated"),
      ];
    });

    it("still creates the issue when no rung of the ladder is invokable", async () => {
      const res = await request(await createApp(STAFF))
        .post("/api/companies/company-1/issues")
        .send({ title: "Filed while the roster is down", status: "todo", assigneeAgentId: null });

      // The create SUCCEEDS. The work is written down.
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      // And it names an owner: the company root, even though it is not currently wakeable.
      // A paused owner is still an owner, and pausing is reversible.
      expect(res.body.assigneeAgentId).toBe(CEO);
      expect(mockIssueService.create).toHaveBeenCalled();
    });

    it("persists the first-class degraded flag so the sweep can find the row", async () => {
      await request(await createApp(STAFF))
        .post("/api/companies/company-1/issues")
        .send({ title: "Degraded and flagged", status: "todo", assigneeAgentId: null });

      // The flag is the sweep input. Without it the row has a non-null assignee and the
      // unassigned query would never see it -- the issue would be silently stranded on a
      // paused owner, which is the exact invisibility this work exists to kill.
      expect(mockIssueService.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          assigneeAgentId: CEO,
          assigneeFallbackReason: "no_invokable_owner",
        }),
      );
    });

    it("records the degraded fallback in the issue.created activity details", async () => {
      await request(await createApp(STAFF))
        .post("/api/companies/company-1/issues")
        .send({ title: "Degraded and audited", status: "todo", assigneeAgentId: null });

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.created",
          details: expect.objectContaining({
            assigneeFallbackApplied: true,
            assigneeFallbackDegraded: true,
            assigneeFallbackDegradedReason: "no_invokable_owner",
          }),
        }),
      );
    });

    it("a child issue is created degraded rather than refused", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue({
        id: "parent-1",
        title: "Parent issue",
        status: "in_progress",
        assigneeAgentId: null,
      }));

      const res = await request(await createApp(STAFF))
        .post("/api/issues/parent-1/children")
        .send({ title: "Child filed while the roster is down", status: "todo", assigneeAgentId: null });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.assigneeAgentId).toBe(CEO);
      expect(mockIssueService.createChild).toHaveBeenCalledWith(
        "parent-1",
        expect.objectContaining({
          assigneeAgentId: CEO,
          assigneeFallbackReason: "no_invokable_owner",
        }),
      );
    });

    it("no 422 body ever leaks the candidate roster", async () => {
      const res = await request(await createApp(STAFF))
        .post("/api/companies/company-1/issues")
        .send({ title: "No roster leak", status: "todo", assigneeAgentId: null });

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toMatch(/candidatesConsidered/);
      expect(serialized).not.toMatch(/creator:|creator_manager:|company_root:|parent:/);
    });
  });

  // RBR-804 §F2: zero agents is a BOOTSTRAP STATE, not an impossibility.
  //
  // The previous cut kept a 422 for one case -- "this company has no agents to own it" --
  // and called it a genuine impossibility. It is not. It is the state every company starts
  // in, and someone has to be able to file the first issue, including the issue that says
  // "hire the first agent." Six pre-existing guards in
  // `issue-create-deduplication-routes.test.ts` assert 201 on exactly this path and they
  // were telling the truth.
  //
  // Narrowing a fail-closed window is not closing it. There is now NO input on which this
  // route refuses to write for a roster reason.
  describe("zero agents: created unassigned and flagged, never refused", () => {
    beforeEach(() => {
      roster.rows = [];
    });

    it("creates the issue unassigned instead of returning 422", async () => {
      const res = await request(await createApp(null))
        .post("/api/companies/company-1/issues")
        .send({ title: "The first issue in an empty company", status: "todo", assigneeAgentId: null });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockIssueService.create).toHaveBeenCalled();
    });

    it("persists no_agents_in_company with a null assignee", async () => {
      await request(await createApp(null))
        .post("/api/companies/company-1/issues")
        .send({ title: "Hire the first agent", status: "todo", assigneeAgentId: null });

      // An unassigned issue in an empty company is the CORRECT record. The flag is what
      // makes it a worklist entry rather than invisible work: `rbr767-sweep.ts` already
      // queries `assignee_fallback_reason IS NOT NULL` and clears it on first hire.
      const [, createInput] = mockIssueService.create.mock.calls.at(-1)!;
      expect(createInput).toMatchObject({ assigneeFallbackReason: "no_agents_in_company" });
      expect(createInput.assigneeAgentId ?? null).toBeNull();
    });

    it("records the zero-agent flag in the issue.created activity details", async () => {
      await request(await createApp(null))
        .post("/api/companies/company-1/issues")
        .send({ title: "Audited bootstrap create", status: "todo", assigneeAgentId: null });

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.created",
          details: expect.objectContaining({
            assigneeFallbackApplied: false,
            assigneeFallbackDegraded: true,
            assigneeFallbackDegradedReason: "no_agents_in_company",
          }),
        }),
      );
    });

    it("a child issue in an empty company is created unassigned and flagged", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue({
        id: "parent-1",
        title: "Parent issue",
        status: "in_progress",
        assigneeAgentId: null,
      }));

      const res = await request(await createApp(null))
        .post("/api/issues/parent-1/children")
        .send({ title: "Child in an empty company", status: "todo", assigneeAgentId: null });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [, childInput] = mockIssueService.createChild.mock.calls.at(-1)!;
      expect(childInput).toMatchObject({ assigneeFallbackReason: "no_agents_in_company" });
      expect(childInput.assigneeAgentId ?? null).toBeNull();
    });

    it("no create path returns 422 for a roster reason", async () => {
      const create = await request(await createApp(null))
        .post("/api/companies/company-1/issues")
        .send({ title: "Never refused", status: "todo", assigneeAgentId: null });
      expect(create.status).not.toBe(422);

      mockIssueService.getById.mockResolvedValue(makeIssue({
        id: "parent-1",
        title: "Parent issue",
        status: "in_progress",
        assigneeAgentId: null,
      }));
      const child = await request(await createApp(null))
        .post("/api/issues/parent-1/children")
        .send({ title: "Never refused either", status: "todo", assigneeAgentId: null });
      expect(child.status).not.toBe(422);
    });
  });
});
