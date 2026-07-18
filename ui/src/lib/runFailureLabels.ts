export const RESTART_INDUCED_SUPERVISOR_LOSS = "restart_induced_process_supervisor_loss";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveRunFailureCode(run: {
  errorCode?: string | null;
  resultJson?: unknown;
}): string {
  const result = asRecord(run.resultJson);
  const stopReasonDetail = readString(result?.stopReasonDetail);
  if (run.errorCode === "process_lost" && stopReasonDetail === RESTART_INDUCED_SUPERVISOR_LOSS) {
    return RESTART_INDUCED_SUPERVISOR_LOSS;
  }
  return run.errorCode && run.errorCode.length > 0 ? run.errorCode : "unknown";
}

export function formatRunFailureCode(code: string): string {
  if (code === RESTART_INDUCED_SUPERVISOR_LOSS) return "restart-induced supervisor loss";
  return code.replace(/_/g, " ");
}
