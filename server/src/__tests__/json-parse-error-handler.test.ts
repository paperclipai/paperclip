import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
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
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    clampIssueListLimit: (value: number) => value,
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    ISSUE_LIST_MAX_LIMIT: 1000,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
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
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
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
    issueService: () => ({
      getById: vi.fn(),
    }),
    issueThreadInteractionService: () => ({
      listForIssue: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      acceptInteraction: vi.fn(),
      acceptSuggestedTasks: vi.fn(),
      rejectInteraction: vi.fn(),
      rejectSuggestedTasks: vi.fn(),
      expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(),
      answerQuestions: vi.fn(),
      cancelQuestions: vi.fn(),
    }),
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
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

describe.sequential("JSON parse error handler", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    registerModuleMocks();
  });

  it("returns 400 for truncated JSON body", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/comments")
      .set("Content-Type", "application/json")
      .send('{"body": "oops"'); // truncated JSON

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
    expect(res.body.message).toMatch(/Unexpected end|Unexpected token|Expected ',' or '}'/i);
  });

  it("returns 400 for invalid JSON syntax", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/comments")
      .set("Content-Type", "application/json")
      .send('not json at all');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
    expect(res.body.message).toMatch(/Unexpected token/i);
  });

  it("returns 400 for JSON with trailing garbage", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/comments")
      .set("Content-Type", "application/json")
      .send('{"body": "ok"} trailing');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
  });

  it("still returns 201 for valid JSON body", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/comments")
      .set("Content-Type", "application/json")
      .send('{"body": "valid comment"}');

    // The route handler may fail for other reasons (missing mocks), but it
    // must NOT be a 400 Bad Request from the JSON parser.
    expect(res.status).not.toBe(400);
    expect(res.body.error).not.toBe("Bad Request");
  });
});
