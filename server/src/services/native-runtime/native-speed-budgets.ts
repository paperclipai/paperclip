/**
 * Speed budgets for native runs (plan invariant 8, Phase 1).
 *
 * Source: the Phase 0 local baseline (doc/plans/2026-11-07-ttft-baseline.md,
 * merged in #19846: TTFT and boot from runs 1 and 3, restart recovery from
 * run 4; Apple M5 Max, shared host). Each
 * budget is the baseline value times 1.2, rounded up to 0.5 s. The table is
 * recorded in doc/plans/2026-11-07-durable-ownership-and-reconciliation.md.
 *
 * A single run is checked against the p95 budget; p50 budgets apply to
 * aggregates (chaos waves, the baseline driver). Remote environments have no
 * budget until a Daytona baseline exists. Breaches go to the run log only,
 * never to Telemetry (AGENTS.md §5.7).
 */

export type SpeedBudgetAdapter = "claude" | "codex" | "opencode";
export type SpeedBudgetMetric = "ttft" | "agent_boot" | "restart_recovery";
export type SpeedBudgetStart = "cold" | "warm";

export type SpeedBudget = { p50Ms: number; p95Ms: number };

export const SPEED_BUDGET_BASELINE = "2026-11-07-ttft-baseline (local)";
export const SPEED_BUDGET_EXCEEDED_EVENT_TYPE = "run.performance.budget_exceeded";

const s = (seconds: number) => Math.round(seconds * 1000);

/** TTFT and agent boot by adapter and start kind; restart recovery by adapter. */
export const LOCAL_SPEED_BUDGETS: Readonly<Record<SpeedBudgetAdapter, {
  ttft: Record<SpeedBudgetStart, SpeedBudget>;
  agent_boot: Record<SpeedBudgetStart, SpeedBudget>;
  restart_recovery: SpeedBudget;
}>> = {
  claude: {
    ttft: { cold: { p50Ms: s(16.5), p95Ms: s(30) }, warm: { p50Ms: s(9.5), p95Ms: s(28.5) } },
    agent_boot: { cold: { p50Ms: s(9), p95Ms: s(20.5) }, warm: { p50Ms: s(3.5), p95Ms: s(16.5) } },
    restart_recovery: { p50Ms: s(15), p95Ms: s(22.5) },
  },
  codex: {
    ttft: { cold: { p50Ms: s(6), p95Ms: s(17) }, warm: { p50Ms: s(10), p95Ms: s(28.5) } },
    agent_boot: { cold: { p50Ms: s(2.5), p95Ms: s(7) }, warm: { p50Ms: s(5), p95Ms: s(16.5) } },
    restart_recovery: { p50Ms: s(6.5), p95Ms: s(8) },
  },
  opencode: {
    ttft: { cold: { p50Ms: s(17.5), p95Ms: s(49) }, warm: { p50Ms: s(26.5), p95Ms: s(88) } },
    agent_boot: { cold: { p50Ms: s(12), p95Ms: s(37) }, warm: { p50Ms: s(22), p95Ms: s(65.5) } },
    restart_recovery: { p50Ms: s(25.5), p95Ms: s(38.5) },
  },
};

/** Budgeted adapter of a native execution provider, or null (no budget). */
export function speedBudgetAdapter(provider: { kind: string; agent?: unknown } | null | undefined): SpeedBudgetAdapter | null {
  if (!provider) return null;
  if (provider.kind === "codex") return "codex";
  if (provider.kind === "opencode") return "opencode";
  if (provider.kind === "acpx" && provider.agent === "claude") return "claude";
  return null;
}

/** The budget for one measurement. An unknown start kind uses the looser of
 * the cold and warm budgets, so an unlabelled run is never over-reported. */
export function speedBudgetFor(adapter: SpeedBudgetAdapter, metric: SpeedBudgetMetric,
  start: SpeedBudgetStart | null): SpeedBudget {
  const budgets = LOCAL_SPEED_BUDGETS[adapter];
  if (metric === "restart_recovery") return budgets.restart_recovery;
  const byStart = budgets[metric];
  if (start) return byStart[start];
  return { p50Ms: Math.max(byStart.cold.p50Ms, byStart.warm.p50Ms), p95Ms: Math.max(byStart.cold.p95Ms, byStart.warm.p95Ms) };
}

export type SpeedBudgetBreach = {
  schema: "paperclip.run-performance-budget.v1";
  metric: SpeedBudgetMetric;
  adapter: SpeedBudgetAdapter;
  environment: "local";
  startKind: SpeedBudgetStart | "unknown";
  measuredMs: number;
  budgetP50Ms: number;
  budgetP95Ms: number;
  /** Single runs are judged against p95. */
  percentile: "p95";
  baseline: string;
  disposition?: string;
};

/** A breach when one measured run exceeds its p95 budget, else null. */
export function evaluateSpeedBudget(input: {
  adapter: SpeedBudgetAdapter | null;
  environment: "local" | "remote";
  metric: SpeedBudgetMetric;
  start: SpeedBudgetStart | null;
  measuredMs: number;
  disposition?: string;
}): SpeedBudgetBreach | null {
  if (!input.adapter || input.environment !== "local" || !Number.isFinite(input.measuredMs) || input.measuredMs < 0) return null;
  const budget = speedBudgetFor(input.adapter, input.metric, input.start);
  if (input.measuredMs <= budget.p95Ms) return null;
  return {
    schema: "paperclip.run-performance-budget.v1", metric: input.metric, adapter: input.adapter, environment: "local",
    startKind: input.start ?? "unknown", measuredMs: Math.round(input.measuredMs), budgetP50Ms: budget.p50Ms,
    budgetP95Ms: budget.p95Ms, percentile: "p95", baseline: SPEED_BUDGET_BASELINE,
    ...(input.disposition ? { disposition: input.disposition } : {}),
  };
}
