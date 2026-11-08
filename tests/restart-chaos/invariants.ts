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

/**
 * Local-disk kinds (usage-receipt and orphan-cleanup spools) resolve their
 * directories from the environment when listed. Point them at the wave's
 * instance, not the operator's, for the duration of the check.
 */
async function withWaveInstance<T>(instance: { paperclipHome: string; instanceId: string }, run: () => Promise<T>): Promise<T> {
  const keys = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PAPERCLIP_HOME = instance.paperclipHome;
  process.env.PAPERCLIP_INSTANCE_ID = instance.instanceId;
  delete process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR;
  try { return await run(); } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

export async function checkPlanInvariants(input: {
  connectionString: string; companyId: string | null; paperclipHome: string; instanceId: string; now?: Date;
}): Promise<InvariantCheck> {
  const db = createDb(input.connectionString);
  const errors: string[] = [];
  try {
    const now = input.now ?? new Date();
    const pass = (state: ReturnType<typeof createOwnershipReportState>, at: Date) =>
      withWaveInstance(input, () => runOwnershipReconciliationPass(db, { state, now: at, record: false }));
    const state = createOwnershipReportState();
    await pass(state, now);
    const second = await pass(state, new Date(now.getTime() + 1_000));
    // A failed I3/I4/I7 query is only logged by the pass and sets retryNeeded.
    // Retry once; a pass that still could not finish is an incomplete check.
    let shifted = await pass(createOwnershipReportState(), new Date(now.getTime() + GRACE_SHIFT_MS));
    if (shifted.retryNeeded) shifted = await pass(createOwnershipReportState(), new Date(now.getTime() + GRACE_SHIFT_MS));
    for (const kind of [...second.kinds, ...shifted.kinds]) if (kind.error) errors.push(`${kind.kind}: ${kind.error}`);
    if (second.retryNeeded) errors.push("the I1/I2 pass did not finish (retryNeeded)");
    if (shifted.retryNeeded) errors.push("the I3/I4/I7 pass did not finish after one retry (retryNeeded)");
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
