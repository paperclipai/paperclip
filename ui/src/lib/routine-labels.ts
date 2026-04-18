const ROUTINE_RUN_STATUS_LABELS: Record<string, string> = {
  coalesced: "Added to Active Run",
};

const ROUTINE_LAST_RESULT_LABELS: Record<string, string> = {
  "Coalesced into an existing live execution issue": "Added to active run",
};

export const ROUTINE_CONCURRENCY_POLICY_LABELS: Record<string, string> = {
  coalesce_if_active: "Reuse Active Run",
  always_enqueue: "Always Create New Issue",
  skip_if_active: "Skip While Active",
};

export const ROUTINE_CONCURRENCY_POLICY_DESCRIPTIONS: Record<string, string> = {
  coalesce_if_active: "If a run is already in progress, add this trigger to the existing run instead of creating a new issue.",
  always_enqueue: "Always create a new issue, even if another run is already in progress.",
  skip_if_active: "If a run is already in progress, ignore new triggers until it finishes.",
};

function humanizeLabel(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatRoutineRunStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  return ROUTINE_RUN_STATUS_LABELS[status] ?? humanizeLabel(status);
}

export function formatRoutineLastResultLabel(result: string | null | undefined): string | null {
  if (!result) return null;
  return ROUTINE_LAST_RESULT_LABELS[result] ?? result;
}

export function formatRoutineConcurrencyPolicyLabel(policy: string): string {
  return ROUTINE_CONCURRENCY_POLICY_LABELS[policy] ?? humanizeLabel(policy);
}
