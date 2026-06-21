/**
 * recovery-workflow-shadow
 *
 * Shadow-mode decision recorder and diff harness for the recovery Workflow.
 *
 * FIDELITY CONSTRAINT (architectural):
 * In SHADOW mode the workflow calls the attempt endpoint with mode="dry".
 * Per Task 2, dry-run is READ-ONLY: it returns the current action state
 * { active, status, attemptCount, nextIntervalMs } — it does NOT simulate the
 * forward-looking owner/wake decision. Therefore:
 *
 *   - recordShadowDecision persists only LIFECYCLE/CADENCE signals:
 *       { active, status, attemptCount }
 *   - diffShadow compares ONLY these signals against the live poll loop's
 *     actual driven state.
 *   - Owner/wake decisions (which agent/user would be woken, which wakePolicy
 *     would fire) are NOT recorded and NOT compared. This limitation is
 *     documented in every DiffResult via the `fidelityNote` field.
 *
 * Storage: `shadow_decisions` jsonb column on `recovery_workflow_links`
 * (Task 1 table). No new table is created.
 *
 * Design: all DB operations are injected via the `db` parameter (Db type from
 * @paperclipai/db). The service imports drizzle-orm at runtime; production
 * callers supply the real Db instance. Tests mock the module so drizzle-orm
 * is never actually resolved.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { recoveryWorkflowLinks } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle/cadence signals the workflow can observe from a dry-run. */
export type ObservedState = {
  active: boolean;
  status: string;
  attemptCount: number;
};

/** One recorded shadow decision persisted in the jsonb column. */
export type ShadowDecision = {
  attemptNumber: number;
  observed: ObservedState;
  /** Injected by caller for deterministic tests — do NOT call Date.now() here. */
  recordedAtMs: number;
};

/** A single agreement between workflow-observed and live state. */
export type ShadowAgreement = {
  attemptNumber: number;
  field: string;
  value: unknown;
};

/** A single mismatch between workflow-observed and live state. */
export type ShadowMismatch = {
  attemptNumber: number;
  field: string;
  observed: unknown;
  live: unknown;
};

export type DiffResult = {
  actionId: string;
  agreements: ShadowAgreement[];
  mismatches: ShadowMismatch[];
  summary: string;
  /**
   * Documents the fidelity limit: dry-run is READ-ONLY and does NOT simulate
   * the forward-looking owner/wake decision. Owner/wake decisions are NOT
   * compared in this diff — only active, status, and attemptCount signals are.
   */
  fidelityNote: string;
};

// Tolerance for attemptCount divergence (workflow may have snapshotted earlier).
const ATTEMPT_COUNT_TOLERANCE = 1;

const FIDELITY_NOTE =
  "FIDELITY LIMIT: dry-run (mode=dry) is read-only and does NOT simulate the " +
  "forward-looking owner/wake decision. This diff compares only LIFECYCLE/CADENCE " +
  "signals (active, status, attemptCount). Owner and wake decisions are not " +
  "recorded here and cannot be compared.";

// ---------------------------------------------------------------------------
// recordShadowDecision
// ---------------------------------------------------------------------------

export type RecordShadowDecisionInput = {
  actionId: string;
  attemptNumber: number;
  observed: ObservedState;
  /** Pass Date.now() from the caller for testability. Never call Date.now() here. */
  recordedAtMs: number;
};

/**
 * Append a shadow decision to the link row's shadow_decisions array.
 *
 * Best-effort: if the link row is missing (no-op) the function returns silently.
 * Callers in the dry attempt path should wrap this in try/catch so a recording
 * failure does NOT break the attempt response.
 */
export async function recordShadowDecision(
  db: Db,
  input: RecordShadowDecisionInput,
): Promise<void> {
  const { actionId, attemptNumber, observed, recordedAtMs } = input;

  // Fetch the link row
  const rows = await db
    .select()
    .from(recoveryWorkflowLinks)
    .where(eq(recoveryWorkflowLinks.actionId, actionId));

  const linkRow = rows[0];
  if (!linkRow) {
    // No link row — workflow was not tracked. No-op.
    return;
  }

  const existing: ShadowDecision[] = Array.isArray(linkRow.shadowDecisions)
    ? (linkRow.shadowDecisions as ShadowDecision[])
    : [];

  const newDecision: ShadowDecision = { attemptNumber, observed, recordedAtMs };

  // Non-transactional read-modify-write append: two concurrent dry-run attempts
  // on the same actionId could both read `existing` and one overwrite the other,
  // dropping a decision. Acceptable for best-effort shadow recording (one Workflow
  // instance per action runs attempts sequentially, so this is rare in practice).
  await db
    .update(recoveryWorkflowLinks)
    .set({
      shadowDecisions: [...existing, newDecision],
      updatedAt: new Date(),
    })
    .where(eq(recoveryWorkflowLinks.actionId, actionId));
}

// ---------------------------------------------------------------------------
// diffShadow
// ---------------------------------------------------------------------------

export type DiffShadowInput = {
  actionId: string;
  /** The live action's actual current state from the live poll loop. */
  liveActual: ObservedState;
};

/**
 * Compare recorded shadow decisions against the live action state.
 *
 * Returns a structured result with agreements, mismatches, and the fidelity
 * note documenting that owner/wake decisions are not compared.
 *
 * "Agreement" = the workflow's observed lifecycle signal is consistent with
 *   the live record (both show same active flag, status, attemptCount within
 *   tolerance).
 * "Mismatch" = e.g. workflow observed resolved but live still active, or
 *   attemptCount diverged beyond ATTEMPT_COUNT_TOLERANCE.
 */
export async function diffShadow(
  db: Db,
  input: DiffShadowInput,
): Promise<DiffResult> {
  const { actionId, liveActual } = input;

  const rows = await db
    .select()
    .from(recoveryWorkflowLinks)
    .where(eq(recoveryWorkflowLinks.actionId, actionId));

  const linkRow = rows[0];
  const decisions: ShadowDecision[] = linkRow && Array.isArray(linkRow.shadowDecisions)
    ? (linkRow.shadowDecisions as ShadowDecision[])
    : [];

  const agreements: ShadowAgreement[] = [];
  const mismatches: ShadowMismatch[] = [];

  for (const decision of decisions) {
    const { attemptNumber, observed } = decision;

    // Compare `active` flag
    if (observed.active === liveActual.active) {
      agreements.push({ attemptNumber, field: "active", value: observed.active });
    } else {
      mismatches.push({
        attemptNumber,
        field: "active",
        observed: observed.active,
        live: liveActual.active,
      });
    }

    // Compare `status`
    if (observed.status === liveActual.status) {
      agreements.push({ attemptNumber, field: "status", value: observed.status });
    } else {
      mismatches.push({
        attemptNumber,
        field: "status",
        observed: observed.status,
        live: liveActual.status,
      });
    }

    // Compare `attemptCount` with tolerance
    const countDiff = Math.abs(observed.attemptCount - liveActual.attemptCount);
    if (countDiff <= ATTEMPT_COUNT_TOLERANCE) {
      agreements.push({ attemptNumber, field: "attemptCount", value: observed.attemptCount });
    } else {
      mismatches.push({
        attemptNumber,
        field: "attemptCount",
        observed: observed.attemptCount,
        live: liveActual.attemptCount,
      });
    }
  }

  const mismatchCount = mismatches.length;
  const agreementCount = agreements.length;
  const total = mismatchCount + agreementCount;
  const summary =
    total === 0
      ? "No shadow decisions recorded — nothing to compare."
      : mismatchCount === 0
        ? `All ${agreementCount} signal(s) in agreement. No mismatches.`
        : `${mismatchCount} mismatch(es) and ${agreementCount} agreement(s) out of ${total} signal(s).`;

  return {
    actionId,
    agreements,
    mismatches,
    summary,
    fidelityNote: FIDELITY_NOTE,
  };
}
