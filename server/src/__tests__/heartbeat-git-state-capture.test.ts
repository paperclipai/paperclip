/**
 * heartbeat-git-state-capture.test.ts — LIF-456 acceptance tests
 *
 * Tests for capturePreRunGitState and capturePostRunGitState (git-state-capture.ts).
 * All git commands are mocked via vi.mock("node:child_process") so the suite runs
 * without a real git repo.
 *
 * Acceptance scenarios (from LIF-456):
 *   1. Linear  — single new commit + push → commitsCreated.length=1, pushedRefs[0].status="ok"
 *   2. Amend   — commit then amend then push → populated via porcelain; no fatal error
 *   3. Rebase  — rebased history then push → same as amend path
 *   4. No-push — commit only, no push → pushed=false, pushedRefs=[]
 *   5. No-change — no commit, no push → commitsCreated=[], pushedRefs=[], not a failure
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// execFile mock must be hoisted before module load
const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: mockExecFile };
});

import {
  capturePreRunGitState,
  capturePostRunGitState,
} from "../services/git-state-capture.js";

const CWD = "/workspace/test-repo";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type ExecFileCb = (err: Error | null, result: { stdout: string; stderr: string }) => void;
type MockImpl = (cmd: string, args: string[], opts: unknown, cb: ExecFileCb) => void;

function setGitMock(impl: MockImpl) {
  mockExecFile.mockImplementation(impl);
}

/** Build a standard success response */
function ok(stdout = ""): { stdout: string; stderr: string } {
  return { stdout, stderr: "" };
}

/** Build a failure (non-zero exit) response */
function fail(code = 1, stdout = "", stderr = ""): Error {
  return Object.assign(new Error("git command failed"), { code, stdout, stderr, killed: false });
}

// ---------------------------------------------------------------------------
// Pre-run snapshot tests
// ---------------------------------------------------------------------------

describe("capturePreRunGitState", () => {
  beforeEach(() => { mockExecFile.mockReset(); });

  it("returns headBefore and branchBefore on success", async () => {
    setGitMock((_cmd, args, _opts, cb) => {
      if (args.includes("--abbrev-ref")) {
        cb(null, ok("main\n"));
      } else {
        cb(null, ok("aabbccdd1122\n"));
      }
    });

    const snap = await capturePreRunGitState(CWD);
    expect(snap).toEqual({ headBefore: "aabbccdd1122", branchBefore: "main" });
  });

  it("returns branchBefore='HEAD (detached)' when rev-parse --abbrev-ref returns HEAD", async () => {
    setGitMock((_cmd, args, _opts, cb) => {
      if (args.includes("--abbrev-ref")) {
        cb(null, ok("HEAD\n"));
      } else {
        cb(null, ok("deadbeef1234\n"));
      }
    });

    const snap = await capturePreRunGitState(CWD);
    expect(snap?.branchBefore).toBe("HEAD (detached)");
  });

  it("returns null when git commands fail", async () => {
    setGitMock((_cmd, _args, _opts, cb) => cb(fail(), ok()));
    const snap = await capturePreRunGitState(CWD);
    expect(snap).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Post-run: Scenario 1 — Linear case
// ---------------------------------------------------------------------------

describe("capturePostRunGitState — (1) linear: single new commit + push", () => {
  beforeEach(() => { mockExecFile.mockReset(); });

  it("commitsCreated.length=1 and pushedRefs[0].status=ok", async () => {
    const headBefore = "0000000000000000000000000000000000000001";
    const headAfter  = "0000000000000000000000000000000000000002";
    const pre = { headBefore, branchBefore: "feat/my-branch" };

    setGitMock((_cmd, args, _opts, cb) => {
      const a = args as string[];
      if (a.includes("--abbrev-ref")) {
        // branchAfter
        cb(null, ok("feat/my-branch\n"));
      } else if (a.includes("get-url")) {
        // remoteUrl
        cb(null, ok("git@github.com:org/repo.git\n"));
      } else if (a.includes("--is-ancestor")) {
        // merge-base --is-ancestor headBefore headAfter → 0 (ancestor ok)
        cb(null, ok(""));
      } else if (a.includes("push") && a.includes("--porcelain")) {
        // push output: one ref updated
        const porcelain = [
          "To git@github.com:org/repo.git",
          ` \trefs/heads/feat/my-branch:refs/heads/feat/my-branch\t${headBefore}..${headAfter}`,
          "Done",
        ].join("\n") + "\n";
        cb(null, ok(porcelain));
      } else if (a.includes("log") && a.includes("--format=%H%x00%s")) {
        // git log range — one commit
        cb(null, ok(`${headAfter}\x00Add feature\n`));
      } else {
        // HEAD rev-parse (headAfter)
        cb(null, ok(`${headAfter}\n`));
      }
    });

    const state = await capturePostRunGitState(CWD, pre);

    expect(state.headBefore).toBe(headBefore);
    expect(state.headAfter).toBe(headAfter);
    expect(state.branchAfter).toBe("feat/my-branch");
    expect(state.commitsCreated).toHaveLength(1);
    expect(state.commitsCreated[0]).toEqual({ sha: headAfter, subject: "Add feature" });
    expect(state.pushed).toBe(true);
    expect(state.pushedRefs).toHaveLength(1);
    expect(state.pushedRefs[0].status).toBe("ok");
    expect(state.remoteUrl).toBe("git@github.com:org/repo.git");
  });
});

// ---------------------------------------------------------------------------
// Post-run: Scenario 2 — Amend case
// ---------------------------------------------------------------------------

describe("capturePostRunGitState — (2) amend: history rewritten, push succeeds", () => {
  beforeEach(() => { mockExecFile.mockReset(); });

  it("populates runGitState via porcelain output; no fatal error", async () => {
    const headBefore = "aaaa000000000000000000000000000000000001";
    // After amend, headAfter has different SHA (different history)
    const headAfter  = "bbbb000000000000000000000000000000000002";
    const pre = { headBefore, branchBefore: "fix/amend-branch" };

    setGitMock((_cmd, args, _opts, cb) => {
      const a = args as string[];
      if (a.includes("--abbrev-ref")) {
        cb(null, ok("fix/amend-branch\n"));
      } else if (a.includes("get-url")) {
        cb(null, ok("https://github.com/org/repo.git\n"));
      } else if (a.includes("--is-ancestor")) {
        // Non-zero exit: headBefore is NOT an ancestor (history rewritten)
        cb(fail(1), ok(""));
      } else if (a.includes("push") && a.includes("--porcelain")) {
        const porcelain = [
          "To https://github.com/org/repo.git",
          `+\trefs/heads/fix/amend-branch:refs/heads/fix/amend-branch\t${headBefore}..${headAfter}`,
          "Done",
        ].join("\n") + "\n";
        cb(null, ok(porcelain));
      } else if (a.includes("log") && a[a.length - 1] === headAfter) {
        // deriveCommitsFromPushedRefs calls git log -1 --format=%H%x00%s <sha>
        cb(null, ok(`${headAfter}\x00Fix: amend commit\n`));
      } else {
        cb(null, ok(`${headAfter}\n`));
      }
    });

    const state = await capturePostRunGitState(CWD, pre);

    expect(state.pushed).toBe(true);
    expect(state.pushedRefs).toHaveLength(1);
    // commitsCreated derived from push output (rewrite path)
    expect(state.commitsCreated).toHaveLength(1);
    expect(state.commitsCreated[0].sha).toBe(headAfter);
  });
});

// ---------------------------------------------------------------------------
// Post-run: Scenario 3 — Rebase case
// ---------------------------------------------------------------------------

describe("capturePostRunGitState — (3) rebase: history rewritten before push", () => {
  beforeEach(() => { mockExecFile.mockReset(); });

  it("handled identically to amend — no fatal error", async () => {
    const headBefore = "cccc000000000000000000000000000000000001";
    const headAfter  = "dddd000000000000000000000000000000000002";
    const pre = { headBefore, branchBefore: "feat/rebased" };

    setGitMock((_cmd, args, _opts, cb) => {
      const a = args as string[];
      if (a.includes("--abbrev-ref")) {
        cb(null, ok("feat/rebased\n"));
      } else if (a.includes("get-url")) {
        cb(null, ok("https://github.com/org/repo.git\n"));
      } else if (a.includes("--is-ancestor")) {
        cb(fail(1), ok(""));
      } else if (a.includes("push") && a.includes("--porcelain")) {
        const porcelain = [
          "To https://github.com/org/repo.git",
          `+\trefs/heads/feat/rebased:refs/heads/feat/rebased\t${headBefore}..${headAfter}`,
          "Done",
        ].join("\n") + "\n";
        cb(null, ok(porcelain));
      } else if (a.includes("log") && a[a.length - 1] === headAfter) {
        cb(null, ok(`${headAfter}\x00Rebased commit\n`));
      } else {
        cb(null, ok(`${headAfter}\n`));
      }
    });

    await expect(capturePostRunGitState(CWD, pre)).resolves.not.toThrow();

    const state = await capturePostRunGitState(CWD, pre);
    expect(state.pushed).toBe(true);
    expect(state.commitsCreated.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Post-run: Scenario 4 — No-push case
// ---------------------------------------------------------------------------

describe("capturePostRunGitState — (4) no-push: commit only, push fails", () => {
  beforeEach(() => { mockExecFile.mockReset(); });

  it("pushed=false, pushedRefs=[] when push fails (e.g. no remote)", async () => {
    const headBefore = "eeee000000000000000000000000000000000001";
    const headAfter  = "ffff000000000000000000000000000000000002";
    const pre = { headBefore, branchBefore: "local-only" };

    setGitMock((_cmd, args, _opts, cb) => {
      const a = args as string[];
      if (a.includes("--abbrev-ref")) {
        cb(null, ok("local-only\n"));
      } else if (a.includes("get-url")) {
        // no remote configured
        cb(fail(2, "", "fatal: No such remote 'origin'\n"), ok(""));
      } else if (a.includes("--is-ancestor")) {
        cb(null, ok(""));
      } else if (a.includes("push")) {
        cb(fail(128, "", "fatal: 'origin' does not appear to be a git repository\n"), ok(""));
      } else if (a.includes("log")) {
        cb(null, ok(`${headAfter}\x00Local commit\n`));
      } else {
        cb(null, ok(`${headAfter}\n`));
      }
    });

    const state = await capturePostRunGitState(CWD, pre);

    expect(state.pushed).toBe(false);
    expect(state.pushedRefs).toEqual([]);
    // commitsCreated still computed from local range (ancestor ok, different SHA)
    expect(state.commitsCreated).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Post-run: Scenario 5 — No-change case
// ---------------------------------------------------------------------------

describe("capturePostRunGitState — (5) no-change: no commit, no push", () => {
  beforeEach(() => { mockExecFile.mockReset(); });

  it("commitsCreated=[], pushedRefs=[], not a failure", async () => {
    const headSha = "1111000000000000000000000000000000000001";
    const pre = { headBefore: headSha, branchBefore: "main" };

    setGitMock((_cmd, args, _opts, cb) => {
      const a = args as string[];
      if (a.includes("--abbrev-ref")) {
        cb(null, ok("main\n"));
      } else if (a.includes("get-url")) {
        cb(null, ok("https://github.com/org/repo.git\n"));
      } else if (a.includes("push") && a.includes("--porcelain")) {
        // Nothing to push — up-to-date
        const porcelain = [
          "To https://github.com/org/repo.git",
          `=\trefs/heads/main:refs/heads/main\t[up to date]`,
          "Done",
        ].join("\n") + "\n";
        cb(null, ok(porcelain));
      } else {
        // rev-parse HEAD returns same SHA (no new commits)
        cb(null, ok(`${headSha}\n`));
      }
    });

    const state = await capturePostRunGitState(CWD, pre);

    expect(state.commitsCreated).toEqual([]);
    expect(state.pushedRefs).toHaveLength(1);
    // up-to-date ref does not count as "pushed"
    expect(state.pushed).toBe(false);
    // Not a failure — no throw
  });
});
