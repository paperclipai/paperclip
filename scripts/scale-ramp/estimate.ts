import type { Options } from "./config.ts";

export interface SpendEstimate {
  agents: number;
  tasks: number;
  maxTasks: number;
  sandboxHours: number;
  modelUsd: number;
  sandboxUsd: number;
  totalUsd: number;
  wallMinutes: number;
  assumptions: string[];
}

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

export function estimateSpend(options: Pick<Options, "steps" | "drainMs" | "taskMinutes" | "maxTasks" | "pricing">): SpendEstimate {
  const agents = Math.max(...options.steps.map(step => step.concurrency));
  const holdMinutes = (step: { holdMs: number }) => step.holdMs / 60_000;
  const tasks = options.steps.reduce((sum, step) => sum + step.concurrency * Math.ceil(holdMinutes(step) / options.taskMinutes), 0);
  const maxTasks = options.maxTasks ?? Math.ceil(tasks * 1.25);
  const drainMinutes = options.drainMs / 60_000;
  const sandboxHours = options.steps.reduce((sum, step) => sum + step.concurrency * holdMinutes(step) / 60, 0)
    + agents * Math.min(drainMinutes, options.taskMinutes * 2) / 60;
  const modelUsd = maxTasks * options.pricing.modelUsdPerTask;
  const sandboxUsd = sandboxHours * options.pricing.sandboxUsdPerHour;
  return {
    agents,
    tasks,
    maxTasks,
    sandboxHours: round(sandboxHours, 1),
    modelUsd: round(modelUsd),
    sandboxUsd: round(sandboxUsd),
    totalUsd: round(modelUsd + sandboxUsd),
    wallMinutes: Math.round(options.steps.reduce((sum, step) => sum + holdMinutes(step), 0) + drainMinutes),
    assumptions: [
      `each agent finishes one task every ${options.taskMinutes} min, so a step creates concurrency x ceil(hold / task minutes) tasks`,
      `model spend is the task cap (${maxTasks}) x $${options.pricing.modelUsdPerTask} per task (PAPERCLIP_SCALE_MODEL_USD_PER_TASK)`,
      `sandbox spend is agent-hours of holds plus the drain x $${options.pricing.sandboxUsdPerHour} per sandbox-hour (PAPERCLIP_SCALE_SANDBOX_USD_PER_HOUR)`,
      "these are estimates; the result reports the model spend the runs recorded",
    ],
  };
}

export type SpendDecision = { ok: true } | { ok: false; reason: string };

export function checkSpend(estimate: SpendEstimate, thresholdUsd: number, confirmedUsd: number | null): SpendDecision {
  if (estimate.totalUsd <= thresholdUsd) return { ok: true };
  if (confirmedUsd === null) {
    return { ok: false, reason: `Estimated spend $${estimate.totalUsd} is above $${thresholdUsd}; rerun with --confirm-spend <max USD> of at least ${Math.ceil(estimate.totalUsd)}` };
  }
  if (confirmedUsd < estimate.totalUsd) {
    return { ok: false, reason: `--confirm-spend ${confirmedUsd} is below the estimated $${estimate.totalUsd}` };
  }
  return { ok: true };
}
