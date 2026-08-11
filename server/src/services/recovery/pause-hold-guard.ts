import { agents, companies, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { isAgentStatusInvokable, parseCompanyRunPauseState } from "@paperclipai/shared";
import { issueTreeControlService } from "../issue-tree-control.js";

type IssueTreeControlService = ReturnType<typeof issueTreeControlService>;

/**
 * TSMC-20760 — why paused-owner recovery was suppressed.
 * - `issue_tree_pause_hold`: an operator pause-hold gate is active on this issue tree.
 * - `company_run_pause`: the company has an active run/manual pause (the DP case).
 * - `all_lanes_paused`: every executable lane is intentionally paused, so there is
 *   no live sister to reassign to and no errored lane masking a genuine failure.
 */
export type RecoverySuppressionReason =
  | "issue_tree_pause_hold"
  | "company_run_pause"
  | "all_lanes_paused";

export type RecoverySuppressionDecision =
  | { suppressed: false; reason: null }
  | { suppressed: true; reason: RecoverySuppressionReason };

const NOT_SUPPRESSED: RecoverySuppressionDecision = { suppressed: false, reason: null };

/** Audit-outcome tag written instead of reassignment/invoke/liveness escalation. */
export const INTENTIONAL_COMPANY_PAUSE_OUTCOME = "intentional_company_pause" as const;

/** Reasons that represent an intentional company-wide pause (vs. a per-issue hold). */
export function isIntentionalCompanyPauseReason(
  reason: RecoverySuppressionReason | null,
): reason is "company_run_pause" | "all_lanes_paused" {
  return reason === "company_run_pause" || reason === "all_lanes_paused";
}

/**
 * Pure classifier for the "all executable lanes are intentionally paused"
 * condition (TSMC-20760).
 *
 * `terminated` agents are decommissioned — not lanes — so they are excluded.
 * The rule deliberately fails CLOSED toward escalation so a genuine failure is
 * never silenced:
 * - if any live lane is still invokable, the company is active → NOT suppressed
 *   (this preserves single-agent-failure detection: a lone failed agent in an
 *   otherwise-active company still escalates);
 * - if any live lane is in `error`, that failure must surface → NOT suppressed;
 * - only when every live lane is intentionally parked (`paused`/`pending_approval`)
 *   AND at least one is actually `paused` do we treat it as an intentional pause.
 */
export function isAllExecutableLanesIntentionallyPaused(
  laneStatuses: ReadonlyArray<string>,
): boolean {
  const executable = laneStatuses.filter((status) => status !== "terminated");
  if (executable.length === 0) return false;
  if (executable.some((status) => isAgentStatusInvokable(status))) return false;
  if (executable.some((status) => status === "error")) return false;
  const hasPausedLane = executable.some((status) => status === "paused");
  return (
    hasPausedLane &&
    executable.every((status) => status === "paused" || status === "pending_approval")
  );
}

/**
 * Decide whether automatic paused-owner recovery / liveness escalation should be
 * suppressed for an issue, and why. All recovery/heartbeat call sites funnel
 * through this single chokepoint, so extending it here suppresses reassignment,
 * invokes, and liveness escalation everywhere while an intentional pause is
 * active. Because it reads live state on every sweep, an explicit company or
 * agent resume restores normal guards on the very next pass (no cached state).
 */
export async function evaluateRecoverySuppression(
  db: Db,
  companyId: string,
  issueId: string,
  treeControlSvc: IssueTreeControlService = issueTreeControlService(db),
): Promise<RecoverySuppressionDecision> {
  const activePauseHold = await treeControlSvc.getActivePauseHoldGate(companyId, issueId);
  if (activePauseHold) return { suppressed: true, reason: "issue_tree_pause_hold" };

  const companyRow = await db
    .select({ runPauseState: companies.runPauseState })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (companyRow && parseCompanyRunPauseState(companyRow.runPauseState).active) {
    return { suppressed: true, reason: "company_run_pause" };
  }

  const laneRows = await db
    .select({ status: agents.status })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  if (isAllExecutableLanesIntentionallyPaused(laneRows.map((row) => row.status))) {
    return { suppressed: true, reason: "all_lanes_paused" };
  }

  return NOT_SUPPRESSED;
}

/**
 * Boolean wrapper preserved for existing callers. Now returns true for the
 * per-issue tree pause-hold gate AND for an intentional company-wide pause
 * (company run-pause or all executable lanes intentionally paused).
 */
export async function isAutomaticRecoverySuppressedByPauseHold(
  db: Db,
  companyId: string,
  issueId: string,
  treeControlSvc: IssueTreeControlService = issueTreeControlService(db),
) {
  const decision = await evaluateRecoverySuppression(db, companyId, issueId, treeControlSvc);
  return decision.suppressed;
}
