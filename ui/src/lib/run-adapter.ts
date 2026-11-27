import type { HeartbeatRun } from "@paperclipai/shared";

export function runAdapterType(run: Pick<HeartbeatRun, "runnerProfileJson">, configuredAdapterType: string): string {
  const dispatch = run.runnerProfileJson?.adapterDispatch;
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) return configuredAdapterType;
  const selected = (dispatch as Record<string, unknown>).adapterType;
  return typeof selected === "string" && selected.trim() ? selected : configuredAdapterType;
}
