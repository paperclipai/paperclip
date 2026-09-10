import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  deliveryRepairAttempts,
  deliveryUnitIssues,
  deliveryUnits,
  issues,
} from "@paperclipai/db";

/**
 * Authoritative, still-executable delivery repair intent for a queued run.
 *
 * A continuation summary is prose saved by an earlier run. It must never
 * outrank a repair the controller itself issued for the CURRENT durable state:
 * otherwise a process loss re-derives a generic continuation, the stale summary
 * parks that continuation as `issue_continuation_waiting_on_review`, and the
 * bounded repair budget stays spent on a wake no run will ever consume — the
 * issue waits forever on a repair nobody is running.
 *
 * The intent is validated against durable rows, never against flags a wake
 * happens to carry. A still-live unit linked to this issue and owned by this
 * run's agent must have an actionable persisted repair attempt whose own
 * candidate generation and head are still the current ones: ids and heads alone
 * cannot tell a repair requested for revision A from one requested after
 * A -> B -> A replaced the candidate in between, and an old attempt row must not
 * satisfy a newer intent.
 *
 * When the wake also declares `contextSnapshot.deliveryRepair`, that carrier is
 * authoritative about which attempt is meant: the unit, generation, head, reason
 * and attempt must all match the persisted rows exactly, and a carrier that is
 * present but malformed or no longer current rejects the intent outright rather
 * than silently degrading to the row-derived path.
 *
 * Anything else — a moved head, a new generation, a reassignment, a resolved or
 * exhausted attempt, a terminal or paused unit — returns null, and normal
 * parking applies.
 */

const ACTIONABLE_DELIVERY_REPAIR_ATTEMPT_STATUSES = ["requested", "dispatched"] as const;
const LIVE_DELIVERY_UNIT_STATUSES = [
  "submitted",
  "in_review",
  "ready_to_merge",
  "merging",
  "blocked",
] as const;
const FULL_HEAD_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export type DeliveryRepairIntent = {
  kind: "delivery_repair";
  unitId: string;
  candidateGeneration: number;
  headSha: string;
  reasonCode: string;
  attempt: number;
  /** The wake declared this intent (fully generation- and head-fenced against
   * the persisted attempt), rather than it being derived from rows alone. */
  declared: boolean;
};

type RepairIntentIssue = Pick<
  typeof issues.$inferSelect,
  | "id"
  | "companyId"
  | "status"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "executionPolicy"
  | "executionState"
  | "monitorNextCheckAt"
>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveInteger(value: unknown): number | null {
  const numeric =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The declared cross-slice carrier: `contextSnapshot.deliveryRepair`. */
export type DeliveryRepairContext = {
  unitId: string;
  candidateGeneration: number;
  headSha: string;
  reasonCode: string;
  attempt: number;
};

export function readDeliveryRepairContext(
  context: Record<string, unknown>,
): DeliveryRepairContext | null {
  const repair = readRecord(context.deliveryRepair);
  if (!repair) return null;
  const unitId = readNonEmptyString(repair.unitId);
  const reasonCode = readNonEmptyString(repair.reasonCode);
  const headSha = readNonEmptyString(repair.headSha);
  const attempt = readPositiveInteger(repair.attempt);
  const candidateGeneration = readPositiveInteger(repair.candidateGeneration);
  if (!unitId || !reasonCode || !headSha || !attempt || !candidateGeneration) return null;
  if (!FULL_HEAD_SHA.test(headSha)) return null;
  return {
    unitId,
    candidateGeneration,
    headSha: headSha.toLowerCase(),
    reasonCode,
    attempt,
  };
}

type LiveDeliveryUnit = {
  id: string;
  headSha: string | null;
  candidateGeneration: number;
};

/** Units still able to be repaired: linked to this issue, non-terminal, not
 * paused, and either unowned or owned by this run's agent. */
async function listLiveRepairableUnits(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string },
): Promise<LiveDeliveryUnit[]> {
  return await db
    .select({
      id: deliveryUnits.id,
      headSha: deliveryUnits.headSha,
      candidateGeneration: deliveryUnits.candidateGeneration,
    })
    .from(deliveryUnitIssues)
    .innerJoin(
      deliveryUnits,
      and(
        eq(deliveryUnits.companyId, deliveryUnitIssues.companyId),
        eq(deliveryUnits.id, deliveryUnitIssues.unitId),
      ),
    )
    .where(
      and(
        eq(deliveryUnitIssues.companyId, input.companyId),
        eq(deliveryUnitIssues.issueId, input.issueId),
        or(
          isNull(deliveryUnits.ownerAgentId),
          eq(deliveryUnits.ownerAgentId, input.agentId),
        ),
        isNull(deliveryUnits.pausedAt),
        inArray(deliveryUnits.status, [...LIVE_DELIVERY_UNIT_STATUSES]),
      ),
    );
}

export async function readDeliveryRepairIntent(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    issue: RepairIntentIssue;
    context: Record<string, unknown>;
  },
): Promise<DeliveryRepairIntent | null> {
  // Ownership and status are re-read here rather than trusted from the wake: a
  // reassignment or a terminal issue invalidates the old repair.
  if (input.issue.assigneeAgentId !== input.agentId) return null;
  if (input.issue.status === "done" || input.issue.status === "cancelled") return null;

  const hasCarrier = input.context.deliveryRepair !== null && input.context.deliveryRepair !== undefined;
  const declared = readDeliveryRepairContext(input.context);
  // A present-but-unusable carrier is a rejected intent, not an absent one: the
  // wake named a specific repair this run must not silently reinterpret.
  if (hasCarrier && !declared) return null;

  const units = await listLiveRepairableUnits(db, {
    companyId: input.companyId,
    issueId: input.issueId,
    agentId: input.agentId,
  });

  for (const unit of units) {
    if (declared) {
      if (unit.id !== declared.unitId) continue;
      if (unit.candidateGeneration !== declared.candidateGeneration) continue;
      if (!unit.headSha || unit.headSha.toLowerCase() !== declared.headSha) continue;
      // The attempt row itself is fenced on generation and head: matching the
      // unit alone would let an attempt dispatched for an older generation of
      // the same head satisfy the intent.
      const attemptRow = await db
        .select({ id: deliveryRepairAttempts.id })
        .from(deliveryRepairAttempts)
        .where(
          and(
            eq(deliveryRepairAttempts.companyId, input.companyId),
            eq(deliveryRepairAttempts.unitId, unit.id),
            eq(deliveryRepairAttempts.reasonCode, declared.reasonCode),
            eq(deliveryRepairAttempts.attempt, declared.attempt),
            eq(deliveryRepairAttempts.candidateGeneration, declared.candidateGeneration),
            eq(deliveryRepairAttempts.headSha, declared.headSha),
            inArray(deliveryRepairAttempts.status, [
              ...ACTIONABLE_DELIVERY_REPAIR_ATTEMPT_STATUSES,
            ]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!attemptRow) continue;
      return { ...declared, kind: "delivery_repair", declared: true };
    }

    // No declared intent: the wake lost it (process loss resumed the work
    // through a generic continuation). A repair attempt still actionable for the
    // unit's CURRENT generation and head is the durable intent; an attempt for
    // an earlier revision means the repair it asked for is already superseded.
    if (!unit.headSha) continue;
    const attempt = await db
      .select({
        reasonCode: deliveryRepairAttempts.reasonCode,
        attempt: deliveryRepairAttempts.attempt,
      })
      .from(deliveryRepairAttempts)
      .where(
        and(
          eq(deliveryRepairAttempts.companyId, input.companyId),
          eq(deliveryRepairAttempts.unitId, unit.id),
          eq(deliveryRepairAttempts.candidateGeneration, unit.candidateGeneration),
          eq(deliveryRepairAttempts.headSha, unit.headSha),
          inArray(deliveryRepairAttempts.status, [
            ...ACTIONABLE_DELIVERY_REPAIR_ATTEMPT_STATUSES,
          ]),
        ),
      )
      .orderBy(desc(deliveryRepairAttempts.attempt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!attempt) continue;
    return {
      kind: "delivery_repair",
      unitId: unit.id,
      candidateGeneration: unit.candidateGeneration,
      headSha: unit.headSha.toLowerCase(),
      reasonCode: attempt.reasonCode,
      attempt: attempt.attempt,
      declared: false,
    };
  }
  return null;
}

/** The executable repair intent that owns this queued run's work, if any. */
export async function readExecutableRepairIntent(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    issue: RepairIntentIssue;
    context: Record<string, unknown>;
  },
): Promise<DeliveryRepairIntent | null> {
  return await readDeliveryRepairIntent(db, input);
}
