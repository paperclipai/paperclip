/**
 * HTTP-level regression test for ADR-008 (DOGAA-2620).
 *
 * Verifies that POST /api/companies/:companyId/issues:
 *   - allows the first N requests under the threshold
 *   - returns 429 with the ADR §2.3 body shape on the (N+1)th request
 *   - invokes the guard so the agent gets paused + an alert issue is created
 *   - short-circuits cleanly when the feature flag is off
 *   - never invokes the limiter when the actor role is exempted
 *
 * Service mocks follow the same pattern as
 * `issue-assigned-backlog-contract-routes.test.ts` — we mock `services/index.js`
 * via `vi.mock` and pass a stubbed `IssueCreateRateLimiter` /
 * `IssueCreateRateLimitGuard` into `issueRoutes`.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIssueCreateRateLimiter,
  parseIssueCreateRateLimitConfig,
  type IssueCreateRateLimiter,
} from "../services/issue-create-rate-limit.js";
import {
  createIssueCreateRateLimitGuard,
  RATE_LIMIT_PAUSE_REASON,
  type IssueCreateRateLimitGuard,
} from "../services/issue-create-rate-limit-guard.js";

const COMPANY_ID = "company-1";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CTO_AGENT_ID = "2fe5c471-69e3-4593-b2d8-e58f229d9812";

type RateLimitSettings = Record<string, unknown> | null;

const state = vi.hoisted(() => ({
  rateLimitSettings: null as RateLimitSettings,
  agentRow: null as
    | null
    | {
        id: string;
        companyId: string;
        name: string;
        role: string;
        status: string;
        pauseReason: string | null;
      },
}));

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(async (_companyId: string, data: Record<string, unknown>) => ({
    id: "issue-out-1",
    companyId: COMPANY_ID,
    identifier: "PAP-7000",
    title: String(data.title ?? ""),
    description: (data.description as string | undefined) ?? null,
    status: String(data.status ?? "todo"),
    priority: String(data.priority ?? "medium"),
    parentId: null,
    assigneeAgentId: (data.assigneeAgentId as string | null | undefined) ?? null,
    assigneeUserId: null,
    createdByAgentId: (data.createdByAgentId as string | null | undefined) ?? null,
    createdByUserId: (data.createdByUserId as string | null | undefined) ?? null,
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
  })),
  createChild: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
  addComment: vi.fn(async () => ({ id: "comment-1" })),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
    listActiveUserMemberships: vi.fn(async () => [
      { principalType: "user", principalId: "owner-user-1", membershipRole: "owner", status: "active" },
    ]),
  }),
  agentService: () => ({
    getById: vi.fn(async (id: string) =>
      state.agentRow && state.agentRow.id === id ? state.agentRow : null,
    ),
  }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: COMPANY_ID, attachmentMaxBytes: 10 * 1024 * 1024 })),
    getRateLimitSettings: vi.fn(async () => state.rateLimitSettings),
  }),
  documentService: () => ({ getIssueDocumentPayload: vi.fn(async () => ({})) }),
  executionWorkspaceService: () => ({ getById: vi.fn(async () => null) }),
  feedbackService: () => ({ listIssueVotesForUser: vi.fn(async () => []) }),
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
    listCompanyIds: vi.fn(async () => [COMPANY_ID]),
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
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
}));

type GuardSpies = {
  pauseAgent: ReturnType<typeof vi.fn>;
  createAlertIssue: ReturnType<typeof vi.fn>;
  appendAlertComment: ReturnType<typeof vi.fn>;
  resolveOwnerUserIds: ReturnType<typeof vi.fn>;
  loadRecentIssueIdentifiers: ReturnType<typeof vi.fn>;
};

async function createApp(input: {
  limiter: IssueCreateRateLimiter;
  guard: IssueCreateRateLimitGuard;
  asAgent?: boolean;
}) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = input.asAgent
      ? {
          type: "agent",
          agentId: AGENT_ID,
          companyId: COMPANY_ID,
          runId: "run-1",
          source: "agent_jwt",
          isInstanceAdmin: false,
        }
      : {
          type: "board",
          userId: "local-board",
          companyIds: [COMPANY_ID],
          source: "local_implicit",
          isInstanceAdmin: false,
        };
    next();
  });
  app.use(
    "/api",
    issueRoutes({} as any, {} as any, {
      issueCreateRateLimiter: input.limiter,
      issueCreateRateLimitGuard: input.guard,
    }),
  );
  app.use(errorHandler);
  return app;
}

function makeGuardSpies(): { guard: IssueCreateRateLimitGuard; spies: GuardSpies } {
  const spies: GuardSpies = {
    pauseAgent: vi.fn(async () => undefined),
    createAlertIssue: vi.fn(async () => ({ id: "alert-1", identifier: "PAP-GUARD-1" })),
    appendAlertComment: vi.fn(async () => undefined),
    resolveOwnerUserIds: vi.fn(async () => ["owner-user-1"]),
    loadRecentIssueIdentifiers: vi.fn(async () => [{ id: "i1", identifier: "PAP-1" }]),
  };
  const guard = createIssueCreateRateLimitGuard({
    pauseAgent: spies.pauseAgent as never,
    createAlertIssue: spies.createAlertIssue as never,
    appendAlertComment: spies.appendAlertComment as never,
    resolveOwnerUserIds: spies.resolveOwnerUserIds as never,
    loadRecentIssueIdentifiers: spies.loadRecentIssueIdentifiers as never,
    now: () => 1_700_000_000_000,
  });
  return { guard, spies };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rateLimitSettings = {
    issueCreation: {
      enabled: true,
      windowMinutes: 10,
      maxIssuesPerWindow: 3,
      exemptAgentIds: [],
      exemptAgentRoles: [],
      governanceAssigneeAgentId: CTO_AGENT_ID,
    },
  };
  state.agentRow = {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: "MailHandler",
    role: "general",
    status: "idle",
    pauseReason: null,
  };
});

async function postIssue(app: express.Express, title: string) {
  return request(app)
    .post(`/api/companies/${COMPANY_ID}/issues`)
    .send({ title, assigneeAgentId: AGENT_ID });
}

describe("POST /api/companies/:companyId/issues — rate-limit guard wiring (ADR-008)", () => {
  it("returns 429 with the ADR §2.3 body shape once the threshold is exceeded", async () => {
    const limiter = createIssueCreateRateLimiter({ now: () => 1_700_000_000_000 });
    const { guard, spies } = makeGuardSpies();
    const app = await createApp({ limiter, guard, asAgent: true });

    for (let i = 0; i < 3; i += 1) {
      const ok = await postIssue(app, `under-${i}`);
      expect(ok.status).toBe(201);
    }
    expect(spies.createAlertIssue).not.toHaveBeenCalled();

    const blocked = await postIssue(app, "blocked");
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.body).toMatchObject({
      error: "issue_create_rate_limit_exceeded",
      windowMinutes: 10,
      maxIssuesPerWindow: 3,
      agentId: AGENT_ID,
    });
    expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);

    // Guard side-effects fired exactly once, with the correct pause reason.
    expect(spies.pauseAgent).toHaveBeenCalledTimes(1);
    expect(spies.pauseAgent).toHaveBeenCalledWith({ agentId: AGENT_ID, reason: RATE_LIMIT_PAUSE_REASON });
    expect(spies.createAlertIssue).toHaveBeenCalledTimes(1);
    const alertCall = spies.createAlertIssue.mock.calls[0]?.[0];
    expect(alertCall.governanceAssigneeAgentId).toBe(CTO_AGENT_ID);
    expect(alertCall.notifyUserIds).toContain("owner-user-1");
    expect(alertCall.body).toContain("PAP-1"); // recent-issue preview wired

    // The downstream issueService.create must not be invoked when blocked.
    expect(mockIssueService.create).toHaveBeenCalledTimes(3);
  });

  it("short-circuits when companies.rate_limit_settings.issueCreation.enabled is false", async () => {
    state.rateLimitSettings = {
      issueCreation: { enabled: false, windowMinutes: 10, maxIssuesPerWindow: 3 },
    };
    const limiter = createIssueCreateRateLimiter({ now: () => 1_700_000_000_000 });
    const { guard, spies } = makeGuardSpies();
    const app = await createApp({ limiter, guard, asAgent: true });

    for (let i = 0; i < 5; i += 1) {
      const res = await postIssue(app, `flag-off-${i}`);
      expect(res.status).toBe(201);
    }
    expect(spies.pauseAgent).not.toHaveBeenCalled();
    expect(spies.createAlertIssue).not.toHaveBeenCalled();
  });

  it("skips the rate limit when the agent role is in exemptAgentRoles", async () => {
    state.rateLimitSettings = {
      issueCreation: {
        enabled: true,
        windowMinutes: 10,
        maxIssuesPerWindow: 1,
        exemptAgentRoles: ["bulk-importer"],
      },
    };
    state.agentRow = { ...state.agentRow!, role: "bulk-importer" };
    const limiter = createIssueCreateRateLimiter({ now: () => 1_700_000_000_000 });
    const consumeSpy = vi.spyOn(limiter, "consume");
    const { guard, spies } = makeGuardSpies();
    const app = await createApp({ limiter, guard, asAgent: true });

    for (let i = 0; i < 3; i += 1) {
      const res = await postIssue(app, `exempt-${i}`);
      expect(res.status).toBe(201);
    }
    expect(consumeSpy).not.toHaveBeenCalled();
    expect(spies.pauseAgent).not.toHaveBeenCalled();
  });

  it("does not enforce the limit when the caller is a board user (per ADR §2.1 'subject' interpretation)", async () => {
    const limiter = createIssueCreateRateLimiter({ now: () => 1_700_000_000_000 });
    const consumeSpy = vi.spyOn(limiter, "consume");
    const { guard, spies } = makeGuardSpies();
    const app = await createApp({ limiter, guard, asAgent: false });

    for (let i = 0; i < 5; i += 1) {
      const res = await postIssue(app, `board-${i}`);
      expect(res.status).toBe(201);
    }
    expect(consumeSpy).not.toHaveBeenCalled();
    expect(spies.pauseAgent).not.toHaveBeenCalled();
  });

  it("uses companies.getRateLimitSettings → parseIssueCreateRateLimitConfig — defaults to enabled when settings are empty", async () => {
    // No issueCreation node in settings → defaults pop in.
    state.rateLimitSettings = {};
    expect(parseIssueCreateRateLimitConfig(state.rateLimitSettings).enabled).toBe(true);
    expect(parseIssueCreateRateLimitConfig(state.rateLimitSettings).maxIssuesPerWindow).toBe(30);
  });
});
