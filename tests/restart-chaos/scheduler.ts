import { workloadDefinitions } from "./workloads.js";
import type { AdapterId, FaultKind, TaskPlan, WavePlan, WaveOptions, WorkloadId } from "./types.js";
import type { ReplayRef } from "./config.js";

/** mulberry32: small, fast and fully determined by its 32-bit seed. */
export function createRng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int(min: number, max: number) { return min + Math.floor(next() * (max - min + 1)); },
    hex(length: number) { let out = ""; while (out.length < length) out += Math.floor(next() * 16).toString(16); return out; },
    shuffle<T>(values: readonly T[]): T[] {
      const copy = [...values];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(next() * (index + 1));
        [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
      }
      return copy;
    },
  };
}

export const K4_HOLD_RANGE_MS: readonly [number, number] = [120_000, 300_000];

/**
 * Pairwise-friendly sampling: cycle a seeded shuffle of the full
 * workload × adapter × fault product so small waves still spread across cells.
 */
export function planTasks(options: Pick<WaveOptions, "seed" | "tasks" | "workloads" | "adapters" | "faults">): TaskPlan[] {
  const rng = createRng(options.seed);
  const cells: Array<{ workload: WorkloadId; adapter: AdapterId; fault: FaultKind }> = [];
  for (const workload of options.workloads) for (const adapter of options.adapters) for (const fault of options.faults) cells.push({ workload, adapter, fault });
  const tasks: TaskPlan[] = [];
  let order = rng.shuffle(cells);
  for (let index = 0; index < options.tasks; index += 1) {
    if (index > 0 && index % cells.length === 0) order = rng.shuffle(cells);
    const cell = order[index % cells.length]!;
    const definition = workloadDefinitions[cell.workload];
    const [fireMin, fireMax] = definition.fireWindowMs;
    tasks.push({
      taskId: `t${String(index + 1).padStart(2, "0")}`,
      index,
      ...cell,
      fireAfterMs: rng.int(fireMin, fireMax),
      holdMs: cell.fault === "K4" ? rng.int(K4_HOLD_RANGE_MS[0], K4_HOLD_RANGE_MS[1]) : 0,
      followUpAfterMs: definition.followUpWindowMs ? rng.int(definition.followUpWindowMs[0], definition.followUpWindowMs[1]) : null,
      nonce: rng.hex(8),
    });
  }
  return tasks;
}

export function planWave(waveId: string, options: WaveOptions, createdAt = new Date()): WavePlan {
  return { schema: "paperclip.restart-chaos.wave-plan/v1", waveId, seed: options.seed,
    createdAt: createdAt.toISOString(), options, tasks: planTasks(options) };
}

/** A replay keeps the saved cell, fire time, hold and nonce; it runs alone. */
export function replayWave(source: WavePlan, ref: ReplayRef, now = Date.now(),
  overrides: Partial<Pick<WaveOptions, "pollMs" | "budgetCents">> = {}): WavePlan {
  if (source.schema !== "paperclip.restart-chaos.wave-plan/v1") throw new Error("Unsupported wave plan schema");
  if (source.waveId !== ref.waveId) throw new Error(`Plan is for ${source.waveId}, not ${ref.waveId}`);
  const task = source.tasks.find(candidate => candidate.taskId === ref.taskId);
  if (!task) throw new Error(`Wave ${ref.waveId} has no task ${ref.taskId}`);
  const base = source.waveId.replace(/-replay-t[0-9]{2,3}-[0-9]+$/, "");
  return {
    schema: source.schema,
    waveId: `${base}-replay-${task.taskId}-${now}`,
    seed: source.seed,
    createdAt: new Date(now).toISOString(),
    options: { ...source.options, ...overrides, tasks: 1, concurrency: 1 },
    tasks: [{ ...task }],
    replayOf: { ...ref },
  };
}
