/**
 * recoveryWorkflowAdapter
 *
 * Server-side adapter exposing a clean attempt/state/resolve surface for the
 * Cloudflare Workflow orchestrator (plugin-monolith-bridge).
 *
 * APPROACH: FALLBACK (not clean planAttempt split).
 *
 * escalateStrandedAssignedIssue has deeply interleaved reads + writes:
 *   - owner resolution (sequential DB queries)
 *   - upsertSourceScoped (write, with in-process mutex + retry)
 *   - issue status update (write)
 *   - comment dedup check + addComment (conditional write)
 *   - logActivity (write)
 *   - enqueueWakeup (write)
 *   - optional re-block if owner === original assignee (write)
 *
 * Extracting a pure planAttempt without changing any write behaviour would
 * require re-threading all these reads/writes through a plan object and
 * duplicating all the business logic. The risk of subtle divergence is high
 * and the existing recovery tests (Task 4) would catch any breakage.
 *
 * Instead:
 *   - dry mode  → read-only: calls getActiveForIssue, returns current state
 *                 with NO writes. The "plan" is what the action already shows.
 *   - active mode → fetches issue + latestRun, then calls
 *                 escalateStrandedAssignedIssue unchanged (behavior-identical),
 *                 then reads back the updated action for the response.
 *
 * Idempotency on attemptNumber: if the action's current attemptCount is already
 * >= the requested attemptNumber, we skip re-escalating (the attempt was already
 * executed). This is a best-effort backstop; see the performAttempt JSDoc for
 * the single-active-executor contract that actually prevents concurrent attempts.
 *
 * nextIntervalMs = heartbeatIntervalMs supplied by caller (from server config).
 *
 * Design note: all DB-touching helpers (fetchIssue, fetchLatestRun) are injected
 * via deps so that tests can mock them without needing drizzle-orm in the test
 * environment.
 *
 * Wiring for production callers:
 *   import { and, desc, eq, sql } from "drizzle-orm";
 *   import { heartbeatRuns, issues } from "@paperclipai/db";
 *   import { recoveryService } from "./recovery/service.js";
 *   import { issueRecoveryActionService } from "./issue-recovery-actions.js";
 *   import { recoveryWorkflowAdapter } from "./recovery-workflow-adapter.js";
 *
 *   const recoverySvc = recoveryService(db, { enqueueWakeup });
 *   const recoveryActionsSvc = issueRecoveryActionService(db);
 *   const adapter = recoveryWorkflowAdapter({
 *     escalateStrandedAssignedIssue: recoverySvc.escalateStrandedAssignedIssue,
 *     getActiveForIssue: recoveryActionsSvc.getActiveForIssue,
 *     resolveActiveForIssue: recoveryActionsSvc.resolveActiveForIssue,
 *     fetchIssue: (companyId, issueId) =>
 *       db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).limit(1)
 *         .then(rows => rows[0] ?? null),
 *     fetchLatestRun: (companyId, issueId) =>
 *       db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
 *                   error: heartbeatRuns.error, errorCode: heartbeatRuns.errorCode,
 *                   contextSnapshot: heartbeatRuns.contextSnapshot, livenessState: heartbeatRuns.livenessState })
 *         .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
 *           sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`))
 *         .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1)
 *         .then(rows => rows[0] ?? null),
 *     heartbeatIntervalMs: config.heartbeatSchedulerIntervalMs,
 *   });
 */

import type { IssueRecoveryAction, IssueRecoveryActionOutcome } from "@paperclipai/shared";
import type { ResolveIssueRecoveryActionInput } from "./issue-recovery-actions.js";

// ---------------------------------------------------------------------------
// Deps interface — injected so callers (and tests) can supply mocks
// ---------------------------------------------------------------------------

/**
 * Minimal shape of an issue row needed for escalation.
 * Matches typeof issues.$inferSelect from @paperclipai/db.
 */
export type IssueRow = {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  identifier?: string | null;
  [key: string]: unknown;
};

/**
 * Minimal shape of a heartbeat run row needed for escalation.
 */
export type LatestRunRow = {
  id: string;
  agentId: string;
  status: string;
  [key: string]: unknown;
} | null;

/**
 * Recovery cause passed through to escalateStrandedAssignedIssue. Mirrors the
 * service's StrandedRecoveryCause union (not exported from service.ts). Affects
 * which recovery-action kind is written, so callers must supply the same value
 * the production loop would. Default loop callers omit it (service defaults to
 * "stranded_assigned_issue"), so leaving this undefined is behavior-identical.
 */
export type RecoveryCause = "stranded_assigned_issue" | "successful_run_missing_state";

export type RecoveryWorkflowAdapterDeps = {
  /**
   * escalateStrandedAssignedIssue from recoveryService(db, deps)
   * (exported on the recoveryService return value).
   */
  escalateStrandedAssignedIssue: (input: {
    issue: IssueRow;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestRunRow;
    recoveryCause?: RecoveryCause;
  }) => Promise<unknown>;

  /** getActiveForIssue from issueRecoveryActionService(db) */
  getActiveForIssue: (companyId: string, sourceIssueId: string) => Promise<IssueRecoveryAction | null>;

  /** resolveActiveForIssue from issueRecoveryActionService(db) */
  resolveActiveForIssue: (input: ResolveIssueRecoveryActionInput) => Promise<IssueRecoveryAction | null>;

  /**
   * Fetch the issue row by (companyId, issueId).
   * Injected so the adapter itself has no drizzle-orm import.
   */
  fetchIssue: (companyId: string, issueId: string) => Promise<IssueRow | null>;

  /**
   * Fetch the latest heartbeat run for (companyId, issueId).
   * Injected so the adapter itself has no drizzle-orm import.
   */
  fetchLatestRun: (companyId: string, issueId: string) => Promise<LatestRunRow>;

  /** heartbeatSchedulerIntervalMs from server config */
  heartbeatIntervalMs: number;

  /**
   * Recovery cause threaded through to escalateStrandedAssignedIssue in active
   * mode. Omit (undefined) to match the default production loop, which lets the
   * service apply its own default ("stranded_assigned_issue").
   */
  recoveryCause?: RecoveryCause;
};

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export type RecoveryActionState = {
  active: boolean;
  status: string;
  attemptCount: number;
};

export type PerformAttemptResult = RecoveryActionState & {
  nextIntervalMs: number;
};

export type PerformAttemptInput = {
  companyId: string;
  actionId: string;
  sourceIssueId: string;
  attemptNumber: number;
  mode: "dry" | "active";
};

export type ResolveInput = {
  companyId: string;
  sourceIssueId: string;
  actionId?: string | null;
  status: Extract<IssueRecoveryAction["status"], "resolved" | "cancelled">;
  outcome: IssueRecoveryActionOutcome;
  resolutionNote?: string | null;
};

export type EscalateInput = {
  companyId: string;
  sourceIssueId: string;
  actionId?: string | null;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function recoveryWorkflowAdapter(deps: RecoveryWorkflowAdapterDeps) {
  const {
    escalateStrandedAssignedIssue,
    getActiveForIssue,
    resolveActiveForIssue,
    fetchIssue,
    fetchLatestRun,
    heartbeatIntervalMs,
    recoveryCause,
  } = deps;

  // ---- Internal helpers ----------------------------------------------------

  function toState(action: IssueRecoveryAction): RecoveryActionState {
    return {
      active: action.status === "active" || action.status === "escalated",
      status: action.status,
      attemptCount: action.attemptCount,
    };
  }

  // ---- getState ------------------------------------------------------------

  /**
   * Returns the current state of the active recovery action for the given
   * source issue, or null if none exists.
   */
  async function getState(companyId: string, sourceIssueId: string): Promise<RecoveryActionState | null> {
    const action = await getActiveForIssue(companyId, sourceIssueId);
    if (!action) return null;
    return toState(action);
  }

  // ---- performAttempt ------------------------------------------------------

  /**
   * Run (active) or preview (dry) a single recovery attempt.
   *
   * CONCURRENCY CONTRACT (architectural mitigation for TOCTOU):
   * Callers MUST ensure only one active execution calls
   * performAttempt(mode:'active') per sourceIssueId at a time. This holds in
   * production because there is exactly one Workflow instance per recovery
   * action (instance_id = actionId) whose steps run sequentially, and authority
   * mode makes the server poll loop skip flagged companies — so no concurrent
   * active attempts occur for a given action. Under that contract the
   * read-then-write here is safe.
   *
   * The attemptCount >= attemptNumber check below is a best-effort soft-guard
   * (idempotency backstop for retries of the SAME attemptNumber); it is NOT a
   * substitute for the single-executor contract above.
   */
  async function performAttempt(input: PerformAttemptInput): Promise<PerformAttemptResult> {
    const { companyId, sourceIssueId, attemptNumber, mode } = input;

    // ----- dry-run: read-only, no writes ------------------------------------
    if (mode === "dry") {
      const action = await getActiveForIssue(companyId, sourceIssueId);
      if (!action) {
        // Unified "no active action" sentinel — same value as the active
        // no-action path so callers see one consistent status. active=false.
        return {
          active: false,
          status: "not_found",
          attemptCount: 0,
          nextIntervalMs: heartbeatIntervalMs,
        };
      }
      return {
        ...toState(action),
        nextIntervalMs: heartbeatIntervalMs,
      };
    }

    // ----- active mode ------------------------------------------------------

    // Idempotency: if the action's attemptCount is already >= the requested
    // attemptNumber, the attempt was already executed — return current state.
    const existing = await getActiveForIssue(companyId, sourceIssueId);
    if (existing && existing.attemptCount >= attemptNumber) {
      return {
        ...toState(existing),
        nextIntervalMs: heartbeatIntervalMs,
      };
    }

    // Fetch issue and latest run for escalateStrandedAssignedIssue.
    const issue = await fetchIssue(companyId, sourceIssueId);
    if (!issue) {
      return {
        active: false,
        status: "not_found",
        attemptCount: existing?.attemptCount ?? 0,
        nextIntervalMs: heartbeatIntervalMs,
      };
    }

    const latestRun = await fetchLatestRun(companyId, sourceIssueId);
    const previousStatus = (issue.status === "in_progress" ? "in_progress" : "todo") as
      | "todo"
      | "in_progress";

    // Call the existing escalation path unchanged (behavior-identical).
    // recoveryCause is passed through so the written recovery-action kind matches
    // the production loop; when undefined the service applies its own default.
    await escalateStrandedAssignedIssue({
      issue,
      previousStatus,
      latestRun,
      recoveryCause,
    });

    // Read back the updated action to get the current attemptCount.
    const updated = await getActiveForIssue(companyId, sourceIssueId);
    if (!updated) {
      // Escalation resolved the action (e.g. stranded recovery issue path).
      return {
        active: false,
        status: "resolved",
        attemptCount: existing?.attemptCount ?? 1,
        nextIntervalMs: heartbeatIntervalMs,
      };
    }

    return {
      ...toState(updated),
      nextIntervalMs: heartbeatIntervalMs,
    };
  }

  // ---- resolve / escalate thin wrappers ------------------------------------

  async function resolve(input: ResolveInput): Promise<IssueRecoveryAction | null> {
    return resolveActiveForIssue(input);
  }

  async function escalate(input: EscalateInput): Promise<IssueRecoveryAction | null> {
    return resolveActiveForIssue({
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId,
      actionId: input.actionId,
      status: "cancelled",
      outcome: "escalated",
    });
  }

  return {
    getState,
    performAttempt,
    resolve,
    escalate,
  };
}
