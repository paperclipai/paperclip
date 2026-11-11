import { isProviderFault, withProviderFaultRules } from "./provider-faults.js";
import { isDiskFullFault } from "./disk-full-faults.js";
import { isSessionFault } from "./session-faults.js";
import { takesJourneyTriggers } from "./journeys.js";
import { workloadDefinitions } from "./workloads.js";
import { isTimeFault, timeFaultHoldMs } from "./time-faults-config.js";
import { isMultiServerFault, multiServerHoldMs } from "./multi-server.js";
import { isRepeatedRestartFault, planRestartSteps, type RestartStep } from "./repeated-restarts.js";
import { k15HoldMs } from "./redeploy.js";
import { K4_MIN_HOLD_MS, type AdapterId, type FaultKind, type ScheduledFault, type StormFault, type StormPlan, type TaskFaultKind, type TaskPlan, type TriggerId, type WavePlan, type WaveOptions, type WorkloadId } from "./types.js";
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

export const K4_HOLD_RANGE_MS: readonly [number, number] = [K4_MIN_HOLD_MS, 300_000];

/** The seeded K4 hold range; `--k4-hold-max-seconds` raises its upper end
 * (up to the 600 s controller-outage cap) to reach the 7-minute reconnect
 * grace and longer outages. The default range is unchanged. */
export function k4HoldRange(maxMs?: number): readonly [number, number] {
  return maxMs === undefined ? K4_HOLD_RANGE_MS : [K4_HOLD_RANGE_MS[0], Math.max(K4_HOLD_RANGE_MS[0], maxMs)];
}

export const TRIGGER_DELAY_RANGE_MS: Record<Exclude<TriggerId, "time">, readonly [number, number]> = {
  comment: [0, 5_000],
  retry: [0, 2_000],
  queued: [0, 0],
  tool: [15_000, 60_000],
  result: [0, 3_000],
  approval: [0, 3_000],
  paused: [0, 3_000],
  stop: [0, 2_000],
  asked: [0, 3_000],
  answered: [0, 3_000],
  // Not a `--triggers` choice: `--provider-fault-restart-after-seconds` sets its delay.
  provider: [0, 0],
};

export function triggerFitsWorkload(trigger: TriggerId, workload: WorkloadId): boolean {
  if (trigger === "comment" || trigger === "result") return workload === "C1";
  if (trigger === "tool") return workload === "B5";
  if (trigger === "approval") return workload === "G1";
  if (trigger === "paused") return workload === "H1";
  if (trigger === "stop") return workload === "S1";
  if (trigger === "asked" || trigger === "answered") return takesJourneyTriggers(workload);
  return true;
}

/** The workload a trigger needs, for the error when none is selected. */
const TRIGGER_WORKLOAD: Partial<Record<TriggerId, string>> = { comment: "C1", result: "C1", tool: "B5", approval: "G1", paused: "H1", stop: "S1",
  asked: "Q1, Q2 or Q3", answered: "Q1, Q2 or Q3" };

/** Faults a `result` task may fire inside a storm: a fast restart that lands on the boundary. */
const STORM_RESULT_FAULTS: readonly FaultKind[] = ["K1", "K2"];

/**
 * A storm task has no fault of its own (`K13`): the wave's storm crosses it.
 * A `result` task in a storm also fires its own K1 or K2 just after its run
 * accepts a result, the window of RC-30, RC-33 and RC-41.
 */
function stormCellFaults(options: Pick<WaveOptions, "faults" | "stormMinutes" | "providerFaults" | "diskFullFaults" | "sessionFaults">, trigger: TriggerId): readonly TaskFaultKind[] {
  if (!options.stormMinutes) return [...options.faults, ...(options.providerFaults ?? []), ...(options.diskFullFaults ?? []), ...(options.sessionFaults ?? [])];
  if (trigger === "time") return ["K13"];
  if (trigger !== "result") throw new Error(`A K13 storm fires on its own clock; --triggers ${trigger} does not combine with it (use time or result)`);
  const faults = options.faults.filter(fault => STORM_RESULT_FAULTS.includes(fault));
  if (!faults.length) throw new Error("--triggers result in a storm needs K1 or K2 in --faults");
  return faults;
}

/**
 * Pairwise-friendly sampling: cycle a seeded shuffle of the full
 * workload × adapter × fault product so small waves still spread across cells.
 */
function pinnedFireAfterMs(faultAfterMs: number | undefined, drawn: number): number {
  return faultAfterMs ?? drawn;
}

export function planTasks(options: Pick<WaveOptions, "seed" | "tasks" | "workloads" | "adapters" | "faults" | "triggers" | "stormMinutes" | "k4HoldMaxMs" | "k15HoldMs" | "tm1HoldMs" | "faultAfterMs" | "providerFaults" | "diskFullFaults" | "sessionFaults" | "rrGapMs">): TaskPlan[] {
  const rng = createRng(options.seed);
  const triggers = options.triggers?.length ? options.triggers : ["time" as const];
  for (const trigger of triggers) {
    if (!options.workloads.some(workload => triggerFitsWorkload(trigger, workload))) {
      throw new Error(`Trigger "${trigger}" needs workload ${TRIGGER_WORKLOAD[trigger] ?? "?"} in --workloads`);
    }
  }
  const cells: Array<{ workload: WorkloadId; adapter: AdapterId; fault: TaskFaultKind; trigger: TriggerId }> = [];
  // Same cell order as before storms took triggers, so a seed keeps its plan.
  const allowed = new Map(triggers.map(trigger => [trigger, stormCellFaults(options, trigger)]));
  const faults = [...new Set([...allowed.values()].flat())];
  for (const workload of options.workloads) for (const adapter of options.adapters) for (const fault of faults) {
    for (const trigger of triggers) {
      if (triggerFitsWorkload(trigger, workload) && allowed.get(trigger)!.includes(fault)) cells.push({ workload, adapter, fault, trigger });
    }
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
      fireAfterMs: cell.fault === "K13" ? 0 : pinnedFireAfterMs(options.faultAfterMs, rng.int(fireMin, fireMax)),
      holdMs: cell.fault === "K4" ? rng.int(...k4HoldRange(options.k4HoldMaxMs)) : isTimeFault(cell.fault) ? timeFaultHoldMs(cell.fault, rng.int, options.tm1HoldMs)
        : isMultiServerFault(cell.fault) ? multiServerHoldMs(cell.fault, rng.int)
        : cell.fault === "K15" ? k15HoldMs(options.k15HoldMs, rng.int) : 0,
      // Drawn only for RR tasks, so the plans of existing seeds do not change.
      ...(isRepeatedRestartFault(cell.fault) ? { restartSteps: planRestartSteps(cell.fault, rng.int, options.rrGapMs) } : {}),
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
    createdAt: createdAt.toISOString(), options, tasks: withProviderFaultRules(planTasks(options), options),
    ...(options.stormMinutes ? { storm: planStorm(options.seed, options.stormMinutes, options.faults, options.k4HoldMaxMs, options.k15HoldMs) } : {}) };
}

/** K13: the gap between one storm fault settling and the next one firing. */
export const STORM_GAP_RANGE_MS: readonly [number, number] = [120_000, 240_000];

/**
 * K13 restart storm: a seeded sequence of faults drawn from `faults`, each
 * after a 2-4 minute gap, long enough to fill `minutes`. It uses its own RNG
 * stream so adding a storm does not change the task cells for a seed.
 */
export function planStorm(seed: number, minutes: number, faults: readonly FaultKind[], k4HoldMaxMs?: number,
  k15HoldRangeMs?: readonly [number, number]): StormPlan {
  if (!faults.length) throw new Error("A K13 storm needs at least one fault kind");
  const rng = createRng((seed ^ 0x6b313353) >>> 0);
  const durationMs = minutes * 60_000;
  const sequence: StormFault[] = [];
  for (let planned = 0; planned < durationMs;) {
    const gapMs = rng.int(...STORM_GAP_RANGE_MS);
    const kind = faults[rng.int(0, faults.length - 1)]!;
    sequence.push({ kind, gapMs, holdMs: kind === "K4" ? rng.int(...k4HoldRange(k4HoldMaxMs))
      : kind === "K15" ? k15HoldMs(k15HoldRangeMs, rng.int) : 0 });
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

/**
 * The storm clock the wave loop consults. Every decision takes a fresh `now`,
 * because the loop awaits slow work (server recovery, launches, pre-fault
 * snapshots) between choosing an action and taking it.
 */
export class StormRun {
  readonly state: StormState;
  ended = false;

  constructor(readonly plan: StormPlan, startedAt: number) {
    this.state = { startedAt, fired: 0, lastSettledAt: null };
  }

  /** True once, on the transition to the drain. */
  endIfDue(now: number): boolean {
    if (this.ended || stormActive(this.plan, this.state, now)) return false;
    this.ended = true;
    return true;
  }

  /** Ask immediately before each launch. */
  mayLaunch(now: number): boolean {
    return !this.ended && stormActive(this.plan, this.state, now);
  }

  /** The next fault, never while the previous one is still unsettled: each gap runs from its settle. */
  due(now: number): StormFault | null {
    return this.ended || this.unsettled ? null : stormFaultDue(this.plan, this.state, now);
  }

  /** Claim a fault chosen before slow work. False when the storm ended meanwhile; nothing is consumed. */
  commit(fault: StormFault, now: number): boolean {
    if (this.due(now) !== fault) return false;
    this.state.fired += 1;
    this.unsettled = true;
    return true;
  }

  settled(now: number) { this.state.lastSettledAt = now; this.unsettled = false; }

  private unsettled = false;

  /** The task pool ran dry with storm time left: the wave did not cover its storm. */
  exhaustedEarly(now: number): boolean {
    return !this.ended && stormActive(this.plan, this.state, now);
  }
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

/** Written after every fault: each task's launch time and the faults that crossed it so far. */
export const TASK_FAULT_LOG = "task-faults.json";
export type TaskFaultLog = Record<string, { createdAt: number | null; faultIds: string[]; serverBuildAtLaunch?: "upgrade_from" | "current" }>;

/**
 * A replay of a K14 wave task that launched on the current build: it starts on the current build
 * too (no `--upgrade-from`), and its recorded K14 restarts were current-build restarts (K2).
 */
export function replayOnCurrentBuild(plan: WavePlan): WavePlan {
  const asK2 = <T extends { kind?: FaultKind; fault?: TaskFaultKind }>(item: T): T => ({ ...item,
    ...(item.kind === "K14" ? { kind: "K2" as const } : {}), ...(item.fault === "K14" ? { fault: "K2" as const } : {}) });
  const { upgradeFrom: _upgradeFrom, ...options } = plan.options;
  return { ...plan, options: { ...options, faults: options.faults.map(kind => kind === "K14" ? "K2" : kind) },
    tasks: plan.tasks.map(task => ({ ...asK2(task), ...(task.replayFaults ? { replayFaults: task.replayFaults.map(asK2) } : {}) })) };
}

/** The crossing record for a replay: the graded record, else the live fault log (interrupted or wedged waves). */
export function replayRecordFor(taskId: string, graded: { createdAt: number | null; faultIds: string[] } | null,
  logged: TaskFaultLog | null): { createdAt: number | null; faultIds: string[] } | null {
  if (graded?.faultIds.length) return graded;
  return logged?.[taskId] ?? graded;
}

/** Faults that actually crossed a task, as offsets from its launch. */
export function observedFaultSchedule(createdAt: number | null, faultIds: readonly string[],
  faults: ReadonlyArray<{ faultId: string; kind: FaultKind; holdMs: number; startedAt: number; requestedBy?: string;
    trigger?: TriggerId; triggerDelayMs?: number; repeatedRestart?: { planned: RestartStep[] } }>, taskId?: string): ScheduledFault[] {
  if (createdAt === null) return [];
  return faults.filter(fault => faultIds.includes(fault.faultId))
    .map((fault): ScheduledFault => ({ kind: fault.kind, holdMs: fault.holdMs, atMs: Math.max(0, fault.startedAt - createdAt),
      // RR: the replay restarts again after the same gaps.
      ...(fault.repeatedRestart ? { restartSteps: fault.repeatedRestart.planned.map(step => ({ ...step })) } : {}),
      ...(fault.trigger && fault.trigger !== "time" && fault.requestedBy === taskId
        ? { trigger: fault.trigger, delayMs: fault.triggerDelayMs ?? 0 } : {}) }))
    .sort((a, b) => a.atMs - b.atMs);
}

/** The faults a task schedules: its replayed sequence, or its one planned fault. */
export function taskFaultSchedule(task: TaskPlan): ScheduledFault[] {
  if (task.replayFaults?.length) return task.replayFaults;
  // A storm crosses K13 tasks; a provider fault (PV*), a disk-full fault (DF1) and a matrix baseline (K0) restart nothing, unless
  // `--provider-fault-restart` asked for a K1 once the provider fault applied (the `provider` trigger).
  const restart = task.providerFault?.restart;
  if (restart) return [{ kind: restart.kind, holdMs: restart.holdMs ?? 0, atMs: 0, trigger: "provider", delayMs: restart.afterAppliedMs }];
  if (task.fault === "K13" || task.fault === "K0" || isProviderFault(task.fault) || isDiskFullFault(task.fault) || isSessionFault(task.fault)) return [];
  const planned: ScheduledFault = { kind: task.fault, holdMs: task.holdMs, atMs: task.fireAfterMs,
    ...(task.restartSteps ? { restartSteps: task.restartSteps } : {}) };
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
