/**
 * Regression guard: POST /plans must NOT wake the assignee while the plan is in
 * DRAFT state. The premature wake (bug: "draft-plan-wake") caused the CTO agent
 * to burn tokens on every plan creation, before the operator activated the plan.
 *
 * Wake legitimately fires at POST /plans/:id/activate (existing path, unchanged).
 *
 * SCOPE: this is a route-body unit guard. The service layer (planService) and
 * authz are mocked, so it proves the POST /plans handler enqueues no wake — not
 * that the service layer is wake-free. The mock of issue-assignment-wakeup.js
 * rewrites the live ESM binding the route imports, so re-adding the wake call to
 * the handler WOULD fail these assertions (verified non-tautological).
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { planRoutes } from "../routes/plans.js";

// ---------------------------------------------------------------------------
// Module-level mocks — hoisted so they resolve before any import executes.
// ---------------------------------------------------------------------------

const mockCreatePlan = vi.hoisted(() => vi.fn());
const mockActivatePlan = vi.hoisted(() => vi.fn());
const mockIssueGetById = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockQueueWakeup = vi.hoisted(() => vi.fn());
const mockHeartbeatWakeup = vi.hoisted(() => vi.fn());
const mockAgentList = vi.hoisted(() => vi.fn());

vi.mock("../services/plans.js", () => ({
  planService: () => ({
    createPlan: mockCreatePlan,
    activate: mockActivatePlan,
    stop: vi.fn(),
    getPlan: vi.fn(),
    updateTiers: vi.fn(),
    setBudgetCaps: vi.fn(),
    deletePlanSubtree: vi.fn(),
  }),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => ({ getById: mockIssueGetById }),
  agentService: () => ({ list: mockAgentList }),
  heartbeatService: () => ({ wakeup: mockHeartbeatWakeup, addWakeup: vi.fn() }),
  logActivity: mockLogActivity,
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockQueueWakeup,
}));

vi.mock("../services/issue-subtree-cancel.js", () => ({
  cancelIssueSubtree: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

vi.mock("./authz.js", () => ({
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn(() => ({
    actorType: "user",
    actorId: "user-1",
    agentId: null,
    runId: null,
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function buildApp() {
  const app = express();
  app.use(express.json());
  // Inject a board-level actor (no auth needed for this unit test).
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyId: COMPANY_ID,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", planRoutes({} as any));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/plans — draft-plan-wake guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: createPlan returns a minimal plan object.
    mockCreatePlan.mockResolvedValue({
      issue: {
        id: "33333333-3333-4333-8333-333333333333",
        companyId: COMPANY_ID,
        title: "Test plan",
        status: "todo",
        assigneeAgentId: AGENT_ID,
      },
      planDetails: {
        gateProfile: "none",
        state: "draft",
      },
    });

    mockLogActivity.mockResolvedValue(undefined);
  });

  it("does not call queueIssueAssignmentWakeup when plan created with assigneeAgentId", async () => {
    const app = buildApp();

    const res = await request(app)
      .post("/api/plans")
      .send({
        companyId: COMPANY_ID,
        title: "Pilot: rate-limit upload route",
        assigneeAgentId: AGENT_ID,
        gateProfile: "dev_team",
      });

    expect(res.status).toBe(201);
    expect(mockQueueWakeup).not.toHaveBeenCalled();
  });

  it("does not call queueIssueAssignmentWakeup when plan created without assigneeAgentId", async () => {
    mockCreatePlan.mockResolvedValue({
      issue: {
        id: "44444444-4444-4444-8444-444444444444",
        companyId: COMPANY_ID,
        title: "Unassigned plan",
        status: "todo",
        assigneeAgentId: null,
      },
      planDetails: { gateProfile: "none", state: "draft" },
    });

    const app = buildApp();

    const res = await request(app)
      .post("/api/plans")
      .send({
        companyId: COMPANY_ID,
        title: "Unassigned plan",
        gateProfile: "none",
      });

    expect(res.status).toBe(201);
    expect(mockQueueWakeup).not.toHaveBeenCalled();
  });

  it("returns 201 with issue + planDetails shape unchanged", async () => {
    const app = buildApp();

    const res = await request(app)
      .post("/api/plans")
      .send({
        companyId: COMPANY_ID,
        title: "Shape check plan",
        assigneeAgentId: AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      issue: expect.objectContaining({ id: expect.any(String) }),
      planDetails: expect.objectContaining({ state: "draft" }),
    });
  });
});

// ---------------------------------------------------------------------------
// B3: activate with unassigned children → CTO gets a wake with unassignedChildIds
// ---------------------------------------------------------------------------

const PLAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD_ID_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHILD_ID_2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const IMPL_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("POST /api/plans/:id/activate — B3 CTO assignment wake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);

    // Plan issue with CTO as assignee
    mockIssueGetById.mockResolvedValue({
      id: PLAN_ID,
      companyId: COMPANY_ID,
      title: "Pilot plan",
      status: "todo",
      assigneeAgentId: AGENT_ID,
    });

    // activate() returns children — both unassigned
    mockActivatePlan.mockResolvedValue({
      planDetails: { state: "active", gateProfile: "dev_team" },
      createdChildren: [
        { id: CHILD_ID_1, assigneeAgentId: null, status: "todo" },
        { id: CHILD_ID_2, assigneeAgentId: null, status: "todo" },
      ],
      gateApprovalIds: [],
      planApprovalWakeAgentIds: [],
    });

    // Agents: one implementor reports to CTO, one other does not
    mockAgentList.mockResolvedValue([
      { id: IMPL_ID, name: "Implementor 1", role: "engineer", status: "idle", reportsTo: AGENT_ID },
      { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", name: "Other", role: "engineer", status: "idle", reportsTo: "other" },
    ]);

    mockHeartbeatWakeup.mockResolvedValue(undefined);
  });

  it("wakes the CTO with unassignedChildIds when activation produces unassigned tier-1 children", async () => {
    const app = buildApp();

    const res = await request(app)
      .post(`/api/plans/${PLAN_ID}/activate`)
      .send({});

    expect(res.status).toBe(200);

    // Allow the async void block to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(mockHeartbeatWakeup).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({
        reason: "plan_needs_assignment",
        payload: expect.objectContaining({
          unassignedChildIds: expect.arrayContaining([CHILD_ID_1, CHILD_ID_2]),
          assignableAgents: [expect.objectContaining({ id: IMPL_ID })],
        }),
      }),
    );
  });

  it("does NOT wake CTO when all children are already assigned", async () => {
    mockActivatePlan.mockResolvedValue({
      planDetails: { state: "active", gateProfile: "dev_team" },
      createdChildren: [
        { id: CHILD_ID_1, assigneeAgentId: IMPL_ID, status: "todo" },
      ],
      gateApprovalIds: [],
      planApprovalWakeAgentIds: [],
    });

    const app = buildApp();
    const res = await request(app)
      .post(`/api/plans/${PLAN_ID}/activate`)
      .send({});

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));

    const assignmentWakes = (mockHeartbeatWakeup.mock.calls as any[]).filter(
      ([, opts]: [string, { reason?: string }]) => opts?.reason === "plan_needs_assignment",
    );
    expect(assignmentWakes).toHaveLength(0);
  });

  it("does NOT wake CTO when plan has no CTO assignee", async () => {
    mockIssueGetById.mockResolvedValue({
      id: PLAN_ID,
      companyId: COMPANY_ID,
      title: "Unassigned plan",
      status: "todo",
      assigneeAgentId: null,
    });

    const app = buildApp();
    const res = await request(app)
      .post(`/api/plans/${PLAN_ID}/activate`)
      .send({});

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));

    const assignmentWakes = (mockHeartbeatWakeup.mock.calls as any[]).filter(
      ([, opts]: [string, { reason?: string }]) => opts?.reason === "plan_needs_assignment",
    );
    expect(assignmentWakes).toHaveLength(0);
  });
});
