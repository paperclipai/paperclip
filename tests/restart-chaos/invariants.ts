/**
 * Plan invariants I1–I8 for one wave (durable ownership plan, "Invariants").
 *
 * Runs the Phase 1 report-only ownership reconciler against the wave's own
 * database after every task rested. Nothing is written: `record: false`.
 *
 *   I1, I2  two passes at the real clock: a record with no owner stamp (I1),
 *           or whose owner was proven gone on both passes and is still in
 *           progress (I2: "settled within one reconciler pass").
 *   I3, I4, I7  one more pass with the clock moved past every grace window
 *           (accounting closure 10 min, next action 5 min). The tasks are at
 *           rest, so anything still waiting then would wait forever.
 *   I5, I6, I8  not measurable by the reconciler yet; reported as coverage
 *           gaps with its own reasons. The chaos graders cover part of them:
 *           R3 (one Retry at most) bounds I5 and R1 (finished in budget) I8.
 */
import { createDb } from "../../packages/db/src/index.js";
import {
  createOwnershipReportState,
  runOwnershipReconciliationPass,
  type InvariantViolation,
} from "../../server/src/services/recovery/ownership-invariant-report.js";

export type PlanInvariant = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "I8";

export interface InvariantCheck {
  violations: InvariantViolation[];
  byInvariant: Partial<Record<PlanInvariant, number>>;
  inProgress: Record<string, { inProgress: number; gone: number; alive: number; unprovable: number }>;
  notMeasured: Partial<Record<PlanInvariant, string>>;
  errors: string[];
}

/** Grace windows the shifted pass must exceed (ownership-invariant-report.ts). */
export const GRACE_SHIFT_MS = 15 * 60_000;

export const invariantOf = (violation: Pick<InvariantViolation, "rule">): PlanInvariant => violation.rule.slice(0, 2) as PlanInvariant;

export function summarizeViolations(violations: readonly InvariantViolation[]): Partial<Record<PlanInvariant, number>> {
  const counts: Partial<Record<PlanInvariant, number>> = {};
  for (const violation of violations) counts[invariantOf(violation)] = (counts[invariantOf(violation)] ?? 0) + 1;
  return counts;
}

export async function checkPlanInvariants(input: { connectionString: string; companyId: string | null; now?: Date }): Promise<InvariantCheck> {
  const db = createDb(input.connectionString);
  const errors: string[] = [];
  try {
    const now = input.now ?? new Date();
    const state = createOwnershipReportState();
    await runOwnershipReconciliationPass(db, { state, now, record: false });
    const second = await runOwnershipReconciliationPass(db, { state, now: new Date(now.getTime() + 1_000), record: false });
    const shifted = await runOwnershipReconciliationPass(db, {
      state: createOwnershipReportState(), now: new Date(now.getTime() + GRACE_SHIFT_MS), record: false,
    });
    for (const kind of [...second.kinds, ...shifted.kinds]) if (kind.error) errors.push(`${kind.kind}: ${kind.error}`);
    const ownCompany = (violation: InvariantViolation) => input.companyId === null || violation.companyId === null
      || violation.companyId === input.companyId;
    const fromClock = second.violations.filter(violation => violation.rule === "I1_owned" || violation.rule === "I2_settled");
    const fromShift = shifted.violations.filter(violation => violation.rule !== "I1_owned" && violation.rule !== "I2_settled");
    const violations = [...fromClock, ...fromShift].filter(ownCompany);
    const inProgress = Object.fromEntries(second.kinds.filter(kind => kind.inProgress > 0)
      .map(kind => [kind.kind, { inProgress: kind.inProgress, ...kind.verdicts }]));
    return {
      violations, byInvariant: summarizeViolations(violations), inProgress, errors,
      notMeasured: {
        I5: second.coverageGaps.I5_work_based_budgets ?? "not measured",
        I6: second.coverageGaps.I6_generation_fencing ?? "not measured",
        I8: second.coverageGaps.I8_fast_turns ?? "not measured",
      },
    };
  } finally {
    await db.$client.end({ timeout: 5 }).catch(() => undefined);
  }
}
