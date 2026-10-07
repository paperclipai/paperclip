/** Private persisted receipt codecs. Legacy fields are read only after the
 * caller establishes an applied, company-scoped finalization; never rewritten. */
const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
export const PLAN_WAIT_RECEIPT = {
  schema: "paperclip.native_plan_wait.v1", prefix: "native-plan-wait:", legacy: false,
} as const;
const LEGACY_PLAN_WAIT_RECEIPT = {
  schema: "paperclip.native_cursor_plan_wait.v1", prefix: "cursor-plan-wait:", legacy: true,
} as const;
export type PlanWaitReceiptFormat = typeof PLAN_WAIT_RECEIPT | typeof LEGACY_PLAN_WAIT_RECEIPT;

export function readCommittedPlanWaitReceipt(value: unknown) {
  const decision = record(value);
  // Reject mixed formats rather than silently choosing an authority.
  if (decision.planWait !== undefined || decision.planWaitResult !== undefined) {
    if (decision.cursorPlanWait !== undefined || decision.cursorPlanWaitResult !== undefined
      || record(decision.planWait).schema !== PLAN_WAIT_RECEIPT.schema) return null;
    return { source: record(decision.planWait), identity: record(decision.planWaitResult), format: PLAN_WAIT_RECEIPT };
  }
  if (record(decision.cursorPlanWait).schema !== LEGACY_PLAN_WAIT_RECEIPT.schema) return null;
  return { source: record(decision.cursorPlanWait), identity: record(decision.cursorPlanWaitResult), format: LEGACY_PLAN_WAIT_RECEIPT };
}

export function isPlanWaitContinuation(value: unknown): boolean {
  return typeof value === "string" && [PLAN_WAIT_RECEIPT, LEGACY_PLAN_WAIT_RECEIPT].some(format => value.startsWith(format.prefix));
}
