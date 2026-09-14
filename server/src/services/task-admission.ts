import { randomUUID } from "node:crypto";
import { conflict } from "../errors.js";
export type TaskDrainState = { startedAt: Date; expiresAt: Date | null; ownerId?: string };
let taskDrainState: TaskDrainState | null = null;

export function readTaskDrain(
  now: Date,
): TaskDrainState | null {
  if (
    taskDrainState &&
    taskDrainState.expiresAt !== null &&
    taskDrainState.expiresAt.getTime() <= now.getTime()
  ) {
    taskDrainState = null;
  }
  return taskDrainState;
}

/** Compute the drain a start call would apply, without changing state. */
export function computeTaskDrain(opts: { ttlMs?: number | null; purpose?: "idle" } = {}): {
  startedAt: Date;
  expiresAt: Date | null;
  ownerId?: string;
} {
  const startedAt = new Date();
  const ttlMs = opts.ttlMs ?? null;
  const expiresAt =
    ttlMs === null ? null : new Date(startedAt.getTime() + ttlMs);
  return { startedAt, expiresAt, ...(opts.purpose === "idle" ? { ownerId: randomUUID() } : {}) };
}

/** Assign the given drain as the current task-drain state. */
export function applyTaskDrain(drain: {
  startedAt: Date;
  expiresAt: Date | null;
  ownerId?: string;
}): void {
  taskDrainState = drain;
}

export function startTaskDrain(opts: { ttlMs?: number | null; purpose?: "idle" } = {}): TaskDrainState {
  const drain = computeTaskDrain(opts);
  applyTaskDrain(drain);
  return drain;
}

export function stopTaskDrain(): { wasActive: boolean } {
  const wasActive = readTaskDrain(new Date()) !== null;
  taskDrainState = null;
  return { wasActive };
}


let runtimeServiceMutations = 0;
export function runtimeServiceMutationCount() { return runtimeServiceMutations; }

/** Admission and registration are synchronous: a hold cannot miss an admitted mutation. */
export async function withRuntimeServiceMutation<T>(run: () => Promise<T>): Promise<T> {
  if (readTaskDrain(new Date())) throw conflict("Paperclip is preparing to pause; retry the service action shortly");
  runtimeServiceMutations++;
  try { return await run(); } finally { runtimeServiceMutations--; }
}

export function guardRuntimeServiceMutations<T extends object>(manager: T): T {
  const guarded = { ...manager };
  // Activity updates cannot admit new process/controller work. Wake guards
  // only its real sleeping-to-running transition after its initial read.
  const nonAdmitting = new Set(["wake", "activity", "previewActivity", "get", "getRecord", "list", "companyPolicy", "dataDeletionReview", "storage", "upstream", "logs"]);
  const background = new Set(["reconcile", "reconcileAllocation", "reconcileDataDeletion", "storageTick", "dataDeletionTick", "dataExpirationTick", "tick", "reconciliationCandidates"]);
  for (const [key, method] of Object.entries(manager)) {
    if (typeof method !== "function" || nonAdmitting.has(key)) continue;
    (guarded as Record<string, unknown>)[key] = (...args: unknown[]) => {
      if (background.has(key) && readTaskDrain(new Date())) return Promise.resolve(key === "reconciliationCandidates" ? [] : undefined);
      return withRuntimeServiceMutation(() => method(...args));
    };
  }
  return guarded;
}
