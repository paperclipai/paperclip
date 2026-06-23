import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issues, planDetails } from "@paperclipai/db";
import { GATE_APPROVAL_TYPES } from "@paperclipai/shared";
import { GATE_REVIEW_WAKE_REASONS } from "./plan-gates.js";
import { logger } from "../middleware/logger.js";

// Additional wake reasons produced by the approval approval handlers — these are
// responses TO a gate, not new implementor work, so they must never be blocked.
const ALLOWED_WAKE_REASONS: ReadonlySet<string | null> = new Set([
  ...GATE_REVIEW_WAKE_REASONS,
  "approval_approved",
  "plan_review_gate_decided",
]);

// Returns true when the wake for agentId on issueId should be suppressed because:
//  • the issue is under a strict plan
//  • the plan's gate_plan_approval is not yet approved
//
// Always fails-open on error (logs + returns false) so a DB hiccup never
// deadlocks an agent.
export async function isWakeBlockedByStrictGate(
  db: Db,
  companyId: string,
  issueId: string | null | undefined,
  reason: string | null | undefined,
): Promise<boolean> {
  if (!issueId) return false;
  // Gate review wakes and approval-response wakes always bypass: they ARE the
  // gate protocol, never the implementors the gate is meant to hold.
  if (reason != null && ALLOWED_WAKE_REASONS.has(reason)) return false;

  try {
    // Resolve the plan root: either the issue is itself the root (plan-root
    // issues have planRootIssueId = null and a plan_details row), or it is a
    // leaf with planRootIssueId set.
    const issueRow = await db
      .select({
        planRootIssueId: issues.planRootIssueId,
        workMode: issues.workMode,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!issueRow) return false;

    const planRootId =
      issueRow.planRootIssueId ??
      (issueRow.workMode === "planning" ? issueId : null);

    if (!planRootId) return false;

    const plan = await db
      .select({ gateEnforcement: planDetails.gateEnforcement })
      .from(planDetails)
      .where(eq(planDetails.issueId, planRootId))
      .then((rows) => rows[0] ?? null);

    if (!plan || plan.gateEnforcement !== "strict") return false;

    // Check whether plan-approval is already approved for this plan root.
    const approved = await db
      .select({ id: approvals.id })
      .from(approvals)
      .innerJoin(issueApprovals, eq(issueApprovals.approvalId, approvals.id))
      .where(
        and(
          eq(issueApprovals.issueId, planRootId),
          eq(approvals.companyId, companyId),
          eq(approvals.type, GATE_APPROVAL_TYPES.planApproval),
          eq(approvals.status, "approved"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    return approved === null; // null = not approved → block
  } catch (err) {
    logger.warn(
      { err, companyId, issueId },
      "isWakeBlockedByStrictGate query failed — failing open",
    );
    return false;
  }
}
