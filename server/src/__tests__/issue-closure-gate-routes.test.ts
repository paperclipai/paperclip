import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Fixture IDs ---
const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "bbbbbbbb-bbbb-4bbb-4bbb-bbbbbbbbbbbb";
const agentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Mutable shared state — set in beforeEach
let tmpRepoPath = "";
let tmpRepoHeadSha = "";
let tmpRepoFilePath = "server/src/services/closureGate.ts";

// Mutable workspace override — test (h) uses this to swap repos mid-run
let workspaceCwdOverride: string | null = null;

// --- Service mocks (hoisted so they survive resetModules) ---
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(async () => ({ id: "comment-1", body: "test comment", issueId: issueId, createdAt: new Date() })),
  getCurrentScheduledRetry: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockAccessService = vi.hoisted(() => ({
  hasPermission: vi.fn(async () => false),
  canUser: vi.fn(async () => false),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockRecoveryActionsSvc = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  create: vi.fn(async () => null),
  update: vi.fn(async () => null),
}));

const mockIssueThreadInteractionsSvc = vi.hoisted(() => ({
  getMostRecentPendingForIssue: vi.fn(async () => null),
  getById: vi.fn(async () => null),
  create: vi.fn(async () => null),
  respond: vi.fn(async () => null),
}));

function makeWorkspace() {
  return {
    id: workspaceId,
    companyId: "company-1",
    mode: "shared_workspace",
    status: "active",
    cwd: workspaceCwdOverride ?? tmpRepoPath,
    providerRef: null,
    baseRef: "master",
    branchName: "ben/feature",
    closedAt: null,
    name: "test-workspace",
  };
}

function registerServiceMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));
  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));
  vi.doMock("../services/execution-workspaces.js", () => ({
    executionWorkspaceService: () => ({
      getById: vi.fn(async () => makeWorkspace()),
    }),
  }));
  vi.doMock("../services/issue-recovery-actions.js", () => ({
    issueRecoveryActionService: () => mockRecoveryActionsSvc,
  }));
  vi.doMock("../services/issue-thread-interactions.js", () => ({
    issueThreadInteractionService: () => mockIssueThreadInteractionsSvc,
  }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    activityService: () => ({ list: vi.fn(async () => []) }),
    agentService: () => ({ getById: vi.fn(async () => null) }),
    agentInstructionsService: () => ({}),
    approvalService: () => ({}),
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    companySearchService: () => ({
      search: vi.fn(async () => ({ results: [], total: 0 })),
    }),
    dashboardService: () => ({}),
    documentService: () => ({
      getOrCreate: vi.fn(async () => null),
      upsert: vi.fn(async () => null),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
    }),
    executionWorkspaceService: () => ({
      getById: vi.fn(async () => makeWorkspace()),
    }),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({
      getDefaultCompanyGoal: vi.fn(async () => null),
      getById: vi.fn(async () => null),
    }),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { maxConcurrentCheckouts: 1 },
        billing: { enabled: false },
        auth: { enabled: false },
      })),
    }),
    issueApprovalService: () => ({
      listForIssue: vi.fn(async () => []),
    }),
    issueRecoveryActionService: () => ({
      ...mockRecoveryActionsSvc,
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueReferenceService: () => ({
      deleteDocumentSource: vi.fn(async () => undefined),
      diffIssueReferenceSummary: vi.fn(() => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      })),
      emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
      listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
      syncComment: vi.fn(async () => undefined),
      syncDocument: vi.fn(async () => undefined),
      syncIssue: vi.fn(async () => undefined),
      listIssueReferenceSummaryByIds: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => ({
      ...mockIssueThreadInteractionsSvc,
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    ISSUE_LIST_MAX_LIMIT: 1000,
    clampIssueListLimit: (limit: number) => Math.min(1000, Math.max(1, Math.floor(limit))),
    logActivity: mockLogActivity,
    projectService: () => ({
      getById: vi.fn(async () => null),
    }),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({
      listForIssue: vi.fn(async () => []),
    }),
  }));
}

// --- Helpers ---
function createTmpGitRepo(opts: { branch?: string; filePath?: string } = {}) {
  const branch = opts.branch ?? "master";
  const filePath = opts.filePath ?? tmpRepoFilePath;
  const dir = mkdtempSync(join(tmpdir(), "closure-gate-test-"));
  execSync(`git init -b ${branch}`, { cwd: dir });
  execSync("git config user.email 'test@test.com'", { cwd: dir });
  execSync("git config user.name 'Test'", { cwd: dir });
  const parts = filePath.split("/");
  if (parts.length > 1) {
    mkdirSync(join(dir, parts.slice(0, -1).join("/")), { recursive: true });
  }
  writeFileSync(join(dir, filePath), "// closure gate\n");
  execSync("git add .", { cwd: dir });
  execSync("git commit -m 'feat: add closure gate'", { cwd: dir });
  const sha = execSync("git log --oneline -1", { cwd: dir })
    .toString()
    .trim()
    .split(" ")[0];
  return { repoPath: dir, headSha: sha, branch };
}

// Creates a working repo with a bare "remote". The working commit is on local
// branch only (not pushed to remote) unless opts.pushCommit is true.
function createTmpRepoWithRemote(opts: { branch?: string; pushCommit?: boolean } = {}) {
  const branch = opts.branch ?? "master";
  // Bare remote
  const remoteDir = mkdtempSync(join(tmpdir(), "closure-gate-remote-"));
  execSync("git init --bare", { cwd: remoteDir });
  // Working repo
  const workDir = mkdtempSync(join(tmpdir(), "closure-gate-work-"));
  execSync(`git init -b ${branch}`, { cwd: workDir });
  execSync("git config user.email 'test@test.com'", { cwd: workDir });
  execSync("git config user.name 'Test'", { cwd: workDir });
  execSync(`git remote add origin ${remoteDir}`, { cwd: workDir });
  // Initial commit — pushed so remote has the branch ref
  writeFileSync(join(workDir, "initial.txt"), "initial\n");
  execSync("git add .", { cwd: workDir });
  execSync("git commit -m 'initial'", { cwd: workDir });
  execSync(`git push origin ${branch}`, { cwd: workDir });
  // Working commit (the sha we'll reference in the closing comment)
  const filePath = tmpRepoFilePath;
  const parts = filePath.split("/");
  if (parts.length > 1) {
    mkdirSync(join(workDir, parts.slice(0, -1).join("/")), { recursive: true });
  }
  writeFileSync(join(workDir, filePath), "// closure gate\n");
  execSync("git add .", { cwd: workDir });
  execSync("git commit -m 'feat: add closure gate'", { cwd: workDir });
  const sha = execSync("git log --oneline -1", { cwd: workDir }).toString().trim().split(" ")[0];
  if (opts.pushCommit) {
    execSync(`git push origin ${branch}`, { cwd: workDir });
  }
  return { repoPath: workDir, remoteDir, headSha: sha, branch };
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId: "company-1",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: agentId,
    assigneeUserId: null,
    createdByAgentId: agentId,
    createdByUserId: null,
    identifier: "UPG-833",
    title: "Test issue",
    description: null,
    projectId: null,
    goalId: null,
    parentId: null,
    executionWorkspaceId: workspaceId,
    executionRunId: null,
    checkoutRunId: null,
    executionPolicy: null,
    executionWorkspaceSettings: null,
    executionState: null,
    labels: [],
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
  // Use board actor to bypass agent-only mutation guards
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
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

// --- Tests ---
describe.sequential("issue closure gate routes", () => {
  let altRepoDirs: string[] = [];

  beforeEach(() => {
    const repo = createTmpGitRepo();
    tmpRepoPath = repo.repoPath;
    tmpRepoHeadSha = repo.headSha;
    workspaceCwdOverride = null;

    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/execution-workspaces.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/issue-recovery-actions.js");
    vi.doUnmock("../services/issue-thread-interactions.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerServiceMocks();
    vi.clearAllMocks();

    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.update.mockResolvedValue({ ...makeIssue(), status: "done" });
    mockRecoveryActionsSvc.getActiveForIssue.mockResolvedValue(null);
  });

  afterEach(() => {
    if (tmpRepoPath) {
      try { rmSync(tmpRepoPath, { recursive: true, force: true }); } catch {}
      tmpRepoPath = "";
    }
    for (const dir of altRepoDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    altRepoDirs = [];
  });

  // (a) Valid HEAD sha + valid path proof → 200 OK
  it("(a) accepts closure with valid HEAD sha and path proof", async () => {
    const comment = [
      `${tmpRepoHeadSha} feat: add closure gate`,
      `git log master --oneline -- ${tmpRepoFilePath}`,
      `${tmpRepoHeadSha} feat: add closure gate`,
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  // (b) Fabricated HEAD sha → 422 INVALID_HEAD_SHA
  it("(b) rejects closure with fabricated HEAD sha", async () => {
    const comment = [
      "cafebabe1234 fake commit message",
      `git log master --oneline -- ${tmpRepoFilePath}`,
      "cafebabe1234 fake commit message",
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("CLOSURE_GATE_REJECTED");
    const codes = res.body.rejections.map((r: { code: string }) => r.code);
    expect(codes).toContain("INVALID_HEAD_SHA");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // (c) Valid HEAD sha but cited path has no commits → 422 PATH_PROOF_MISMATCH
  it("(c) rejects when cited path has no commits on branch", async () => {
    const comment = [
      `${tmpRepoHeadSha} feat: add closure gate`,
      "git log master --oneline -- src/nonexistent/path.ts",
      `${tmpRepoHeadSha} feat: add closure gate`,
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("CLOSURE_GATE_REJECTED");
    const codes = res.body.rejections.map((r: { code: string }) => r.code);
    expect(codes).toContain("PATH_PROOF_MISMATCH");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // (d) Process-only ticket with only HEAD sha → 200 OK
  it("(d) accepts process-only ticket with only HEAD sha", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ labels: [{ id: "label-1", name: "Process Only" }] }),
    );

    const comment = `${tmpRepoHeadSha} process complete — cites no in-repo artifact`;

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  // (e) No closing comment and no description → 422 NO_TEXT or NO_HEAD_SHA
  it("(e) rejects when status done with no comment and no description", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ description: null }));

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("CLOSURE_GATE_REJECTED");
    const codes = res.body.rejections.map((r: { code: string }) => r.code);
    expect(codes.some((c: string) => c === "NO_TEXT" || c === "NO_HEAD_SHA")).toBe(true);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // (f) Path proof mismatch — unmerged path (AC2)
  it("(f) rejects with PATH_PROOF_MISMATCH for unmerged path", async () => {
    const comment = [
      `${tmpRepoHeadSha} commit on branch`,
      "git log master --oneline -- packages/not-yet-merged/file.ts",
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment });

    expect(res.status).toBe(422);
    const codes = res.body.rejections.map((r: { code: string }) => r.code);
    expect(codes).toContain("PATH_PROOF_MISMATCH");
  });

  // (g) No comment body but valid anchors in description → 200 OK (AC2)
  it("(g) accepts when issue description has valid §B anchors (no comment)", async () => {
    const description = [
      `${tmpRepoHeadSha} feat: add closure gate`,
      `git log master --oneline -- ${tmpRepoFilePath}`,
      `${tmpRepoHeadSha} feat: add closure gate`,
    ].join("\n");
    mockIssueService.getById.mockResolvedValue(makeIssue({ description }));

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  // (h) Workspace cwd points to different repo — path exists in tmpRepo but not altRepo (AC2)
  it("(h) rejects when workspace repo does not contain the cited path", async () => {
    const altRepo = createTmpGitRepo({ filePath: "some/other/file.ts" });
    altRepoDirs.push(altRepo.repoPath);

    // Point workspace cwd at the alt repo (which lacks tmpRepoFilePath)
    workspaceCwdOverride = altRepo.repoPath;

    const comment = [
      `${altRepo.headSha} commit in alt repo`,
      `git log master --oneline -- ${tmpRepoFilePath}`,
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment });

    expect(res.status).toBe(422);
    const codes = res.body.rejections.map((r: { code: string }) => r.code);
    expect(codes).toContain("PATH_PROOF_MISMATCH");
  });

  // (i) Multiple paths missing → multiple PATH_PROOF_MISMATCH rejections (AC2)
  it("(i) accumulates multiple PATH_PROOF_MISMATCH rejections", async () => {
    const comment = [
      `${tmpRepoHeadSha} valid commit`,
      "git log master --oneline -- path/a.ts",
      "git log master --oneline -- path/b.ts",
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment });

    expect(res.status).toBe(422);
    expect(res.body.rejections.length).toBeGreaterThanOrEqual(2);
    const codes = res.body.rejections.map((r: { code: string }) => r.code);
    expect(codes.filter((c: string) => c === "PATH_PROOF_MISMATCH").length).toBeGreaterThanOrEqual(2);
  });

  // (j) bypassClosureGate with reason < 10 chars → 400 from Zod schema (AC2)
  it("(j) rejects bypassClosureGate with short reason via schema validation (400)", async () => {
    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", bypassClosureGate: { reason: "short" } });

    // Zod schema validation throws → errorHandler returns 400
    expect(res.status).toBe(400);
    expect(res.body.error).not.toBe("CLOSURE_GATE_REJECTED");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // (k) Non-default-branch path proof → 422 INVALID_PROOF_BRANCH (rev 2, UPG-838)
  it("(k) rejects INVALID_PROOF_BRANCH when path proof cites non-default-branch ref", async () => {
    const featureBranch = "ben/upg-833-pre-close-sha-validation-hook";
    const comment = [
      `${tmpRepoHeadSha} feat: add closure gate`,
      `git log ${featureBranch} --oneline -- ${tmpRepoFilePath}`,
      `${tmpRepoHeadSha} feat: add closure gate`,
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("CLOSURE_GATE_REJECTED");
    const codes = res.body.rejections.map((r: { code: string }) => r.code);
    expect(codes).toContain("INVALID_PROOF_BRANCH");
    const rejection = res.body.rejections.find((r: { code: string }) => r.code === "INVALID_PROOF_BRANCH");
    expect(rejection.message).toContain(featureBranch);
    expect(rejection.message).toContain("master");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // (l) bypassClosureGate reason matches PR-not-merged deny-list → 422 INVALID_BYPASS_REASON (rev 2, UPG-838)
  it("(l) rejects INVALID_BYPASS_REASON when bypass reason matches PR-not-merged deny-list", async () => {
    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: `${tmpRepoHeadSha} done`,
        bypassClosureGate: { reason: "PR not yet merged" },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("CLOSURE_GATE_REJECTED");
    const codes = res.body.rejections.map((r: { code: string }) => r.code);
    expect(codes).toContain("INVALID_BYPASS_REASON");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // (m) Malformed reachability line missing ref token → 422 INVALID_PROOF_BRANCH (<REF>=<missing>) (rev 2, UPG-838)
  it("(m) rejects INVALID_PROOF_BRANCH for malformed reachability line missing ref token", async () => {
    const comment = [
      `${tmpRepoHeadSha} feat: add closure gate`,
      `git log --oneline -- ${tmpRepoFilePath}`,
      `${tmpRepoHeadSha} feat: add closure gate`,
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("CLOSURE_GATE_REJECTED");
    const codes = res.body.rejections.map((r: { code: string }) => r.code);
    expect(codes).toContain("INVALID_PROOF_BRANCH");
    const rejection = res.body.rejections.find((r: { code: string }) => r.code === "INVALID_PROOF_BRANCH");
    expect(rejection.detail?.capturedRef).toBe("<missing>");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // (n) Real sha on local branch NOT pushed to remote → 422 INVALID_REMOTE_REACHABILITY (rev 3, UPG-840)
  it("(n) rejects INVALID_REMOTE_REACHABILITY when sha is local-only (not pushed to remote)", async () => {
    const { repoPath, remoteDir, headSha } = createTmpRepoWithRemote({ pushCommit: false });
    altRepoDirs.push(repoPath, remoteDir);
    workspaceCwdOverride = repoPath;

    const comment = [
      `${headSha} feat: add closure gate`,
      `git log master --oneline -- ${tmpRepoFilePath}`,
      `${headSha} feat: add closure gate`,
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("CLOSURE_GATE_REJECTED");
    const codes = res.body.rejections.map((r: { code: string }) => r.code);
    expect(codes).toContain("INVALID_REMOTE_REACHABILITY");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // (o) Real sha pushed to remote → 200 OK (rev 3, UPG-840)
  it("(o) accepts closure when sha is reachable from origin/<defaultBranch>", async () => {
    const { repoPath, remoteDir, headSha } = createTmpRepoWithRemote({ pushCommit: true });
    altRepoDirs.push(repoPath, remoteDir);
    workspaceCwdOverride = repoPath;

    const comment = [
      `${headSha} feat: add closure gate`,
      `git log master --oneline -- ${tmpRepoFilePath}`,
      `${headSha} feat: add closure gate`,
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  // (p) Fetch fails (unreachable remote URL) → 200 OK fail-open, warn-log emitted (rev 3, UPG-840)
  it("(p) fail-open and accepts closure when git fetch to remote fails", async () => {
    // Point working repo's origin at a non-existent path → fetch fails immediately
    const { repoPath, remoteDir, headSha } = createTmpRepoWithRemote({ pushCommit: true });
    altRepoDirs.push(repoPath, remoteDir);
    // Break origin so fetch always fails
    execSync("git remote set-url origin /nonexistent-bare-repo-xyz", { cwd: repoPath });
    workspaceCwdOverride = repoPath;

    const comment = [
      `${headSha} feat: add closure gate`,
      `git log master --oneline -- ${tmpRepoFilePath}`,
      `${headSha} feat: add closure gate`,
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment });

    // Fail-open: closure proceeds despite fetch failure
    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  // (q) bypassClosureGate reason matches D2 (locally-merged) → 422 INVALID_BYPASS_REASON (rev 3, UPG-840)
  it("(q) rejects INVALID_BYPASS_REASON for D2 deny-list pattern (locally-merged)", async () => {
    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: `${tmpRepoHeadSha} done`,
        bypassClosureGate: { reason: "Merged to local master, GitHub push blocked" },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("CLOSURE_GATE_REJECTED");
    const codes = res.body.rejections.map((r: { code: string }) => r.code);
    expect(codes).toContain("INVALID_BYPASS_REASON");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // (r) bypassClosureGate reason matches D3 (no upstream access) → 422 INVALID_BYPASS_REASON (rev 3, UPG-840)
  it("(r) rejects INVALID_BYPASS_REASON for D3 deny-list pattern (no upstream access)", async () => {
    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: `${tmpRepoHeadSha} done`,
        bypassClosureGate: { reason: "No upstream maintainer access to merge" },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("CLOSURE_GATE_REJECTED");
    const codes = res.body.rejections.map((r: { code: string }) => r.code);
    expect(codes).toContain("INVALID_BYPASS_REASON");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
