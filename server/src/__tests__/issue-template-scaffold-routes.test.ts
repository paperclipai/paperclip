import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { REQUIRED_SECTIONS } from "../issue-template-scaffold.js";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentPoliciesService: vi.fn(() => ({})),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
  feedbackService: () => ({}),
  instanceSettingsService: () => ({
    get: vi.fn(async () => null),
  }),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

function makeCreatedIssue(description: string) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    identifier: "PAP-1",
    title: "Test issue",
    description,
    status: "backlog",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    labels: [],
    labelIds: [],
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

function createApp() {
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

const FULL_DESCRIPTION =
  "## Objective\n\nDo something\n\n## Scope\n\n**Touch:** foo\n**Do not touch:** bar\n\n## Verification\n\n- [ ] it works";

describe("POST /api/companies/:companyId/issues — scaffold mode (default)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_SPEC_ENFORCE;
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_SPEC_ENFORCE;
  });

  it("scaffolds description when description is missing", async () => {
    mockIssueService.create.mockImplementation((_cid: string, data: { description: string }) =>
      Promise.resolve(makeCreatedIssue(data.description)),
    );

    const app = createApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "My task" });

    expect(res.status).toBe(201);
    for (const section of REQUIRED_SECTIONS) {
      expect(res.body.description).toContain(section);
    }
  });

  it("scaffolds description when description is empty string", async () => {
    mockIssueService.create.mockImplementation((_cid: string, data: { description: string }) =>
      Promise.resolve(makeCreatedIssue(data.description)),
    );

    const app = createApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "My task", description: "" });

    expect(res.status).toBe(201);
    for (const section of REQUIRED_SECTIONS) {
      expect(res.body.description).toContain(section);
    }
  });

  it("passes description through unchanged when all sections are present", async () => {
    mockIssueService.create.mockImplementation((_cid: string, data: { description: string }) =>
      Promise.resolve(makeCreatedIssue(data.description)),
    );

    const app = createApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "My task", description: FULL_DESCRIPTION });

    expect(res.status).toBe(201);
    expect(res.body.description).toBe(FULL_DESCRIPTION);
  });

  it("appends only missing sections when description is partial", async () => {
    mockIssueService.create.mockImplementation((_cid: string, data: { description: string }) =>
      Promise.resolve(makeCreatedIssue(data.description)),
    );

    const partialDesc = "## Objective\n\nDo something important";
    const app = createApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "My task", description: partialDesc });

    expect(res.status).toBe(201);
    // Original objective section preserved
    expect(res.body.description).toContain("Do something important");
    // Missing sections appended
    expect(res.body.description).toContain("## Scope");
    expect(res.body.description).toContain("## Verification");
    // Objective NOT duplicated
    expect(res.body.description.split("## Objective").length).toBe(2);
  });
});

describe("POST /api/companies/:companyId/issues — strict mode (PAPERCLIP_SPEC_ENFORCE=strict)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_SPEC_ENFORCE = "strict";
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_SPEC_ENFORCE;
  });

  it("returns 400 when description is missing", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "My task" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Objective/);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("returns 400 when description lacks required sections", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "My task", description: "Just some text without sections" });

    expect(res.status).toBe(400);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("allows creation when description has all required sections", async () => {
    mockIssueService.create.mockResolvedValue(makeCreatedIssue(FULL_DESCRIPTION));

    const app = createApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "My task", description: FULL_DESCRIPTION });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledOnce();
  });

  it("returns 400 when only Objective and Scope are present", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "My task",
        description: "## Objective\n\nDo stuff\n\n## Scope\n\nTouch: foo",
      });

    expect(res.status).toBe(400);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });
});
