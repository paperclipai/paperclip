/**
 * Gate 2: initial-modal cleanup and lane-session continuity gates (feacb699)
 *
 * Fail-closed hardening gates for Paperclip 722:
 * - initial-modal-cleanup: When an agent session starts, verify that no stale
 *   modal state (checkout locks, execution locks) from a previous crashed session
 *   is still held. If found, force-clean before allowing the new session.
 * - lane-session-continuity: When an agent run starts on an issue that already
 *   has a prior run in the same lane, verify session continuity — the new run
 *   must reference the prior run's session or explicitly break continuity.
 *
 * Parent: bd78b074 (Paperclip 722 harden)
 * Program: JAC-3662
 */

import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { forbidden } from "../errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum age of a stale lock before it's considered orphaned (15 minutes) */
const STALE_LOCK_THRESHOLD_MS = 15 * 60 * 1000;

/** Maximum age of a prior run to consider for session continuity (24 hours) */
const SESSION_CONTINUITY_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InitialModalCleanupInput {
  companyId: string;
  agentId: string;
  issueId: string;
}

export interface LaneSessionContinuityInput {
  companyId: string;
  agentId: string;
  issueId: string;
  currentRunId: string;
  priorRunId?: string | null;
  breakContinuity?: boolean;
}

export interface StaleLockResult {
  hasStaleCheckout: boolean;
  hasStaleExecutionLock: boolean;
  staleCheckoutRunId: string | null;
  staleExecutionRunId: string | null;
}

export function initialModalCleanupGateService(db: Db) {
  return {
    /**
     * Check for stale modal state (checkout locks, execution locks) from a
     * previous crashed session. Returns what was found and cleaned.
     * Fail-closed: if stale locks exist and cannot be cleaned, throws forbidden.
     */
    async detectStaleLocks(input: InitialModalCleanupInput): Promise<StaleLockResult> {
      const staleThreshold = new Date(Date.now() - STALE_LOCK_THRESHOLD_MS);

      // Check for stale checkout lock
      const [staleCheckout] = await db
        .select({
          id: issues.id,
          checkoutRunId: issues.checkoutRunId,
          executionLockedAt: issues.executionLockedAt,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.id, input.issueId),
            eq(issues.companyId, input.companyId),
            isNotNull(issues.checkoutRunId),
            lt(issues.updatedAt, staleThreshold),
          ),
        )
        .limit(1);

      // Check for stale execution lock
      const [staleExecution] = await db
        .select({
          id: issues.id,
          executionRunId: issues.executionRunId,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.id, input.issueId),
            eq(issues.companyId, input.companyId),
            isNotNull(issues.executionRunId),
            isNotNull(issues.executionLockedAt),
            lt(issues.executionLockedAt, staleThreshold),
          ),
        )
        .limit(1);

      return {
        hasStaleCheckout: Boolean(staleCheckout?.checkoutRunId),
        hasStaleExecutionLock: Boolean(staleExecution?.executionRunId),
        staleCheckoutRunId: staleCheckout?.checkoutRunId ?? null,
        staleExecutionRunId: staleExecution?.executionRunId ?? null,
      };
    },

    /**
     * Force-clean stale modal state. Must be called before a new session starts
     * if detectStaleLocks found anything.
     */
    async forceCleanStaleLocks(input: InitialModalCleanupInput): Promise<void> {
      const staleThreshold = new Date(Date.now() - STALE_LOCK_THRESHOLD_MS);

      // Clear stale checkout lock
      await db
        .update(issues)
        .set({
          checkoutRunId: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(issues.id, input.issueId),
            eq(issues.companyId, input.companyId),
            isNotNull(issues.checkoutRunId),
            lt(issues.updatedAt, staleThreshold),
          ),
        );

      // Clear stale execution lock
      await db
        .update(issues)
        .set({
          executionRunId: null,
          executionLockedAt: null,
          executionAgentNameKey: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(issues.id, input.issueId),
            eq(issues.companyId, input.companyId),
            isNotNull(issues.executionRunId),
            isNotNull(issues.executionLockedAt),
            lt(issues.executionLockedAt, staleThreshold),
          ),
        );
    },

    /**
     * Full gate: detect + force-clean. Throws if cleanup fails.
     */
    async assertCleanInitialModal(input: InitialModalCleanupInput): Promise<void> {
      const locks = await this.detectStaleLocks(input);

      if (locks.hasStaleCheckout || locks.hasStaleExecutionLock) {
        await this.forceCleanStaleLocks(input);

        // Verify cleanup succeeded
        const recheck = await this.detectStaleLocks(input);
        if (recheck.hasStaleCheckout || recheck.hasStaleExecutionLock) {
          throw forbidden(
            `Failed to clean stale modal state for issue ${input.issueId}. ` +
              `Stale checkout: ${recheck.hasStaleCheckout}, stale execution: ${recheck.hasStaleExecutionLock}`,
            {
              code: "initial_modal_cleanup_failed",
              issueId: input.issueId,
              agentId: input.agentId,
            },
          );
        }
      }
    },
  };
}

export function laneSessionContinuityGateService(db: Db) {
  return {
    /**
     * Verify lane-session continuity: when an agent starts a new run on an issue
     * that already has a prior run in the same lane, the new run must either
     * reference the prior run's session or explicitly break continuity.
     *
     * Fail-closed: blocks the run if continuity is broken without explicit break.
     */
    async assertSessionContinuity(input: LaneSessionContinuityInput): Promise<void> {
      // If explicitly breaking continuity, allow it
      if (input.breakContinuity) return;

      // If a prior run is explicitly provided, verify it exists and is from the same agent
      if (input.priorRunId) {
        const [priorRun] = await db
          .select({
            id: heartbeatRuns.id,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
            createdAt: heartbeatRuns.createdAt,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, input.priorRunId),
              eq(heartbeatRuns.companyId, input.companyId),
            ),
          )
          .limit(1);

        if (!priorRun) {
          throw forbidden(
            `Prior run ${input.priorRunId} not found for session continuity check`,
            {
              code: "session_continuity_prior_run_not_found",
              priorRunId: input.priorRunId,
              issueId: input.issueId,
            },
          );
        }

        // Verify the prior run is from the same agent (same lane)
        if (priorRun.agentId !== input.agentId) {
          throw forbidden(
            `Session continuity violation: prior run ${input.priorRunId} belongs to agent ` +
              `${priorRun.agentId}, not ${input.agentId}`,
            {
              code: "session_continuity_lane_mismatch",
              priorRunId: input.priorRunId,
              priorAgentId: priorRun.agentId,
              currentAgentId: input.agentId,
            },
          );
        }

        return;
      }

      // No prior run explicitly provided — check if the issue already has an
      // active run (checkout or execution lock) from the same agent
      const [issueRow] = await db
        .select({
          id: issues.id,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.id, input.issueId),
            eq(issues.companyId, input.companyId),
          ),
        )
        .limit(1);

      if (!issueRow) {
        throw forbidden(
          `Issue ${input.issueId} not found for session continuity check`,
          {
            code: "session_continuity_issue_not_found",
            issueId: input.issueId,
          },
        );
      }

      // If the issue has a checkout or execution lock, verify it belongs to this agent
      if (issueRow.checkoutRunId || issueRow.executionRunId) {
        // Check if the lock's run belongs to this agent
        const lockRunId = issueRow.executionRunId || issueRow.checkoutRunId;
        if (lockRunId) {
          const [lockRun] = await db
            .select({
              id: heartbeatRuns.id,
              agentId: heartbeatRuns.agentId,
              status: heartbeatRuns.status,
            })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, lockRunId))
            .limit(1);

          if (lockRun && lockRun.agentId !== input.agentId) {
            throw forbidden(
              `Session continuity violation: issue ${input.issueId} is locked by agent ` +
                `${lockRun.agentId} (run ${lockRunId}, status=${lockRun.status}), ` +
                `not ${input.agentId}. Wait for it to complete or pass breakContinuity=true.`,
              {
                code: "session_continuity_issue_locked_by_other",
                issueId: input.issueId,
                lockRunId,
                lockAgentId: lockRun.agentId,
                currentAgentId: input.agentId,
              },
            );
          }
        }
      }
    },
  };
}
