import type { AdapterCommandBackedExecutionTarget, AdapterExecutionTarget } from "./execution-target.js";

/** Command transport capability; sandbox allocation ownership is unchanged. */
export function adapterExecutionTargetIsCommandBacked(
  target: AdapterExecutionTarget | null | undefined,
): target is AdapterCommandBackedExecutionTarget {
  return target?.kind === "remote" && (target.transport === "sandbox" || target.transport === "computer");
}

