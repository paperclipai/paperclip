/**
 * A project's task-execution policy. `absent` was never configured, so a later
 * legacy migration may still choose a value. `configured` with a null maximum
 * is an explicit "no limit" that such a migration must preserve.
 */
export type TaskExecutionPolicy =
  | { state: "absent"; maxConcurrentTasks: null }
  | { state: "configured"; maxConcurrentTasks: number | null };

/** Null clears the cap explicitly. An omitted field preserves its value. */
export type TaskExecutionPolicyPatch = { maxConcurrentTasks?: number | null } | null;

export type PolicyPatchResult =
  | { kind: "ok"; patch: TaskExecutionPolicyPatch }
  | { kind: "invalid"; field: "policy" | "maxConcurrentTasks"; reason: string };

export const ABSENT_TASK_EXECUTION_POLICY: TaskExecutionPolicy = { state: "absent", maxConcurrentTasks: null };

// The column is a PostgreSQL integer.
const MAX_STORED_MAXIMUM = 2_147_483_647;

/** Undefined (an omitted policy) preserves everything; null clears the cap. */
export function parseTaskExecutionPolicyPatch(input: unknown): PolicyPatchResult {
  if (input === undefined) return { kind: "ok", patch: {} };
  if (input === null) return { kind: "ok", patch: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { kind: "invalid", field: "policy", reason: "Policy must be an object or null" };
  }
  const unknownKey = Object.keys(input).find(key => key !== "maxConcurrentTasks");
  if (unknownKey) return { kind: "invalid", field: "policy", reason: `Unknown policy field ${unknownKey}` };
  if (!("maxConcurrentTasks" in input)) return { kind: "ok", patch: {} };
  const value = (input as { maxConcurrentTasks: unknown }).maxConcurrentTasks;
  if (value === undefined) return { kind: "ok", patch: {} };
  if (value === null) return { kind: "ok", patch: { maxConcurrentTasks: null } };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_STORED_MAXIMUM) {
    return { kind: "invalid", field: "maxConcurrentTasks", reason: "Maximum concurrent tasks must be a positive whole number" };
  }
  return { kind: "ok", patch: { maxConcurrentTasks: value } };
}

/** Applies a validated patch. Returns the current policy when nothing changes. */
export function applyTaskExecutionPolicyPatch(current: TaskExecutionPolicy, patch: TaskExecutionPolicyPatch): TaskExecutionPolicy {
  if (patch !== null && patch.maxConcurrentTasks === undefined) return current;
  const maxConcurrentTasks = patch === null ? null : patch.maxConcurrentTasks ?? null;
  if (current.state === "configured" && current.maxConcurrentTasks === maxConcurrentTasks) return current;
  return { state: "configured", maxConcurrentTasks };
}
