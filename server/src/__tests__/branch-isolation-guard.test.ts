/**
 * Tests for BranchIsolationGuard — branch ownership tracking, naming
 * convention enforcement, and collision detection.
 *
 * Covers scope #3 and #4 from KIN-617:
 * - Per-agent branch isolation via leasing
 * - Shared branch blocking
 * - Feature branch naming convention enforcement
 * - Collision detection for concurrent agent access
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  createBranchIsolationGuard,
  resetBranchIsolationGuard,
  type BranchIsolationGuard,
} from "../services/branch-isolation-guard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let guard: BranchIsolationGuard;

function freshGuard() {
  guard = createBranchIsolationGuard();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BranchIsolationGuard — branch naming", () => {
  beforeEach(() => {
    freshGuard();
  });

  it("allows valid feature branch", () => {
    const result = guard.acquireBranch(
      "feature/KIN-617-model-context-guards",
      "agent-1",
      "run-1",
      "issue-1",
    );
    expect(result.allowed).toBe(true);
    expect(result.conflict).toBeNull();
    expect(guard.leaseCount()).toBe(1);
  });

  it("allows minimal feature branch (no description)", () => {
    const result = guard.acquireBranch(
      "feature/KIN-123",
      "agent-1",
      "run-1",
      "issue-1",
    );
    expect(result.allowed).toBe(true);
    expect(guard.leaseCount()).toBe(1);
  });

  it("blocks shared branch: main", () => {
    const result = guard.acquireBranch(
      "main",
      "agent-1",
      "run-1",
      "issue-1",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("shared ref");
    expect(guard.leaseCount()).toBe(0);
  });

  it("blocks shared branch: master", () => {
    const result = guard.acquireBranch("master", "agent-1", "run-1", null);
    expect(result.allowed).toBe(false);
  });

  it("blocks shared branch: develop", () => {
    const result = guard.acquireBranch("develop", "agent-1", "run-1", null);
    expect(result.allowed).toBe(false);
  });

  it("blocks shared branch: dev", () => {
    const result = guard.acquireBranch("dev", "agent-1", "run-1", null);
    expect(result.allowed).toBe(false);
  });

  it("blocks shared branch: staging", () => {
    const result = guard.acquireBranch("staging", "agent-1", "run-1", null);
    expect(result.allowed).toBe(false);
  });

  it("blocks shared branch: release", () => {
    const result = guard.acquireBranch("release", "agent-1", "run-1", null);
    expect(result.allowed).toBe(false);
  });

  it("blocks branch with wrong prefix", () => {
    const result = guard.acquireBranch(
      "fix/KIN-123-bug",
      "agent-1",
      "run-1",
      null,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("convention");
    expect(guard.leaseCount()).toBe(0);
  });

  it("blocks branch without KIN prefix", () => {
    const result = guard.acquireBranch(
      "feature/OTHER-1-fix",
      "agent-1",
      "run-1",
      null,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("convention");
  });

  it("blocks branch without ticket number", () => {
    const result = guard.acquireBranch(
      "feature/KIN-fix",
      "agent-1",
      "run-1",
      null,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("convention");
  });
});

describe("BranchIsolationGuard — collision detection", () => {
  beforeEach(() => {
    freshGuard();
  });

  it("prevents different agent from acquiring same branch", () => {
    // Agent 1 acquires.
    const r1 = guard.acquireBranch(
      "feature/KIN-617-fix",
      "agent-1",
      "run-1",
      "issue-1",
    );
    expect(r1.allowed).toBe(true);

    // Agent 2 tries same branch.
    const r2 = guard.acquireBranch(
      "feature/KIN-617-fix",
      "agent-2",
      "run-2",
      "issue-2",
    );
    expect(r2.allowed).toBe(false);
    expect(r2.conflict).not.toBeNull();
    expect(r2.conflict!.agentId).toBe("agent-1");
    expect(r2.reason).toContain("already checked out");
  });

  it("allows same agent + same run to re-acquire (idempotent)", () => {
    guard.acquireBranch("feature/KIN-617-fix", "agent-1", "run-1", "issue-1");
    const r2 = guard.acquireBranch(
      "feature/KIN-617-fix",
      "agent-1",
      "run-1",
      "issue-1",
    );
    expect(r2.allowed).toBe(true);
    expect(guard.leaseCount()).toBe(1);
  });

  it("blocks same agent but different run from re-acquiring", () => {
    guard.acquireBranch("feature/KIN-617-fix", "agent-1", "run-1", "issue-1");
    const r2 = guard.acquireBranch(
      "feature/KIN-617-fix",
      "agent-1",
      "run-2",
      "issue-2",
    );
    expect(r2.allowed).toBe(false);
    expect(r2.conflict!.runId).toBe("run-1");
  });
});

describe("BranchIsolationGuard — release", () => {
  beforeEach(() => {
    freshGuard();
  });

  it("releases branch lease by run", () => {
    guard.acquireBranch("feature/KIN-1-a", "agent-1", "run-1", "issue-1");
    guard.acquireBranch("feature/KIN-2-b", "agent-1", "run-1", "issue-2");
    expect(guard.leaseCount()).toBe(2);

    guard.releaseBranch("feature/KIN-1-a", "run-1");
    expect(guard.leaseCount()).toBe(1);
    expect(guard.getLeaseForBranch("feature/KIN-1-a")).toBeNull();
  });

  it("does not release if run does not own the lease", () => {
    guard.acquireBranch("feature/KIN-1-a", "agent-1", "run-1", "issue-1");
    guard.releaseBranch("feature/KIN-1-a", "run-2"); // wrong run
    expect(guard.leaseCount()).toBe(1);
    expect(guard.getLeaseForBranch("feature/KIN-1-a")).not.toBeNull();
  });

  it("releaseByRun clears all leases for a run", () => {
    guard.acquireBranch("feature/KIN-1-a", "agent-1", "run-1", "issue-1");
    guard.acquireBranch("feature/KIN-2-b", "agent-1", "run-1", "issue-2");
    guard.acquireBranch("feature/KIN-3-c", "agent-2", "run-2", "issue-3");
    expect(guard.leaseCount()).toBe(3);

    guard.releaseByRun("run-1");
    expect(guard.leaseCount()).toBe(1);
    expect(guard.getLeaseForBranch("feature/KIN-3-c")).not.toBeNull();
  });

  it("release non-existent branch is a no-op", () => {
    guard.releaseBranch("feature/KIN-999-nonexistent", "run-1");
    expect(guard.leaseCount()).toBe(0);
  });
});

describe("BranchIsolationGuard — check (read-only)", () => {
  beforeEach(() => {
    freshGuard();
  });

  it("check returns allowed=true for unowned branch", () => {
    const result = guard.checkBranch(
      "feature/KIN-617-unowned",
      "agent-1",
    );
    expect(result.allowed).toBe(true);
  });

  it("check returns allowed=false for shared branch", () => {
    const result = guard.checkBranch("main", "agent-1");
    expect(result.allowed).toBe(false);
  });

  it("check detects foreign ownership", () => {
    guard.acquireBranch("feature/KIN-617-test", "agent-1", "run-1", "issue-1");
    const result = guard.checkBranch("feature/KIN-617-test", "agent-2");
    expect(result.allowed).toBe(false);
    expect(result.conflict!.agentId).toBe("agent-1");
  });
});

describe("BranchIsolationGuard — singleton", () => {
  beforeEach(() => {
    resetBranchIsolationGuard();
  });

  it("returns same instance from getter", async () => {
    const { getBranchIsolationGuard } = await import("../services/branch-isolation-guard.js");
    const g1 = getBranchIsolationGuard();
    const g2 = getBranchIsolationGuard();
    expect(g1).toBe(g2);
  });

  it("reset clears singleton", async () => {
    const { getBranchIsolationGuard, resetBranchIsolationGuard } = await import("../services/branch-isolation-guard.js");
    const g1 = getBranchIsolationGuard();
    resetBranchIsolationGuard();
    const g2 = getBranchIsolationGuard();
    expect(g1).not.toBe(g2);
  });
});
