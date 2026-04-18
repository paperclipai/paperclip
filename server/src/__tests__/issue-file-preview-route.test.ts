import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
    listIssueDocuments: vi.fn(async () => []),
  }),
  executionGateService: () => ({
    getExecutionBlock: vi.fn(),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
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
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => mockProjectService,
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

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

describe("issue file preview route", () => {
  let tempRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-issue-preview-"));
    await fs.mkdir(path.join(tempRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "docs", "listing.md"), "# Listing brief\n\nUse the uploaded images.\n");
    await fs.writeFile(path.join(tempRoot, "docs", "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      projectId: "project-1",
      identifier: "PAP-1",
    });
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockProjectService.getById.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      codebase: {
        effectiveLocalFolder: tempRoot,
      },
    });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("returns bounded text previews for files inside the project root", async () => {
    const res = await request(createApp())
      .get("/api/issues/issue-1/file-preview")
      .query({ path: "docs/listing.md" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        path: "docs/listing.md",
        exists: true,
        kind: "text",
        snippet: expect.stringContaining("# Listing brief"),
      }),
    );
  });

  it("returns image metadata plus a content path for safe image previews", async () => {
    const res = await request(createApp())
      .get("/api/issues/issue-1/file-preview")
      .query({ path: "docs/photo.png" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        path: "docs/photo.png",
        exists: true,
        kind: "image",
        contentPath: "/api/issues/issue-1/file-preview/content?path=docs%2Fphoto.png",
      }),
    );
  });

  it("rejects traversal outside the project root", async () => {
    const res = await request(createApp())
      .get("/api/issues/issue-1/file-preview")
      .query({ path: "../secrets.txt" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/path/i);
  });

  it("returns a missing preview state when the file does not exist", async () => {
    const res = await request(createApp())
      .get("/api/issues/issue-1/file-preview")
      .query({ path: "docs/missing.md" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        path: "docs/missing.md",
        exists: false,
        kind: "missing",
      }),
    );
  });
});
