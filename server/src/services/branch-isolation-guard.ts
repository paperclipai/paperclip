/**
 * BranchIsolationGuard — prevents concurrent agents from editing the same
 * git branch or worktree, enforcing the `feature/KIN-{ticket}-...` naming
 * convention.
 *
 * Motivation (from [KIN-612](/KIN/issues/KIN-612)):
 *   Agents were observed editing shared branches concurrently, causing
 *   conflicts and lost work. This guard provides:
 *
 *   1. **Branch ownership tracking** — an in-memory lease that maps branch
 *      names to the agent run currently editing them.
 *   2. **Naming convention enforcement** — agents must use
 *      `feature/KIN-{ticket}-{description}` branches.
 *   3. **Collision detection at realization time** — before a workspace is
 *      created, the guard checks whether another agent already owns the branch.
 *
 * Leases are NOT persisted across server restarts (they are soft guardrails,
 * not cryptographic locks). A server restart clears all leases and the next
 * heartbeat re-establishes them.
 *
 * @see KIN-617 — Implementation ticket
 */

import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BranchLease {
  /** The git branch name (e.g. "feature/KIN-617-model-context-guards"). */
  branchName: string;
  /** Agent ID that holds this lease. */
  agentId: string;
  /** The heartbeat run that acquired the lease. */
  runId: string;
  /** The issue the agent is working on. */
  issueId: string | null;
  /** Timestamp when the lease was acquired. */
  acquiredAt: string;
}

export interface BranchIsolationCheckResult {
  /** Whether the branch is safe to use for this agent. */
  allowed: boolean;
  /** If not allowed, why. */
  reason: string | null;
  /** The conflicting lease (if collision detected). */
  conflict: BranchLease | null;
}

// ---------------------------------------------------------------------------
// Branch naming validation
// ---------------------------------------------------------------------------

/**
 * Expected branch name pattern:
 *   feature/KIN-{ticket}-{short-description}
 *
 * Examples:
 *   feature/KIN-617-model-context-guards     ✓
 *   feature/KIN-123                          ✓ (minimal)
 *   main                                     ✗ (shared)
 *   develop                                  ✗ (shared)
 *   fix/bug                                  ✗ (wrong prefix)
 *   feature/OTHER-1-fix                      ✗ (no KIN prefix)
 */
const FEATURE_BRANCH_RE = /^feature\/KIN-\d+/;
const SHARED_BRANCHES = new Set([
  "main",
  "master",
  "develop",
  "dev",
  "staging",
  "release",
  "HEAD",
]);

function isSharedBranch(branch: string): boolean {
  return SHARED_BRANCHES.has(branch.toLowerCase());
}

function isValidFeatureBranch(branch: string): boolean {
  return FEATURE_BRANCH_RE.test(branch);
}

// ---------------------------------------------------------------------------
// BranchIsolationGuard
// ---------------------------------------------------------------------------

export interface BranchIsolationGuard {
  /**
   * Try to acquire a branch lease for an agent run.
   *
   * @returns The check result. If allowed, the lease has been acquired
   *   and recorded. If not allowed, the `conflict` field describes what
   *   is blocking.
   */
  acquireBranch(
    branchName: string,
    agentId: string,
    runId: string,
    issueId: string | null,
  ): BranchIsolationCheckResult;

  /**
   * Release a branch lease when an agent run completes or is cancelled.
   * Idempotent — releasing a non-existent lease is a no-op.
   */
  releaseBranch(branchName: string, runId: string): void;

  /**
   * Release ALL leases held by a specific run (used during cleanup).
   */
  releaseByRun(runId: string): void;

  /** Check ownership without acquiring. */
  checkBranch(branchName: string, agentId: string): BranchIsolationCheckResult;

  /** Get all active leases (for diagnostics). */
  getLeases(): BranchLease[];

  /** Number of active leases. */
  leaseCount(): number;

  /** Get the lease for a branch, if any. */
  getLeaseForBranch(branchName: string): BranchLease | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBranchIsolationGuard(): BranchIsolationGuard {
  const log = logger.child({ service: "branch-isolation-guard" });

  // branchName → lease
  const leases = new Map<string, BranchLease>();

  return {
    acquireBranch(branchName, agentId, runId, issueId) {
      // Block shared branches entirely.
      if (isSharedBranch(branchName)) {
        const reason = `Branch "${branchName}" is a shared ref — agents must use feature branches.`;
        log.warn({ branchName, agentId, runId }, "Shared branch blocked");
        return { allowed: false, reason, conflict: null };
      }

      // Enforce naming convention.
      if (!isValidFeatureBranch(branchName)) {
        const reason = `Branch "${branchName}" does not match convention "feature/KIN-{ticket}-...". ` +
          `Agents must create feature branches per KIN ticket.`;
        log.warn({ branchName, agentId, runId }, "Branch naming convention violation");
        return { allowed: false, reason, conflict: null };
      }

      // Check for existing lease.
      const existing = leases.get(branchName);
      if (existing) {
        // Same agent + same run = re-entrant (idempotent).
        if (existing.agentId === agentId && existing.runId === runId) {
          return { allowed: true, reason: null, conflict: null };
        }

        const reason = `Branch "${branchName}" is already checked out by agent ` +
          `"${existing.agentId}" (run ${existing.runId}) since ${existing.acquiredAt}.`;
        log.warn(
          {
            branchName,
            requestingAgent: agentId,
            requestingRun: runId,
            existingAgent: existing.agentId,
            existingRun: existing.runId,
          },
          "Branch collision detected",
        );
        return { allowed: false, reason, conflict: existing };
      }

      // Acquire.
      const lease: BranchLease = {
        branchName,
        agentId,
        runId,
        issueId,
        acquiredAt: new Date().toISOString(),
      };
      leases.set(branchName, lease);

      log.info(
        { branchName, agentId, runId, issueId },
        "Branch lease acquired",
      );

      return { allowed: true, reason: null, conflict: null };
    },

    releaseBranch(branchName, runId) {
      const existing = leases.get(branchName);
      if (!existing) return;

      // Only the run that acquired the lease can release it.
      if (existing.runId !== runId) {
        log.warn(
          {
            branchName,
            releasingRun: runId,
            owningRun: existing.runId,
          },
          "Run attempted to release branch it does not own",
        );
        return;
      }

      leases.delete(branchName);
      log.info({ branchName, runId }, "Branch lease released");
    },

    releaseByRun(runId) {
      let removed = 0;
      for (const [branch, lease] of leases) {
        if (lease.runId === runId) {
          leases.delete(branch);
          removed++;
        }
      }
      if (removed > 0) {
        log.info({ runId, removedBranches: removed }, "Released all branch leases for run");
      }
    },

    checkBranch(branchName, agentId) {
      if (isSharedBranch(branchName)) {
        return {
          allowed: false,
          reason: `Branch "${branchName}" is a shared ref.`,
          conflict: null,
        };
      }

      if (!isValidFeatureBranch(branchName)) {
        return {
          allowed: false,
          reason: `Branch "${branchName}" does not match convention.`,
          conflict: null,
        };
      }

      const existing = leases.get(branchName);
      if (existing && existing.agentId !== agentId) {
        return {
          allowed: false,
          reason: `Branch "${branchName}" owned by agent "${existing.agentId}".`,
          conflict: existing,
        };
      }

      return { allowed: true, reason: null, conflict: null };
    },

    getLeases() {
      return Array.from(leases.values());
    },

    leaseCount() {
      return leases.size;
    },

    getLeaseForBranch(branchName) {
      return leases.get(branchName) ?? null;
    },
  };
}

/**
 * Singleton instance shared across the application. Created once at server
 * startup. The guard is intentionally in-memory — it resets on restart.
 */
let instance: BranchIsolationGuard | null = null;

export function getBranchIsolationGuard(): BranchIsolationGuard {
  if (!instance) {
    instance = createBranchIsolationGuard();
  }
  return instance;
}

/**
 * Reset the singleton (for tests).
 */
export function resetBranchIsolationGuard(): void {
  instance = null;
}
