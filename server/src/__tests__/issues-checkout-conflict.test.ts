/**
 * Checkout conflict contract coverage -- paperclipai/paperclip#691
 *
 * Acceptance criteria verified here:
 *   1. Concurrent checkout conflict  -- API returns 409 with issueId, status,
 *      assigneeAgentId, checkoutRunId, executionRunId in the body.
 *   2. Same-owner idempotency        -- re-checkout by same agent+run returns 200.
 *   3. Stale-run adoption            -- same agent with a new run when prior run is
 *      terminal returns 200 (no 409).
 *   4. Cross-agent conflict          -- agent B checkout on agent-A-owned issue
 *      returns 409 with full details.
 *
 * Implementation note: the service-level logic (sameRunLock, adoptStaleCheckoutRun)
 * is exercised by the service; these tests verify the observable HTTP contract that
 * agents and boards rely on so any regression in that contract fails fast here.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { conflict } from "../errors.js";

// ---------------------------------------------------------------------------
// Service mocks
// ---------------------------------------------------------------------------

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  checkout: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getComments: vi.fn(),
  addComment: vi.fn(),
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  removeLabel: vi.fn(),
  addAttachmentMetadata: vi.fn(),
  getAttachmentMetadata: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  goalService: () => ({}),
  projectService: () => ({}),
  issueApprovalService: () => ({}),
  feedbackService: () => ({}),
  instanceSettingsService: () => ({}),
  executionWorkspaceService: () => ({}),
  workProductService: () => ({}),
  documentService: () => ({}),
  routineService: () => ({}),
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "00000000-0000-0000-0000-000000000010";
const ISSUE_ID = "00000000-0000-0000-0000-000000000001";
const AGENT_A_ID = "00000000-0000-0000-0000-0000000000aa";
const AGENT_B_ID = "00000000-0000-0000-0000-0000000000bb";
const RUN_A_ID = "00000000-0000-0000-0000-0000000000a1";
const RUN_B_ID = "00000000-0000-0000-0000-0000000000b1";

/** A minimal issue stub owned by agent A with run A. */
const ownedIssue = {
  id: ISSUE_ID,
  companyId: COMPANY_ID,
  status: "in_progress",
  assigneeAgentId: AGENT_A_ID,
  assigneeUserId: null,
  checkoutRunId: RUN_A_ID,
  executionRunId: RUN_A_ID,
  title: "Test issue",
  labels: [],
};

// ---------------------------------------------------------------------------
// App factory -- board actor (simplest path, no run-id requirement)
// ---------------------------------------------------------------------------

function createBoardApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [COMPANY_ID],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

/** Agent actor app -- agent attempting to checkout. */
function createAgentApp(agentId: string, runId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId: COMPANY_ID,
      runId,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("issue checkout conflict contract (#691)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockImplementation((id: string) =>
      Promise.resolve({ id, companyId: COMPANY_ID, status: "active" }),
    );
    mockIssueService.getById.mockResolvedValue(ownedIssue);
    // getByIdentifier is called by the router.param("id") handler for any ID
    // matching /^[A-Z]+-\d+$/i (e.g. "issue-1" matches). Returning null falls
    // through to the raw UUID path so the test fixture ID works as expected.
    mockIssueService.getByIdentifier.mockResolvedValue(null);
  });

  // -------------------------------------------------------------------------
  // 1. Concurrent checkout conflict -- 409 with full detail body
  // -------------------------------------------------------------------------

  it("returns 409 with conflict details when agent B checks out an issue owned by active agent A", async () => {
    const conflictDetails = {
      issueId: ISSUE_ID,
      status: "in_progress",
      assigneeAgentId: AGENT_A_ID,
      checkoutRunId: RUN_A_ID,
      executionRunId: RUN_A_ID,
    };
    mockIssueService.checkout.mockRejectedValue(
      conflict("Issue checkout conflict", conflictDetails),
    );

    const app = createAgentApp(AGENT_B_ID, RUN_B_ID);
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_B_ID, expectedStatuses: ["in_progress"] });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Issue checkout conflict");
    expect(res.body.details).toMatchObject({
      issueId: ISSUE_ID,
      status: "in_progress",
      assigneeAgentId: AGENT_A_ID,
      checkoutRunId: RUN_A_ID,
      executionRunId: RUN_A_ID,
    });
  });

  it("returns 409 when a board user attempts checkout on a locked issue", async () => {
    const conflictDetails = {
      issueId: ISSUE_ID,
      status: "in_progress",
      assigneeAgentId: AGENT_A_ID,
      checkoutRunId: RUN_A_ID,
      executionRunId: RUN_A_ID,
    };
    mockIssueService.checkout.mockRejectedValue(
      conflict("Issue checkout conflict", conflictDetails),
    );

    const app = createBoardApp();
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_A_ID, expectedStatuses: ["in_progress"] });

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject(conflictDetails);
  });

  it("conflict response body contains all five required fields", async () => {
    mockIssueService.checkout.mockRejectedValue(
      conflict("Issue checkout conflict", {
        issueId: ISSUE_ID,
        status: "in_progress",
        assigneeAgentId: AGENT_A_ID,
        checkoutRunId: RUN_A_ID,
        executionRunId: RUN_A_ID,
      }),
    );

    const app = createAgentApp(AGENT_B_ID, RUN_B_ID);
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_B_ID, expectedStatuses: ["in_progress"] });

    expect(res.status).toBe(409);
    const { details } = res.body;
    // All five fields required by the #691 acceptance criterion must be present.
    expect(details).toHaveProperty("issueId");
    expect(details).toHaveProperty("status");
    expect(details).toHaveProperty("assigneeAgentId");
    expect(details).toHaveProperty("checkoutRunId");
    expect(details).toHaveProperty("executionRunId");
  });

  // -------------------------------------------------------------------------
  // 2. Same-owner idempotency -- 200 (no conflict thrown)
  // -------------------------------------------------------------------------

  it("returns 200 when the same agent and run re-checkout an already owned in_progress issue", async () => {
    // Service returns the issue (not an error) because the run already owns it.
    mockIssueService.checkout.mockResolvedValue(ownedIssue);

    const app = createAgentApp(AGENT_A_ID, RUN_A_ID);
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_A_ID, expectedStatuses: ["in_progress"] });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ISSUE_ID);
  });

  it("does not emit a 409 for same-owner idempotent re-checkout", async () => {
    mockIssueService.checkout.mockResolvedValue(ownedIssue);

    const app = createAgentApp(AGENT_A_ID, RUN_A_ID);
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_A_ID, expectedStatuses: ["in_progress"] });

    expect(res.status).not.toBe(409);
  });

  // -------------------------------------------------------------------------
  // 3. Stale-run adoption -- 200 (prior run is terminal, new run takes over)
  // -------------------------------------------------------------------------

  it("returns 200 when same agent adopts ownership with a new run after prior run is terminal", async () => {
    // Service resolves because the prior run is stale/terminal and adoption succeeds.
    const adoptedIssue = { ...ownedIssue, checkoutRunId: RUN_B_ID, executionRunId: RUN_B_ID };
    mockIssueService.checkout.mockResolvedValue(adoptedIssue);

    const app = createAgentApp(AGENT_A_ID, RUN_B_ID);
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_A_ID, expectedStatuses: ["in_progress"] });

    expect(res.status).toBe(200);
    expect(res.body.checkoutRunId).toBe(RUN_B_ID);
  });

  it("does not emit a 409 for stale-run adoption", async () => {
    const adoptedIssue = { ...ownedIssue, checkoutRunId: RUN_B_ID, executionRunId: RUN_B_ID };
    mockIssueService.checkout.mockResolvedValue(adoptedIssue);

    const app = createAgentApp(AGENT_A_ID, RUN_B_ID);
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_A_ID, expectedStatuses: ["in_progress"] });

    expect(res.status).not.toBe(409);
  });

  it("returns 409 when same agent tries to adopt an issue whose prior run is still active", async () => {
    // Service throws because the prior run is active, not stale.
    mockIssueService.checkout.mockRejectedValue(
      conflict("Issue checkout conflict", {
        issueId: ISSUE_ID,
        status: "in_progress",
        assigneeAgentId: AGENT_A_ID,
        checkoutRunId: RUN_A_ID,
        executionRunId: RUN_A_ID,
      }),
    );

    const app = createAgentApp(AGENT_A_ID, RUN_B_ID);
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_A_ID, expectedStatuses: ["in_progress"] });

    expect(res.status).toBe(409);
  });

  // -------------------------------------------------------------------------
  // Guard: agent cannot checkout as a different agent
  // -------------------------------------------------------------------------

  it("returns 403 when an agent attempts to checkout as a different agent", async () => {
    const app = createAgentApp(AGENT_B_ID, RUN_B_ID);
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_A_ID, expectedStatuses: ["in_progress"] });

    expect(res.status).toBe(403);
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });
});
