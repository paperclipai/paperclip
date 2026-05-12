import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted so vi.mock calls run before module resolution
// ---------------------------------------------------------------------------

const mockEnsureCeoChatIssue = vi.hoisted(() => vi.fn());

// Minimal mocks for services required by issueRoutes but not under test.
// These mirror the pattern used in issues-goal-context-routes.test.ts.
vi.mock("../services/ceo-chat.js", () => ({
  ensureCeoChatIssue: mockEnsureCeoChatIssue,
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
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
    getIssueDocumentByKey: vi.fn(async () => null),
  }),
  environmentService: () => ({}),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: vi.fn(async () => undefined),
    diffIssueReferenceSummary: vi.fn(() => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] })),
    emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
    listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
    syncComment: vi.fn(async () => undefined),
    syncDocument: vi.fn(async () => undefined),
    syncIssue: vi.fn(async () => undefined),
  }),
  issueService: () => ({
    getById: vi.fn(async () => null),
    list: vi.fn(async () => []),
  }),
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
  ISSUE_LIST_DEFAULT_LIMIT: 500,
  ISSUE_LIST_MAX_LIMIT: 2000,
  clampIssueListLimit: vi.fn((n: number) => n),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    })),
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => ({}),
}));

vi.mock("../services/company-search-rate-limit.js", () => ({
  createCompanySearchRateLimiter: vi.fn(),
}));

vi.mock("../services/issue-execution-policy.js", () => ({
  applyIssueExecutionPolicyTransition: vi.fn(),
  normalizeIssueExecutionPolicy: vi.fn(() => null),
  parseIssueExecutionState: vi.fn(() => null),
  redactIssueMonitorExternalRef: vi.fn((x: unknown) => x),
  setIssueExecutionPolicyMonitorScheduledBy: vi.fn(),
}));

vi.mock("../services/execution-workspace-policy.js", () => ({
  parseIssueExecutionWorkspaceSettings: vi.fn(() => null),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(async () => undefined),
}));

vi.mock("./issues-checkout-wakeup.js", () => ({
  shouldWakeAssigneeOnCheckout: vi.fn(() => false),
}));

vi.mock("./environment-selection.js", () => ({
  assertEnvironmentSelectionForCompany: vi.fn(),
}));

vi.mock("./workspace-command-authz.js", () => ({
  assertNoAgentHostWorkspaceCommandMutation: vi.fn(),
  collectIssueWorkspaceCommandPaths: vi.fn(() => []),
}));

vi.mock("../redaction.js", () => ({
  redactSensitiveText: vi.fn((text: unknown) => text),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CEO_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHAT_ISSUE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const ceoChatIssueFixture = {
  id: CHAT_ISSUE_ID,
  companyId: COMPANY_ID,
  assigneeAgentId: CEO_AGENT_ID,
  isCeoChat: true,
  status: "in_progress",
  title: "CEO Chat",
};

// ---------------------------------------------------------------------------
// DB stub factory
//
// The endpoint queries:
//   db.select({ id: agentsTable.id }).from(agentsTable).where(and(...)).then(rows => rows[0] ?? null)
//
// We return a chainable stub where `.then(resolve)` calls `resolve` with the
// configured rows array.  The same stub is re-used; the test controls which
// rows are returned via the `agentRows` parameter.
// ---------------------------------------------------------------------------

function createDbStub(agentRows: { id: string }[]) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn((resolve: (rows: typeof agentRows) => unknown) =>
            Promise.resolve(resolve(agentRows)),
          ),
        }),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// App factory — mirrors the pattern in issues-goal-context-routes.test.ts
// ---------------------------------------------------------------------------

function createApp(db: ReturnType<typeof createDbStub>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(db as any, {} as any));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /companies/:companyId/ceo-chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the CEO chat issue when present", async () => {
    const db = createDbStub([{ id: CEO_AGENT_ID }]);
    mockEnsureCeoChatIssue.mockResolvedValue(ceoChatIssueFixture);

    const app = createApp(db);
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/ceo-chat`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      issueId: CHAT_ISSUE_ID,
      companyId: COMPANY_ID,
      assigneeAgentId: CEO_AGENT_ID,
      isCeoChat: true,
      status: "in_progress",
      title: "CEO Chat",
    });
    expect(mockEnsureCeoChatIssue).toHaveBeenCalledWith(db, COMPANY_ID, CEO_AGENT_ID);
  });

  it("returns 404 when the company has no CEO", async () => {
    // DB returns empty rows — no CEO agent found
    const db = createDbStub([]);
    const app = createApp(db);

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/ceo-chat`);

    expect(res.status).toBe(404);
    expect(mockEnsureCeoChatIssue).not.toHaveBeenCalled();
  });

  it("auto-seeds the chat issue if a CEO exists but the row was missing", async () => {
    // CEO agent found in DB, but ensureCeoChatIssue creates (seeds) a new one
    const db = createDbStub([{ id: CEO_AGENT_ID }]);
    const seededIssue = { ...ceoChatIssueFixture, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
    mockEnsureCeoChatIssue.mockResolvedValue(seededIssue);

    const app = createApp(db);
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/ceo-chat`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      issueId: seededIssue.id,
      companyId: COMPANY_ID,
      assigneeAgentId: CEO_AGENT_ID,
      isCeoChat: true,
    });
    // ensureCeoChatIssue is the upsert — calling it is what triggers the seed
    expect(mockEnsureCeoChatIssue).toHaveBeenCalledTimes(1);
    expect(mockEnsureCeoChatIssue).toHaveBeenCalledWith(db, COMPANY_ID, CEO_AGENT_ID);
  });
});
