import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

// Must be hoisted so the mock is available when the module under test is imported.
const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: mockExecFile };
});

// Import AFTER the mock is registered.
import { runPostDoneCleanup } from "../services/post-done-cleanup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WorkspaceRow = {
  id: string;
  companyId: string;
  projectId: string;
  sourceIssueId: string | null;
  status: string;
  cwd: string | null;
  branchName: string | null;
  providerType: string;
  strategyType: string;
  closedAt: Date | null;
  cleanupReason: string | null;
  metadata: Record<string, unknown> | null;
};

function makeWorkspace(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    id: "ws-1",
    companyId: "co-1",
    projectId: "proj-1",
    sourceIssueId: "issue-1",
    status: "active",
    cwd: `${os.homedir()}/Documents/Projects/test-repo`,
    branchName: "agent/feature/backenddev/test-branch",
    providerType: "local_fs",
    strategyType: "project_primary",
    closedAt: null,
    cleanupReason: null,
    metadata: null,
    ...overrides,
  };
}

type MockDbResult = {
  db: Db;
  updateSetWhere: ReturnType<typeof vi.fn>;
  updateSet: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function makeMockDb(workspaceRow: WorkspaceRow | undefined): MockDbResult {
  const updateSetWhere = vi.fn().mockResolvedValue({ rowCount: 1 });
  const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  const selectLimit = vi.fn().mockResolvedValue(workspaceRow ? [workspaceRow] : []);
  const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit });
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockReturnValue({ from: selectFrom });

  return {
    db: { select, update } as unknown as Db,
    updateSetWhere,
    updateSet,
    update,
  };
}

const ALLOWED_ROOTS = [`${os.homedir()}/Documents/Projects/`];

// ---------------------------------------------------------------------------
// Unit tests — execFile mocked
// ---------------------------------------------------------------------------

describe("runPostDoneCleanup — unit (execFile mocked)", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns early and fires no shell commands when no workspace is found", async () => {
    const { db } = makeMockDb(undefined);

    await runPostDoneCleanup({
      db,
      issueId: "issue-1",
      issueIdentifier: "POI-1",
      allowedRoots: ALLOWED_ROOTS,
    });

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("patches workspace with non_local_provider_skipped and fires no shell commands when providerType is not local_fs", async () => {
    const ws = makeWorkspace({ providerType: "git_worktree" });
    const { db, updateSet, updateSetWhere } = makeMockDb(ws);

    await runPostDoneCleanup({
      db,
      issueId: "issue-1",
      issueIdentifier: "POI-1",
      allowedRoots: ALLOWED_ROOTS,
    });

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "closed",
        cleanupReason: "non_local_provider_skipped",
      }),
    );
    expect(updateSetWhere).toHaveBeenCalledOnce();
  });

  it("skips and patches when cwd is null", async () => {
    const ws = makeWorkspace({ cwd: null });
    const { db, updateSet } = makeMockDb(ws);

    await runPostDoneCleanup({
      db,
      issueId: "issue-1",
      issueIdentifier: "POI-1",
      allowedRoots: ALLOWED_ROOTS,
    });

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "closed", cleanupReason: "skipped_cwd_not_allowed" }),
    );
  });

  it("skips and patches when cwd is a relative path", async () => {
    const ws = makeWorkspace({ cwd: "relative/path" });
    const { db, updateSet } = makeMockDb(ws);

    await runPostDoneCleanup({
      db,
      issueId: "issue-1",
      issueIdentifier: "POI-1",
      allowedRoots: ALLOWED_ROOTS,
    });

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "closed", cleanupReason: "skipped_cwd_not_allowed" }),
    );
  });

  it("skips and patches when cwd is not under any allowed root", async () => {
    const ws = makeWorkspace({ cwd: "/etc/secret" });
    const { db, updateSet } = makeMockDb(ws);

    await runPostDoneCleanup({
      db,
      issueId: "issue-1",
      issueIdentifier: "POI-1",
      allowedRoots: ALLOWED_ROOTS,
    });

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "closed", cleanupReason: "skipped_cwd_not_allowed" }),
    );
  });

  it("calls git rev-parse with exact args to discover main repo", async () => {
    const ws = makeWorkspace();
    const { db } = makeMockDb(ws);

    // rev-parse succeeds → returns same cwd (relative .git = main repo)
    // opts is always {} (service always passes explicit options), so callback is at position 3.
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args.includes("rev-parse")) {
        cb(null, { stdout: ".git\n", stderr: "" });
      } else if (args.includes("-d")) {
        cb(null, { stdout: "", stderr: "" });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    });

    await runPostDoneCleanup({
      db,
      issueId: "issue-1",
      issueIdentifier: "POI-1",
      allowedRoots: ALLOWED_ROOTS,
    });

    const revParseCall = mockExecFile.mock.calls.find((c: unknown[]) =>
      Array.isArray(c[1]) && (c[1] as string[]).includes("rev-parse"),
    );
    expect(revParseCall).toBeDefined();
    // Exact argv: git -C <cwd> rev-parse --git-common-dir
    expect(revParseCall![0]).toBe("git");
    expect(revParseCall![1]).toEqual(["-C", ws.cwd, "rev-parse", "--git-common-dir"]);
  });

  it("calls git branch -d (not -D) with exact args when branch is valid", async () => {
    const ws = makeWorkspace();
    const { db } = makeMockDb(ws);

    // Service always passes {} as options, so callback is at position 3.
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args.includes("rev-parse")) {
        cb(null, { stdout: ".git\n", stderr: "" });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    });

    await runPostDoneCleanup({
      db,
      issueId: "issue-1",
      issueIdentifier: "POI-1",
      allowedRoots: ALLOWED_ROOTS,
    });

    const branchDeleteCall = mockExecFile.mock.calls.find((c: unknown[]) =>
      Array.isArray(c[1]) && (c[1] as string[]).includes("-d"),
    );
    expect(branchDeleteCall).toBeDefined();
    expect(branchDeleteCall![0]).toBe("git");
    // Must use -d (safe), never -D (force)
    expect(branchDeleteCall![1]).toContain("-d");
    expect(branchDeleteCall![1]).not.toContain("-D");
    expect(branchDeleteCall![1]).toContain(ws.branchName);
  });

  it("patches workspace row with status=closed and cleanup metadata on success", async () => {
    const ws = makeWorkspace();
    const { db, updateSet } = makeMockDb(ws);

    // Service always passes {} as options, so callback is at position 3.
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: ".git\n", stderr: "" });
    });

    await runPostDoneCleanup({
      db,
      issueId: "issue-1",
      issueIdentifier: "POI-1",
      allowedRoots: ALLOWED_ROOTS,
    });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "closed",
        closedAt: expect.any(Date),
        cleanupReason: expect.any(String),
        metadata: expect.objectContaining({
          cleanup: expect.objectContaining({
            branchDeleted: expect.any(Boolean),
            worktreeRemoved: expect.any(Boolean),
          }),
        }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Path-traversal security tests
  // -------------------------------------------------------------------------

  it("[security] skips with zero shell calls when cwd contains shell metacharacters", async () => {
    const ws = makeWorkspace({ cwd: "/tmp/evil; rm -rf /" });
    const { db } = makeMockDb(ws);

    await runPostDoneCleanup({
      db,
      issueId: "issue-1",
      issueIdentifier: "POI-1",
      allowedRoots: ALLOWED_ROOTS,
    });

    // Must fire zero execFile calls — path traversal attempt is blocked before shell
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("[security] skips branch deletion with zero shell calls when branchName contains shell metacharacters", async () => {
    const ws = makeWorkspace({ branchName: "; rm -rf /" });
    const { db } = makeMockDb(ws);

    // Service always passes {} as options, so callback is at position 3.
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args.includes("rev-parse")) {
        cb(null, { stdout: ".git\n", stderr: "" });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    });

    await runPostDoneCleanup({
      db,
      issueId: "issue-1",
      issueIdentifier: "POI-1",
      allowedRoots: ALLOWED_ROOTS,
    });

    // rev-parse may run (cwd is valid), but branch -d must NOT run
    const branchDeleteCall = mockExecFile.mock.calls.find((c: unknown[]) =>
      Array.isArray(c[1]) && (c[1] as string[]).includes("-d"),
    );
    expect(branchDeleteCall).toBeUndefined();
  });

  it("[security] skips with zero shell calls when cwd escapes allowed roots via traversal", async () => {
    const ws = makeWorkspace({ cwd: `${os.homedir()}/Documents/Projects/../../etc` });
    const { db } = makeMockDb(ws);

    await runPostDoneCleanup({
      db,
      issueId: "issue-1",
      issueIdentifier: "POI-1",
      allowedRoots: ALLOWED_ROOTS,
    });

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Non-merged branch test
  // -------------------------------------------------------------------------

  it("sets cleanupReason=branch_not_merged and leaves branch intact when -d refuses", async () => {
    const ws = makeWorkspace();
    const { db, updateSet } = makeMockDb(ws);

    // Service always passes {} as options, so callback is at position 3.
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args.includes("rev-parse")) {
        cb(null, { stdout: ".git\n", stderr: "" });
      } else if (args.includes("-d")) {
        // git -d refuses unmerged branch
        const err = Object.assign(new Error("error: The branch is not fully merged."), {
          stderr: "error: The branch 'test-branch' is not fully merged.",
          code: 1,
        });
        cb(err, null);
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    });

    await runPostDoneCleanup({
      db,
      issueId: "issue-1",
      issueIdentifier: "POI-1",
      allowedRoots: ALLOWED_ROOTS,
    });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "closed",
        cleanupReason: "branch_not_merged",
        metadata: expect.objectContaining({
          cleanup: expect.objectContaining({
            branchDeleted: false,
          }),
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Path normalization — no db needed
// ---------------------------------------------------------------------------

describe("runPostDoneCleanup — allowed-roots normalization", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("expands ~ in allowed roots before comparing", async () => {
    const absPath = `${os.homedir()}/Documents/Projects/myrepo`;
    const ws = makeWorkspace({ cwd: absPath });
    const { db } = makeMockDb(ws);

    // Provide tilde root, expect it to be expanded and match
    // Service always passes {} as options, so callback is at position 3.
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: ".git\n", stderr: "" });
    });

    // Should NOT skip (cwd is under the expanded root)
    await runPostDoneCleanup({
      db,
      issueId: "issue-1",
      issueIdentifier: "POI-1",
      allowedRoots: ["~/Documents/Projects/"],
    });

    // If it didn't skip, execFile should have been called (rev-parse at minimum)
    expect(mockExecFile).toHaveBeenCalled();
  });
});
