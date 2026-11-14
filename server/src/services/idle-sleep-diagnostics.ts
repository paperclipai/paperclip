export type IdleSleepCheckState = "none" | "present" | "unknown" | "not_checked";
export type IdleSleepDiagnosticSink = (reason: string, state: IdleSleepCheckState) => void;

export interface IdleSleepDiagnostics {
  version: 1;
  complete: boolean;
  checks: { reason: string; state: IdleSleepCheckState }[];
}

export const IDLE_LOCAL_DIAGNOSTIC_REASONS = [
  "local.startup", "local.ingress_tracking", "local.automatic_backups", "local.tracked_work",
  "local.registered_probes", "local.accounting_spool", "local.orphan_spool",
  "local.registered_spools", "local.quota_recovery",
] as const;

export function createIdleSleepDiagnostics() {
  const states = new Map<string, IdleSleepCheckState>();
  const allowed = new Set<string>([
    ...IDLE_LOCAL_DIAGNOSTIC_REASONS,
    "inspection.hold", "inspection.generation", "durable.snapshot", "local.inspection",
    "plugins.runtime_drain", "routines.schedule", "issues.schedule", "backup.checkpoint",
  ]);
  const rank = { none: 0, not_checked: 1, present: 2, unknown: 3 } as const;
  const record: IdleSleepDiagnosticSink = (reason, state) => {
    if (!allowed.has(reason) || !Object.hasOwn(rank, state)) throw new Error("Invalid idle diagnostic check");
    const previous = states.get(reason);
    if (previous === undefined || rank[state] > rank[previous]) states.set(reason, state);
  };
  return {
    record,
    expect(reasons: string[]) {
      for (const reason of reasons) {
        if (allowed.has(reason)) throw new Error("Duplicate idle diagnostic reason");
        allowed.add(reason);
      }
    },
    report(): IdleSleepDiagnostics {
      return {
        version: 1,
        complete: [...states].every(([reason, state]) => reason === "backup.checkpoint"
          || (state !== "unknown" && state !== "not_checked")),
        checks: [...states].sort(([a], [b]) => a.localeCompare(b)).map(([reason, state]) => ({ reason, state })),
      };
    },
  };
}
