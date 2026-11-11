/**
 * `--matrix`: one task per cell of workload × adapter × (no fault, or each
 * `--faults` kind at each of the workload's own fault boundaries). A journey
 * workload (Q1–Q3) gets a K0 baseline plus every fault at `asked` and at
 * `answered`; G1 at `approval`, C1 at `comment` and `result`, and so on
 * (journeys.ts WORKLOAD_TRIGGERS). The cells run in a fixed order so a seed
 * always means the same matrix; `--tasks` is the cell count.
 *
 * A restart hits every task in flight, so the K0 baselines run first and never
 * share the server with a fault cell (`matrixMayLaunch`).
 */
import path from "node:path";
import { k15HoldMs } from "./redeploy.js";
import { WORKLOAD_TRIGGERS } from "./journeys.js";
import { withProviderFaultRules } from "./provider-faults.js";
import { createRng, k4HoldRange, TRIGGER_DELAY_RANGE_MS } from "./scheduler.js";
import { isTimeFault, timeFaultHoldMs } from "./time-faults-config.js";
import { classRHoldMs, isClassRFault } from "./class-r.js";
import { isMultiServerFault, multiServerHoldMs } from "./multi-server.js";
import { isRepeatedRestartFault, planRestartSteps } from "./repeated-restarts.js";
import { workloadDefinitions } from "./workloads.js";
import type { AdapterId, TaskFaultKind, TaskPlan, TriggerId, WaveOptions, WavePlan, WorkloadId } from "./types.js";

export interface MatrixCell { workload: WorkloadId; adapter: AdapterId; fault: TaskFaultKind; trigger: TriggerId }

/** G1 and H1 grade the board's decision after a restart, so a no-fault run cannot pass them: they get no baseline. */
export const NO_BASELINE_WORKLOADS: readonly WorkloadId[] = ["G1", "H1"];

export function matrixCells(options: Pick<WaveOptions, "workloads" | "adapters" | "faults" | "providerFaults">): MatrixCell[] {
  const baselines: MatrixCell[] = [];
  const faulted: MatrixCell[] = [];
  for (const workload of options.workloads) for (const adapter of options.adapters) {
    // The baseline: the same journey with no fault, so a fault cell's failure is attributable.
    if (!NO_BASELINE_WORKLOADS.includes(workload)) baselines.push({ workload, adapter, fault: "K0", trigger: "time" });
    for (const fault of options.faults) for (const trigger of WORKLOAD_TRIGGERS[workload]) faulted.push({ workload, adapter, fault, trigger });
    // A provider message fault is armed per task in the provider shim; it has no trigger of its own.
    for (const fault of options.providerFaults ?? []) faulted.push({ workload, adapter, fault, trigger: "time" });
  }
  return [...baselines, ...faulted];
}

/** A baseline launches only beside other baselines, and a fault cell only once no baseline is in flight. */
export function matrixMayLaunch(next: Pick<TaskPlan, "fault">, inFlight: ReadonlyArray<Pick<TaskPlan, "fault">>): boolean {
  const baseline = next.fault === "K0";
  return inFlight.every(task => (task.fault === "K0") === baseline);
}

export function planMatrixTasks(options: Pick<WaveOptions, "seed" | "workloads" | "adapters" | "faults" | "providerFaults" | "k4HoldMaxMs" | "k15HoldMs" | "tm1HoldMs" | "faultAfterMs" | "rrGapMs" | "cr1HoldMs" | "cr2HoldMs" | "cr3StallMs">): TaskPlan[] {
  const rng = createRng((options.seed ^ 0x6a6d7478) >>> 0);
  return matrixCells(options).map((cell, index) => {
    const definition = workloadDefinitions[cell.workload];
    const [fireMin, fireMax] = definition.fireWindowMs;
    const drawn = rng.int(fireMin, fireMax);
    return {
      taskId: `t${String(index + 1).padStart(2, "0")}`,
      index,
      workload: cell.workload,
      adapter: cell.adapter,
      fault: cell.fault,
      ...(cell.trigger === "time" ? {} : { trigger: cell.trigger, triggerDelayMs: rng.int(...TRIGGER_DELAY_RANGE_MS[cell.trigger]) }),
      // `--fault-after-seconds` pins time-fired restarts, as it does outside the matrix.
      fireAfterMs: cell.fault === "K0" || cell.fault.startsWith("PV") ? 0 : cell.trigger === "time" ? options.faultAfterMs ?? drawn : drawn,
      holdMs: cell.fault === "K4" ? rng.int(...k4HoldRange(options.k4HoldMaxMs))
        : isTimeFault(cell.fault) ? timeFaultHoldMs(cell.fault, rng.int, options.tm1HoldMs)
        : isMultiServerFault(cell.fault) ? multiServerHoldMs(cell.fault, rng.int)
        : cell.fault === "K15" ? k15HoldMs(options.k15HoldMs, rng.int)
          : isClassRFault(cell.fault) ? classRHoldMs(cell.fault, options, rng.int) : 0,
      ...(isRepeatedRestartFault(cell.fault) ? { restartSteps: planRestartSteps(cell.fault, rng.int, options.rrGapMs) } : {}),
      followUpAfterMs: definition.followUpWindowMs ? rng.int(definition.followUpWindowMs[0], definition.followUpWindowMs[1]) : null,
      nonce: rng.hex(8),
    };
  });
}

/** `--matrix` and `--server-from`, validated against the rest of the parsed options. */
export function applyJourneyOptions(options: WaveOptions, input: { matrix: boolean; serverFrom: string | undefined; tasksGiven: boolean; triggersGiven: boolean }) {
  if (input.matrix) {
    if (options.stormMinutes || options.crashPoint) throw new Error("--matrix plans its own cells; it does not combine with --storm-minutes or --crash-point");
    if (input.tasksGiven) throw new Error("--matrix runs one task per cell; do not pass --tasks");
    if (input.triggersGiven) throw new Error("--matrix uses each workload's own triggers; do not pass --triggers");
    if (options.faults.includes("K14")) throw new Error("--matrix does not cross K14 (an upgrade happens once per wave)");
    // The matrix crosses restart and provider faults only; SR1 would silently run as its K0 baseline.
    if (options.sessionFaults?.length) throw new Error("--matrix does not cross session faults (SR*); run SR1 as its own wave");
    options.matrix = true;
    options.tasks = matrixCells(options).length;
  }
  if (input.serverFrom !== undefined) {
    if (options.env !== "local") throw new Error("--server-from runs only with --env local");
    if (options.faults.includes("K14")) throw new Error("--server-from runs every server from one checkout; use --upgrade-from for K14");
    options.serverFrom = path.resolve(input.serverFrom);
  }
}

export function planMatrixWave(waveId: string, options: WaveOptions, createdAt = new Date()): WavePlan {
  const tasks = withProviderFaultRules(planMatrixTasks(options), options);
  return { schema: "paperclip.restart-chaos.wave-plan/v1", waveId, seed: options.seed, createdAt: createdAt.toISOString(),
    options: { ...options, tasks: tasks.length }, tasks };
}
