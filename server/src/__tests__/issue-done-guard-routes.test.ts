import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  listComments: vi.fn(async () => []),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  listIssueDocuments: vi.fn(async () => []),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDbSelectOrderBy = vi.hoisted(() => vi.fn(async () => []));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({ orderBy: mockDbSelectOrderBy })));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
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
  getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: true })),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  getActiveForIssueById: vi.fn(async () => null),
  revalidateActiveSourceRecoveryAfterCommittedWrite: vi.fn(async () => null),
}));
const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => mockRoutineService,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => mockDocumentService,
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({
    listApprovalsForIssue: vi.fn(async () => []),
  }),
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
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
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

const mockSpawnSync = vi.hoisted(() => vi.fn());
const mockExecFilePromise = vi.hoisted(() => vi.fn());
const mockExecFile = vi.hoisted(() => {
  const fn: any = vi.fn((file, args, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    cb(null, "", "");
  });
  fn[Symbol.for("nodejs.util.promisify.custom")] = mockExecFilePromise;
  return fn;
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: mockSpawnSync,
    execFile: mockExecFile,
  };
});

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockReaddirSync = vi.hoisted(() => vi.fn());
const mockStatSync = vi.hoisted(() => vi.fn());
const mockAccess = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockReaddir = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    readdirSync: mockReaddirSync,
    statSync: mockStatSync,
    promises: {
      access: mockAccess,
      readFile: mockReadFile,
      readdir: mockReaddir,
    },
  };
});

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
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
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(status: "todo" | "done" | "in_progress" = "in_progress") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    projectId: "c4525f28-55d1-4378-864c-aec26d51fc37",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Comment reopen default",
  };
}

describe("Done transition guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockReturnValue({ allowed: true });
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["PAP-580-run"]);
    mockStatSync.mockReturnValue({ mtimeMs: Date.now() });
    
    mockAccess.mockImplementation(async (path: string) => {
      if (mockExistsSync(path)) {
        return;
      }
      throw new Error("File/directory does not exist");
    });
    mockReaddir.mockImplementation(async (path: string) => mockReaddirSync(path));
    mockReadFile.mockImplementation(async (path: string) => mockReadFileSync(path));

    mockExecFilePromise.mockResolvedValue({
      stdout: JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-06-16T12:00:00Z",
        headRefOid: "abcdef1234567890",
      }),
      stderr: "",
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes("run-manifest.json")) {
        return JSON.stringify({
          taskRoute: { prBacked: true },
          gates: { no_mistakes: { verdict: "PASS", path: "no_mistakes.json" } }
        });
      }
      if (path.includes("no_mistakes.json")) {
        return JSON.stringify({
          verdict: "PASS",
          details: { head: "abcdef1234567890" }
        });
      }
      return "{}";
    });
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-06-16T12:00:00Z",
        headRefOid: "abcdef1234567890",
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks transition to done when PR is missing", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([]);

    const app = createApp();
    await installActor(app);

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Linked implementation PR/work product is required");
  });

  it("allows transition to done when PR and No Mistakes passed", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      { body: "https://github.com/org/repo/pull/123" }
    ]);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      status: "done"
    });

    const app = createApp();
    await installActor(app);

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("allows transition to done for QA/report-only container", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      title: "Full authenticated browser and visual QA review",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      status: "done"
    });
    // Ensure no Foreman runs exist
    mockReaddirSync.mockReturnValue([]);

    const app = createApp();
    await installActor(app);

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("allows transition to done when waiver is present", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      { body: "Samuel approved waiver: no-mistakes-waived", authorType: "user" }
    ]);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      status: "done"
    });

    const app = createApp();
    await installActor(app);

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("blocks transition to done when waiver is self-declared by agent", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      { body: "Samuel approved waiver: no-mistakes-waived", authorType: "agent" }
    ]);

    const app = createApp();
    await installActor(app);

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Linked implementation PR/work product is required");
  });

  it("blocks transition to done when PR is not merged", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      { body: "https://github.com/org/repo/pull/123" }
    ]);
    mockExecFilePromise.mockResolvedValue({
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        headRefOid: "abcdef1234567890",
      }),
      stderr: "",
    });

    const app = createApp();
    await installActor(app);

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Linked implementation PR must be merged before transitioning to done.");
  });

  it("allows transition to done for finding card with user override comment even if plan exists", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockDocumentService.listIssueDocuments.mockResolvedValue([{ key: "plan" }]);

    mockIssueService.listComments.mockResolvedValue([
      { body: "not new implementation work", authorType: "user" }
    ]);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      status: "done"
    });

    const app = createApp();
    await installActor(app);

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("blocks transition to done for finding card with agent fix comment", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      { body: "I have fixed this issue locally", authorType: "agent" }
    ]);

    const app = createApp();
    await installActor(app);

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Linked implementation PR/work product is required");
  });

  it("blocks transition to done for finding card when comment is authored by agent", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockDocumentService.listIssueDocuments.mockResolvedValue([{ key: "plan" }]);

    mockIssueService.listComments.mockResolvedValue([
      { body: "not new implementation work", authorType: "agent" }
    ]);

    const app = createApp();
    await installActor(app);

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Linked implementation PR/work product is required");
  });

  it("blocks transition to done when runs directory does not exist", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      { body: "https://github.com/org/repo/pull/123" }
    ]);
    mockExistsSync.mockReturnValue(false); // runsDir does not exist

    const app = createApp();
    await installActor(app);

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Factory runs directory is unavailable");
  });

  it("blocks transition to done when head SHA does not match", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      { body: "https://github.com/org/repo/pull/123" }
    ]);
    
    // Mismatch: PR head is abcdef1234567890, but gate head is different
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes("run-manifest.json")) {
        return JSON.stringify({
          taskRoute: { prBacked: true },
          gates: { no_mistakes: { verdict: "PASS", path: "no_mistakes.json" } }
        });
      }
      if (path.includes("no_mistakes.json")) {
        return JSON.stringify({
          verdict: "PASS",
          details: { head: "mismatchedheadsha123" }
        });
      }
      return "{}";
    });

    const app = createApp();
    await installActor(app);

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("No Mistakes gate proof is missing or does not match");
  });

  it("blocks transition to done for finding card with no comments, plan, or PR", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      title: "Broken login finding",
      labels: [{ name: "qa-finding" }],
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([]);

    const app = createApp();
    await installActor(app);

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Linked implementation PR/work product is required");
  });

  it("allows transition to done for finding card with evidence-record label", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      title: "Broken login finding",
      labels: [{ name: "evidence-record" }],
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      status: "done"
    });

    const app = createApp();
    await installActor(app);

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });
});
