// LET-514 — Truthful Slack onboarding connection state.
//
// Derives the per-company Slack onboarding connection state from the existing
// `capability_apply_plans` / `capability_apply_steps` lifecycle. No new table,
// no migration: state is a projection of the canonical capability-apply
// pipeline filtered to the verified Slack catalog id.
//
// State mapping (driven by `CapabilityApplyPlanState`):
//   - no matching plan                                         → not_connected
//   - pending | approval_requested                             → pending_approval
//   - approved | executing                                     → applying
//   - applied                                                  → connected
//   - partially_applied                                        → partial
//   - cancelled | declined | expired                           → error
//
// The UI MUST render only these five states verbatim. Nothing here ever fabricates
// a "connected" reading from anything weaker than a real applied plan.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { capabilityApplyPlans, capabilityApplySteps } from "@paperclipai/db";
import { SLACK_VERIFIED_CATALOG_ID } from "./slack-install-preview.js";

export const SLACK_CONNECTION_STATES = [
  "not_connected",
  "pending_approval",
  "applying",
  "connected",
  "partial",
  "error",
] as const;

export type SlackConnectionState = (typeof SLACK_CONNECTION_STATES)[number];

export interface SlackConnectionStateRow {
  readonly state: SlackConnectionState;
  readonly planId: string | null;
  readonly approvalId: string | null;
  readonly lastUpdatedAt: string | null;
  readonly underlyingPlanState: string | null;
}

type PlanStateValue =
  | "pending"
  | "approval_requested"
  | "approved"
  | "executing"
  | "applied"
  | "partially_applied"
  | "cancelled"
  | "declined"
  | "expired";

function mapPlanStateToConnectionState(planState: PlanStateValue): SlackConnectionState {
  switch (planState) {
    case "pending":
    case "approval_requested":
      return "pending_approval";
    case "approved":
    case "executing":
      return "applying";
    case "applied":
      return "connected";
    case "partially_applied":
      return "partial";
    case "cancelled":
    case "declined":
    case "expired":
      return "error";
  }
}

/**
 * Resolve the truthful Slack onboarding connection state for a company.
 *
 * Joins `capability_apply_plans` ← `capability_apply_steps`, filters on the
 * verified Slack catalog id at the JSONB target ref, and reduces to the
 * most-recently-updated matching plan. Returns `not_connected` when no plan
 * has ever been requested for this company.
 *
 * Safety:
 *   - Read-only. No DB writes.
 *   - The query never reads or returns secret values — it only reads plan
 *     state + identifiers + timestamps. The named-secret references live
 *     on the steps row and are exposed by the separate preview endpoint.
 */
export async function resolveSlackConnectionState(
  db: Db,
  companyId: string,
): Promise<SlackConnectionStateRow> {
  const rows = await db
    .select({
      planId: capabilityApplyPlans.id,
      planState: capabilityApplyPlans.state,
      approvalId: capabilityApplyPlans.approvalId,
      updatedAt: capabilityApplyPlans.updatedAt,
    })
    .from(capabilityApplyPlans)
    .innerJoin(
      capabilityApplySteps,
      eq(capabilityApplySteps.planId, capabilityApplyPlans.id),
    )
    .where(
      and(
        eq(capabilityApplyPlans.companyId, companyId),
        sql`${capabilityApplySteps.targetRefJson}->>'catalogId' = ${SLACK_VERIFIED_CATALOG_ID}`,
      ),
    )
    .orderBy(desc(capabilityApplyPlans.updatedAt))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return {
      state: "not_connected",
      planId: null,
      approvalId: null,
      lastUpdatedAt: null,
      underlyingPlanState: null,
    };
  }

  const planState = row.planState as PlanStateValue;
  return {
    state: mapPlanStateToConnectionState(planState),
    planId: row.planId,
    approvalId: row.approvalId ?? null,
    lastUpdatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    underlyingPlanState: planState,
  };
}
