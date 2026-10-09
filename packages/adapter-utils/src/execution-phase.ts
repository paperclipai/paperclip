/** Content-free, in-memory diagnostic scopes. These never establish stop proof. */
export const ADAPTER_EXECUTION_PHASES = [
  "host_execution", "adapter_execution", "end_session", "cancel_turn", "close_session",
  "settle_reuse", "stop_transport", "sync_back", "instruction_collection",
  "workspace_restore", "phase_reporting", "instruction_cleanup", "lease_release",
] as const;

export type AdapterExecutionPhase = (typeof ADAPTER_EXECUTION_PHASES)[number];
export type AdapterExecutionPhaseSink = (phase: AdapterExecutionPhase) => (() => void) | void;

export function isAdapterExecutionPhase(value: unknown): value is AdapterExecutionPhase {
  return ADAPTER_EXECUTION_PHASES.some((phase) => phase === value);
}

/** A broken diagnostic sink must not change execution or teardown outcomes. */
export async function withAdapterExecutionPhase<T>(
  context: { onExecutionPhase?: AdapterExecutionPhaseSink },
  phase: AdapterExecutionPhase,
  operation: () => T | Promise<T>,
): Promise<T> {
  let release: (() => void) | void = undefined;
  try { release = context.onExecutionPhase?.(phase); } catch { /* diagnostics only */ }
  try {
    return await operation();
  } finally {
    try { release?.(); } catch { /* diagnostics only */ }
  }
}
