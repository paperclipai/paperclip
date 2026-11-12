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
 * never to Telemetry (rules/data-paths.mdc).
 */

export type SpeedBudgetAdapter = "claude" | "codex" | "opencode";
/**
 * `time_to_first_activity`: run creation to the first agent activity the UI
 * shows (a text delta, a tool-call start or a reasoning indicator, whichever
 * comes first; span `task.time_to_first_agent_activity`). That is when the user
 * sees the agent respond. Time to first text (`task.time_to_first_token`) stays
 * a reported metric without a budget: tool-first adapters such as Claude often
 * call tools before they write text. The budget numbers are the TTFT baseline's.
 */
/**
 * `restart_recovery_control_plane`: control plane ready to the moment the
 * recovered run's provider starts loading its saved session
 * (`provider.session.load`), or to the run's next provider event when nothing
 * reloads (a reattached runner). That is Paperclip's own share of a recovery:
 * claim, prepare, runtime stage and runner launch. The provider's session load
 * grows with session size and with how many sessions resume at once, so the
 * full `restart_recovery` latency is reported without a budget.
 */
export type SpeedBudgetMetric = "time_to_first_activity" | "agent_boot" | "restart_recovery" | "restart_recovery_control_plane";
export type SpeedBudgetStart = "cold" | "warm";

export type SpeedBudget = { p50Ms: number; p95Ms: number };

export const SPEED_BUDGET_BASELINE = "2026-11-07-ttft-baseline (local)";
export const SPEED_BUDGET_EXCEEDED_EVENT_TYPE = "run.performance.budget_exceeded";

/** The provider events the baseline counts as a recovered run's next event
 * (tests/restart-chaos/ttft-baseline-stats.ts). Diagnostics do not count. */
export const RESTART_RECOVERY_PROVIDER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "turn.submitted", "turn.started", "turn.accepted", "item.started", "item.delta", "item.completed",
  "tool.execution.started", "tool.execution.progressed", "tool.execution.completed", "session.resumed",
]);

const s = (seconds: number) => Math.round(seconds * 1000);

/** First activity and agent boot by adapter and start kind; restart recovery by adapter. */
export const LOCAL_SPEED_BUDGETS: Readonly<Record<SpeedBudgetAdapter, {
  time_to_first_activity: Record<SpeedBudgetStart, SpeedBudget>;
  agent_boot: Record<SpeedBudgetStart, SpeedBudget>;
  /** Full recovery (ready → next provider event). Reported, not judged. */
  restart_recovery: SpeedBudget;
  /** Paperclip's share of a recovery; judged. Measured 1.2–2.0 s per run with six
   * Codex runs resuming at once (wave w-20261109T045320-s9807, local). */
  restart_recovery_control_plane: SpeedBudget;
}>> = {
  claude: {
    time_to_first_activity: { cold: { p50Ms: s(16.5), p95Ms: s(30) }, warm: { p50Ms: s(9.5), p95Ms: s(28.5) } },
    agent_boot: { cold: { p50Ms: s(9), p95Ms: s(20.5) }, warm: { p50Ms: s(3.5), p95Ms: s(16.5) } },
    restart_recovery: { p50Ms: s(15), p95Ms: s(22.5) },
    restart_recovery_control_plane: { p50Ms: s(2.5), p95Ms: s(4) },
  },
  codex: {
    time_to_first_activity: { cold: { p50Ms: s(6), p95Ms: s(17) }, warm: { p50Ms: s(10), p95Ms: s(28.5) } },
    agent_boot: { cold: { p50Ms: s(2.5), p95Ms: s(7) }, warm: { p50Ms: s(5), p95Ms: s(16.5) } },
    restart_recovery: { p50Ms: s(6.5), p95Ms: s(8) },
    restart_recovery_control_plane: { p50Ms: s(2.5), p95Ms: s(4) },
  },
  opencode: {
    time_to_first_activity: { cold: { p50Ms: s(17.5), p95Ms: s(49) }, warm: { p50Ms: s(26.5), p95Ms: s(88) } },
    agent_boot: { cold: { p50Ms: s(12), p95Ms: s(37) }, warm: { p50Ms: s(22), p95Ms: s(65.5) } },
    restart_recovery: { p50Ms: s(25.5), p95Ms: s(38.5) },
    restart_recovery_control_plane: { p50Ms: s(2.5), p95Ms: s(4) },
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
  if (metric === "restart_recovery_control_plane") return budgets.restart_recovery_control_plane;
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
  /** First activity only: time the input waited for its run to exist (for example a
   * comment posted while the previous turn was running). Not judged. */
  inputWaitMs?: number;
  /** Control-plane recovery only: the full ready → next provider event latency
   * and the provider's share of it (session load onwards). Not judged. */
  restartTotalMs?: number;
  providerLoadMs?: number;
};

/** A breach when one measured run exceeds its p95 budget, else null. */
export function evaluateSpeedBudget(input: {
  adapter: SpeedBudgetAdapter | null;
  environment: "local" | "remote";
  metric: SpeedBudgetMetric;
  start: SpeedBudgetStart | null;
  measuredMs: number;
  disposition?: string;
  inputWaitMs?: number;
  restartTotalMs?: number;
  providerLoadMs?: number;
}): SpeedBudgetBreach | null {
  if (!input.adapter || input.environment !== "local" || !Number.isFinite(input.measuredMs) || input.measuredMs < 0) return null;
  const budget = speedBudgetFor(input.adapter, input.metric, input.start);
  if (input.measuredMs <= budget.p95Ms) return null;
  return {
    schema: "paperclip.run-performance-budget.v1", metric: input.metric, adapter: input.adapter, environment: "local",
    startKind: input.start ?? "unknown", measuredMs: Math.round(input.measuredMs), budgetP50Ms: budget.p50Ms,
    budgetP95Ms: budget.p95Ms, percentile: "p95", baseline: SPEED_BUDGET_BASELINE,
    ...(input.disposition ? { disposition: input.disposition } : {}),
    ...(input.restartTotalMs !== undefined ? { restartTotalMs: Math.round(input.restartTotalMs) } : {}),
    ...(input.providerLoadMs !== undefined ? { providerLoadMs: Math.round(input.providerLoadMs) } : {}),
    ...(input.inputWaitMs ? { inputWaitMs: Math.round(input.inputWaitMs) } : {}),
  };
}

/** The restart-recovery measurement for one committed runner event, or null
 * when the event is not a provider event (the baseline's set). */
export function restartRecoveryMeasurementFor(input: {
  event: { eventType: string; emittedAt?: string | null };
  startup: { phase: string; updatedAt: string };
  committedAtMs: number;
  disposition: string;
}): { readyAtMs: number | null; emittedAtMs: number | null; committedAtMs: number; disposition: string } | null {
  if (!RESTART_RECOVERY_PROVIDER_EVENT_TYPES.has(input.event.eventType)) return null;
  const emitted = Date.parse(input.event.emittedAt ?? "");
  const ready = Date.parse(input.startup.updatedAt);
  return {
    readyAtMs: input.startup.phase === "ready" && Number.isFinite(ready) ? ready : null,
    emittedAtMs: Number.isFinite(emitted) ? emitted : null,
    committedAtMs: input.committedAtMs,
    disposition: input.disposition,
  };
}
