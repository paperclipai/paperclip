import { workloadDefinitions } from "./workloads.js";
import type { AdapterId, FaultKind, ScheduledFault, StormFault, StormPlan, TaskFaultKind, TaskPlan, TriggerId, WavePlan, WaveOptions, WorkloadId } from "./types.js";
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

export const TRIGGER_DELAY_RANGE_MS: Record<Exclude<TriggerId, "time">, readonly [number, number]> = {
  comment: [0, 5_000],
  retry: [0, 2_000],
  queued: [0, 0],
  tool: [15_000, 60_000],
};

export function triggerFitsWorkload(trigger: TriggerId, workload: WorkloadId): boolean {
  if (trigger === "comment") return workload === "C1";
  if (trigger === "tool") return workload === "B5";
  return true;
}

/**
 * Pairwise-friendly sampling: cycle a seeded shuffle of the full
 * workload × adapter × fault product so small waves still spread across cells.
 */
export function planTasks(options: Pick<WaveOptions, "seed" | "tasks" | "workloads" | "adapters" | "faults" | "triggers" | "stormMinutes">): TaskPlan[] {
  const rng = createRng(options.seed);
  const triggers = options.triggers?.length ? options.triggers : ["time" as const];
  // A storm task has no fault of its own: the wave's storm crosses it.
  const faults: readonly TaskFaultKind[] = options.stormMinutes ? ["K13"] : options.faults;
  if (options.stormMinutes && triggers.some(trigger => trigger !== "time")) throw new Error("A K13 storm fires on its own clock; use --triggers time");
  for (const trigger of triggers) {
    if (!options.workloads.some(workload => triggerFitsWorkload(trigger, workload))) {
      throw new Error(`Trigger "${trigger}" needs workload ${trigger === "comment" ? "C1" : "B5"} in --workloads`);
    }
  }
  const cells: Array<{ workload: WorkloadId; adapter: AdapterId; fault: TaskFaultKind; trigger: TriggerId }> = [];
  for (const workload of options.workloads) for (const adapter of options.adapters) for (const fault of faults) {
    for (const trigger of triggers) if (triggerFitsWorkload(trigger, workload)) cells.push({ workload, adapter, fault, trigger });
  }
  const tasks: TaskPlan[] = [];
  let order = rng.shuffle(cells);
  for (let index = 0; index < options.tasks; index += 1) {
    if (index > 0 && index % cells.length === 0) order = rng.shuffle(cells);
    const cell = order[index % cells.length]!;
    const definition = workloadDefinitions[cell.workload];
    const [fireMin, fireMax] = definition.fireWindowMs;
    const { trigger, ...cellRest } = cell;
    tasks.push({
      taskId: `t${String(index + 1).padStart(2, "0")}`,
      index,
      ...cellRest,
      ...(trigger === "time" ? {} : { trigger, triggerDelayMs: rng.int(...TRIGGER_DELAY_RANGE_MS[trigger]) }),
      fireAfterMs: cell.fault === "K13" ? 0 : rng.int(fireMin, fireMax),
      holdMs: cell.fault === "K4" ? rng.int(K4_HOLD_RANGE_MS[0], K4_HOLD_RANGE_MS[1]) : 0,
      followUpAfterMs: definition.followUpWindowMs ? rng.int(definition.followUpWindowMs[0], definition.followUpWindowMs[1]) : null,
      nonce: rng.hex(8),
    });
  }
  return tasks;
}

function withoutStorm(options: WaveOptions): WaveOptions {
  const { stormMinutes: _storm, ...rest } = options;
  return rest;
}

/** A replay keeps the source wave's masks and may add more; it never drops one. */
function replayMasks(source: readonly string[] | undefined, added: readonly string[] | undefined) {
  const masks = [...new Set([...(source ?? []), ...(added ?? [])])];
  return masks.length ? { masks } : {};
}

export function planWave(waveId: string, options: WaveOptions, createdAt = new Date()): WavePlan {
  return { schema: "paperclip.restart-chaos.wave-plan/v1", waveId, seed: options.seed,
    createdAt: createdAt.toISOString(), options, tasks: planTasks(options),
    ...(options.stormMinutes ? { storm: planStorm(options.seed, options.stormMinutes, options.faults) } : {}) };
}

/** K13: the gap between one storm fault settling and the next one firing. */
export const STORM_GAP_RANGE_MS: readonly [number, number] = [120_000, 240_000];

/**
 * K13 restart storm: a seeded sequence of faults drawn from `faults`, each
 * after a 2-4 minute gap, long enough to fill `minutes`. It uses its own RNG
 * stream so adding a storm does not change the task cells for a seed.
 */
export function planStorm(seed: number, minutes: number, faults: readonly FaultKind[]): StormPlan {
  if (!faults.length) throw new Error("A K13 storm needs at least one fault kind");
  const rng = createRng((seed ^ 0x6b313353) >>> 0);
  const durationMs = minutes * 60_000;
  const sequence: StormFault[] = [];
  for (let planned = 0; planned < durationMs;) {
    const gapMs = rng.int(...STORM_GAP_RANGE_MS);
    const kind = faults[rng.int(0, faults.length - 1)]!;
    sequence.push({ kind, gapMs, holdMs: kind === "K4" ? rng.int(...K4_HOLD_RANGE_MS) : 0 });
    planned += gapMs;
  }
  return { durationMs, faults: sequence };
}

export interface StormState {
  startedAt: number;
  /** Storm faults fired so far. */
  fired: number;
  /** When the previous storm fault finished (server ready, or the fault failed); null before the first. */
  lastSettledAt: number | null;
}

/** New tasks launch and storm faults fire only while the storm lasts; then it drains. */
export function stormActive(storm: StormPlan, state: StormState, now: number): boolean {
  return now < state.startedAt + storm.durationMs;
}

/** Whether a new task may launch now: always outside a storm, and only while a storm lasts. */
export function stormMayLaunch(storm: StormPlan | undefined, state: StormState, now: number): boolean {
  return !storm || stormActive(storm, state, now);
}

/**
 * The next storm fault once its gap has passed. Gaps run from the previous
 * fault settling, so a K4 hold never eats the next gap. The caller must not
 * ask while a fault is still in progress.
 */
export function stormFaultDue(storm: StormPlan, state: StormState, now: number): StormFault | null {
  if (!stormActive(storm, state, now)) return null;
  const next = storm.faults[state.fired];
  if (!next) return null;
  return now >= (state.lastSettledAt ?? state.startedAt) + next.gapMs ? next : null;
}

/** Faults that actually crossed a task, as offsets from its launch. */
export function observedFaultSchedule(createdAt: number | null, faultIds: readonly string[],
  faults: ReadonlyArray<{ faultId: string; kind: FaultKind; holdMs: number; startedAt: number; requestedBy?: string;
    trigger?: TriggerId; triggerDelayMs?: number }>, taskId?: string): ScheduledFault[] {
  if (createdAt === null) return [];
  return faults.filter(fault => faultIds.includes(fault.faultId))
    .map((fault): ScheduledFault => ({ kind: fault.kind, holdMs: fault.holdMs, atMs: Math.max(0, fault.startedAt - createdAt),
      ...(fault.trigger && fault.trigger !== "time" && fault.requestedBy === taskId
        ? { trigger: fault.trigger, delayMs: fault.triggerDelayMs ?? 0 } : {}) }))
    .sort((a, b) => a.atMs - b.atMs);
}

/** The faults a task schedules: its replayed sequence, or its one planned fault. */
export function taskFaultSchedule(task: TaskPlan): ScheduledFault[] {
  if (task.replayFaults?.length) return task.replayFaults;
  if (task.fault === "K13") return [];
  const planned: ScheduledFault = { kind: task.fault, holdMs: task.holdMs, atMs: task.fireAfterMs };
  const trigger = task.trigger ?? "time";
  if (trigger === "time") return [planned];
  const delayMs = task.triggerDelayMs ?? 0;
  if (trigger === "retry") return [planned, { kind: "K1", holdMs: 0, atMs: 0, trigger, delayMs }];
  return [{ ...planned, trigger, delayMs }];
}

/**
 * A replay keeps the saved cell, hold and nonce and runs alone. When the source
 * wave recorded which faults crossed the task (including other tasks' faults),
 * the replay fires that same sequence at the same offsets from launch.
 */
export function replayWave(source: WavePlan, ref: ReplayRef, now = Date.now(),
  overrides: Partial<Pick<WaveOptions, "pollMs" | "budgetCents" | "masks">> = {}, observed: ScheduledFault[] = []): WavePlan {
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
    // A replay fires only the faults that crossed the task, never a new storm.
    options: { ...withoutStorm(source.options), ...overrides, tasks: 1, concurrency: 1, ...replayMasks(source.options.masks, overrides.masks) },
    tasks: [{ ...task, ...(observed.length ? { replayFaults: observed.map(fault => ({ ...fault })) } : {}) }],
    replayOf: { ...ref },
  };
}
