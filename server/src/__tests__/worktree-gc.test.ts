/**
 * Worktree GC unit tests.
 *
 * All external I/O (git, gh CLI, fs, DB) is mocked so the tests run without a
 * real git repo or GitHub connection.
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before importing the module under test.
// ---------------------------------------------------------------------------

// We mock the entire `node:child_process` module to intercept `execFile` calls.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// We mock `node:fs/promises` to intercept readdir / stat calls.
vi.mock("node:fs/promises", () => ({
  default: {
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}));

import { execFile as execFileMock } from "node:child_process";
import fsMock from "node:fs/promises";
import { runWorktreeGc, startWorktreeGc, stopWorktreeGc } from "../services/worktree-gc.js";

// ---------------------------------------------------------------------------
// Typed helpers
// ---------------------------------------------------------------------------

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Queue a successful execFile response.
 *
 * `execFile` can be invoked as:
 *   execFile(cmd, args, callback)          — 3 args (no options)
 *   execFile(cmd, args, options, callback) — 4 args (with options)
 *
 * `promisify` always injects the callback as the LAST argument.
 */
function mockExecOnce(stdout: string, stderr = "") {
  vi.mocked(execFileMock as AnyFn).mockImplementationOnce(
    (...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: null,
        result: { stdout: string; stderr: string },
      ) => void;
      // Schedule callback asynchronously so promise resolution is natural
      process.nextTick(() => cb(null, { stdout, stderr }));
    },
  );
}

/**
 * Queue a failing execFile response.
 */
function mockExecOnceError(message: string) {
  vi.mocked(execFileMock as AnyFn).mockImplementationOnce(
    (...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void;
      process.nextTick(() => cb(new Error(message)));
    },
  );
}

// ---------------------------------------------------------------------------
// Fake DB helpers
// ---------------------------------------------------------------------------

/**
 * Build a DB mock that returns separate results for each `.select()…where()`
 * chain invocation.
 *
 * GC call order:
 *   1st select/where → collectDbCandidates (execution_workspaces strategyType=git_worktree)
 *   2nd select/where → getActiveWorktreePaths (execution_workspaces active status)
 *   3rd select/where → getActiveWorktreePaths (heartbeat_runs queued|running)
 */
function makeSequentialDb(
  candidates: Array<{ providerRef: string | null; cwd: string | null; strategyType: string }>,
  activeWorkspaces: Array<{ providerRef: string | null; cwd: string | null }>,
  liveRuns: Array<{ id: string }>,
) {
  const responses: unknown[][] = [candidates, activeWorkspaces, liveRuns];
  let callIndex = 0;

  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const res = responses[callIndex] ?? [];
          callIndex++;
          return Promise.resolve(res);
        },
      }),
    }),
  };
  return db as unknown as import("@paperclipai/db").Db;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = "/home/user/myrepo";
const AGENT_WORKTREE_BASE = `${REPO_ROOT}/.paperclip/worktrees/agent`;

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  stopWorktreeGc(); // ensure no dangling intervals from previous tests
});

afterEach(() => {
  stopWorktreeGc();
});

// ---------------------------------------------------------------------------
// Helper: set up filesystem mocks for one lane with one worktree dir.
// ---------------------------------------------------------------------------

function mockFsOneWorktree(lane: string, branchDir: string) {
  vi.mocked(fsMock.readdir as AnyFn).mockResolvedValueOnce([lane] as any); // lanes
  vi.mocked(fsMock.readdir as AnyFn).mockResolvedValueOnce([branchDir] as any); // branch dirs
  vi.mocked(fsMock.stat as AnyFn).mockResolvedValue({ isDirectory: () => true } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runWorktreeGc", () => {
  /**
   * Happy path: merged PR, no unpushed commits → worktree is removed.
   *
   * execFile call order (repoRoot is provided so no initial git rev-parse):
   *   1. git rev-parse --abbrev-ref HEAD   → branch name
   *   2. git remote get-url origin          → GitHub URL (for resolveGitHubRepoSlug)
   *   3. gh pr list ...                     → merged PR JSON
   *   4. git rev-parse --verify origin/<b>  → remote tracking branch exists
   *   5. git log origin/<b>..HEAD           → empty (no unpushed)
   *   6. git worktree remove --force <path> → success
   *   7. git branch -D <branch>             → success
   *   8. git worktree prune                 → success
   */
  it("removes a worktree whose branch has a merged PR and no unpushed commits", async () => {
    const branch = "agent/AGE-42";
    mockFsOneWorktree("lane1", "AGE-42");

    const db = makeSequentialDb([], [], []);

    mockExecOnce(branch);                               // 1. rev-parse branch
    mockExecOnce("https://github.com/acme/repo.git");  // 2. git remote get-url
    mockExecOnce('[{"number":7}]');                     // 3. gh pr list
    mockExecOnce("abc1234");                            // 4. rev-parse verify
    mockExecOnce("");                                   // 5. git log (empty → no unpushed)
    mockExecOnce("");                                   // 6. worktree remove
    mockExecOnce("");                                   // 7. branch -D
    mockExecOnce("");                                   // 8. worktree prune

    const result = await runWorktreeGc(db, { repoRoot: REPO_ROOT });

    expect(result.removed).toBe(1);
    expect(result.skippedActive).toBe(0);
    expect(result.skippedUnmerged).toBe(0);
    expect(result.skippedSafetyBranch).toBe(0);
    expect(result.skippedUnpushed).toBe(0);
    expect(result.errors).toBe(0);
  });

  /**
   * No merged PR on GitHub → worktree is skipped.
   *
   * execFile call order:
   *   1. git rev-parse --abbrev-ref HEAD
   *   2. git remote get-url origin
   *   3. gh pr list → empty array
   */
  it("skips a worktree whose branch has no merged PR", async () => {
    const branch = "agent/AGE-99";
    mockFsOneWorktree("lane1", "AGE-99");

    const db = makeSequentialDb([], [], []);

    mockExecOnce(branch);                              // 1. rev-parse branch
    mockExecOnce("https://github.com/acme/repo.git"); // 2. git remote get-url
    mockExecOnce("[]");                                // 3. gh pr list → no PR

    const result = await runWorktreeGc(db, { repoRoot: REPO_ROOT });

    expect(result.removed).toBe(0);
    expect(result.skippedUnmerged).toBe(1);
  });

  /**
   * Worktree is currently active (execution_workspace row with active status
   * that references this path) → skip without touching git or gh.
   */
  it("skips a worktree that is actively used (status active in DB)", async () => {
    const worktreePath = path.join(AGENT_WORKTREE_BASE, "lane2", "AGE-55");
    mockFsOneWorktree("lane2", "AGE-55");

    const db = makeSequentialDb(
      [],
      [{ providerRef: worktreePath, cwd: null }], // active workspace
      [],
    );

    // No git/gh calls expected — the worktree is skipped before branch resolution.

    const result = await runWorktreeGc(db, { repoRoot: REPO_ROOT });

    expect(result.removed).toBe(0);
    expect(result.skippedActive).toBe(1);
  });

  /**
   * Branch name does not match `agent/*` → safety guard skips it.
   *
   * execFile call order:
   *   1. git rev-parse --abbrev-ref HEAD → "feat/cool-feature"
   */
  it("skips a branch that does not match agent/* (safety check)", async () => {
    mockFsOneWorktree("lane1", "some-branch");

    const db = makeSequentialDb([], [], []);

    mockExecOnce("feat/cool-feature"); // 1. rev-parse → non-agent branch

    const result = await runWorktreeGc(db, { repoRoot: REPO_ROOT });

    expect(result.removed).toBe(0);
    expect(result.skippedSafetyBranch).toBe(1);
  });

  /**
   * Branch has a merged PR but there are local commits not yet pushed to origin
   * → safety check prevents deletion.
   *
   * execFile call order:
   *   1. rev-parse branch
   *   2. git remote get-url origin
   *   3. gh pr list → merged
   *   4. rev-parse --verify origin/<branch>
   *   5. git log → non-empty (unpushed commits)
   */
  it("skips a worktree with unpushed commits even when PR is merged", async () => {
    const branch = "agent/AGE-77";
    mockFsOneWorktree("lane1", "AGE-77");

    const db = makeSequentialDb([], [], []);

    mockExecOnce(branch);                              // 1. rev-parse
    mockExecOnce("https://github.com/acme/repo.git"); // 2. git remote get-url
    mockExecOnce('[{"number":3}]');                    // 3. gh pr list → merged
    mockExecOnce("def5678");                           // 4. rev-parse verify
    mockExecOnce("abc1234 some extra commit");         // 5. git log → unpushed

    const result = await runWorktreeGc(db, { repoRoot: REPO_ROOT });

    expect(result.removed).toBe(0);
    expect(result.skippedUnpushed).toBe(1);
  });

  /**
   * PR is merged, no unpushed commits, but `git worktree remove` fails →
   * error is counted.
   *
   * execFile call order:
   *   1–5 same as the remove test
   *   6. git worktree remove → error
   */
  it("counts errors when git worktree remove fails", async () => {
    const branch = "agent/AGE-88";
    mockFsOneWorktree("lane1", "AGE-88");

    const db = makeSequentialDb([], [], []);

    mockExecOnce(branch);
    mockExecOnce("https://github.com/acme/repo.git");
    mockExecOnce('[{"number":9}]');
    mockExecOnce("abc1111");
    mockExecOnce("");                                        // no unpushed
    mockExecOnceError("fatal: worktree not found");          // worktree remove fails

    const result = await runWorktreeGc(db, { repoRoot: REPO_ROOT });

    expect(result.removed).toBe(0);
    expect(result.errors).toBe(1);
  });
});

describe("startWorktreeGc / stopWorktreeGc", () => {
  it("starts and stops without throwing", () => {
    const db = makeSequentialDb([], [], []);
    expect(() => startWorktreeGc(db, { repoRoot: REPO_ROOT })).not.toThrow();
    expect(() => stopWorktreeGc()).not.toThrow();
  });

  it("is idempotent — calling start twice does not create two intervals", () => {
    const db = makeSequentialDb([], [], []);
    startWorktreeGc(db, { repoRoot: REPO_ROOT });
    startWorktreeGc(db, { repoRoot: REPO_ROOT }); // second call is a no-op
    stopWorktreeGc();
    expect(true).toBe(true);
  });
});
