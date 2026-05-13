import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ETF-45 evidence-collection test (founder-directed via ETF-48).
// POST a request_confirmation whose payload.prompt contains U+2014 (em-dash)
// through the real route layer with mocked services. Captures the response and
// asserts that:
//   - the HTTP layer accepts the em-dash payload without a 5xx,
//   - the prompt arrives at the service with its U+2014 code point intact.
// If the test ever flips from 201 to 5xx, the captured response is full
// bytes-on-the-wire evidence for ETF-45 — and the test fails loudly.

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  create: vi.fn(),
  acceptInteraction: vi.fn(),
  acceptSuggestedTasks: vi.fn(),
  rejectInteraction: vi.fn(),
  rejectSuggestedTasks: vi.fn(),
  answerQuestions: vi.fn(),
  cancelInteraction: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    clampIssueListLimit: (value: number) => value,
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    ISSUE_LIST_MAX_LIMIT: 1000,
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
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
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockInteractionService,
    getCancellationReasonFromResult: () => null,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

function createIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "ETF-45-repro",
    title: "Em-dash repro fixture",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
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
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("ETF-45 em-dash bytes-on-the-wire repro", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(createIssue());
  });

  it("accepts a request_confirmation prompt containing U+2014 and forwards it to the service", async () => {
    const emDash = "—";
    const prompt = `Founder, please confirm the proposed approach ${emDash} with em-dash.`;

    mockInteractionService.create.mockImplementation(async (_issue: any, body: any) => {
      return {
        id: "interaction-em-dash",
        companyId: "company-1",
        issueId: ISSUE_ID,
        kind: body.kind,
        status: "pending",
        continuationPolicy: body.continuationPolicy ?? "none",
        idempotencyKey: body.idempotencyKey ?? null,
        sourceCommentId: null,
        sourceRunId: null,
        payload: body.payload,
        result: null,
        createdAt: "2026-05-12T23:41:24.000Z",
        updatedAt: "2026-05-12T23:41:24.000Z",
      };
    });

    const app = await createApp();

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/interactions`)
      .set("Content-Type", "application/json; charset=utf-8")
      .send({
        kind: "request_confirmation",
        idempotencyKey: "etf45-emdash-test-1",
        payload: {
          version: 1,
          prompt,
        },
      });

    // Bytes-on-the-wire capture for the PR description.
    const evidence = {
      status: res.status,
      statusText: res.res?.statusMessage ?? "",
      headers: { ...res.headers },
      bodyType: typeof res.body,
      promptCodePoints: Array.from(prompt).map((c) => c.codePointAt(0)?.toString(16)).join(" "),
      receivedPromptCodePoints: undefined as string | undefined,
    };

    if (res.status >= 500) {
      // Bug reproduced — emit the full response so the PR description has
      // the captured bytes for ETF-45.
      throw new Error(
        `ETF-45 reproduced locally. status=${res.status} body=${JSON.stringify(res.body)} ` +
          `headers=${JSON.stringify(res.headers)} evidence=${JSON.stringify(evidence)}`,
      );
    }

    expect(res.status).toBe(201);
    expect(mockInteractionService.create).toHaveBeenCalledTimes(1);
    const receivedPayload = mockInteractionService.create.mock.calls[0]?.[1]?.payload;
    expect(receivedPayload?.prompt).toBe(prompt);
    evidence.receivedPromptCodePoints = Array.from(receivedPayload?.prompt ?? "")
      .map((c) => (c as string).codePointAt(0)?.toString(16))
      .join(" ");
    // U+2014 must survive the HTTP layer round-trip.
    expect(evidence.receivedPromptCodePoints).toContain("2014");
  });

  it("accepts a control ASCII-hyphen prompt as a baseline", async () => {
    const prompt = "Founder, please confirm the proposed approach - simple ASCII hyphen.";

    mockInteractionService.create.mockResolvedValueOnce({
      id: "interaction-ascii",
      companyId: "company-1",
      issueId: ISSUE_ID,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "none",
      idempotencyKey: "etf45-ascii-test-1",
      sourceCommentId: null,
      sourceRunId: null,
      payload: { version: 1, prompt },
      result: null,
      createdAt: "2026-05-12T23:41:24.000Z",
      updatedAt: "2026-05-12T23:41:24.000Z",
    });

    const app = await createApp();

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/interactions`)
      .send({
        kind: "request_confirmation",
        idempotencyKey: "etf45-ascii-test-1",
        payload: { version: 1, prompt },
      });

    expect(res.status).toBe(201);
  });
});
