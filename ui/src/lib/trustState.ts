import type { DashboardRunActivityDay, DashboardSummary } from "@paperclipai/shared";

export type TrustState = "healthy" | "needs_attention" | "critical" | "unknown";

export interface TrustMetric {
  status: "ok" | "warn" | "critical" | "unknown" | "zero";
  ratio: number | null;
  numerator: number | null;
  denominator: number | null;
}

export interface TrustEvaluation {
  state: TrustState;
  header: string;
  summary: string;
  blocked: TrustMetric;
  failedToday: TrustMetric;
  sevenDay: {
    ratio: number | null;
    failed: number;
    total: number;
    days: DashboardRunActivityDay[];
  };
  agentsErrored: number;
  agentsActive: number;
  agentsRunning: number;
}

// Thresholds from /WEA/issues/WEA-2328 trust dashboard card spec.
export const BLOCKED_WARN = 0.35;
export const BLOCKED_CRITICAL = 0.5;
export const FAILED_WARN = 0.1;
export const FAILED_CRITICAL = 0.2;

const STATE_RANK: Record<TrustState, number> = {
  healthy: 0,
  needs_attention: 1,
  critical: 2,
  unknown: 3,
};

function metricStatus(ratio: number, warn: number, critical: number): TrustMetric["status"] {
  if (ratio > critical) return "critical";
  if (ratio >= warn) return "warn";
  return "ok";
}

export function evaluateBlocked(tasks: DashboardSummary["tasks"] | undefined): TrustMetric {
  if (!tasks || typeof tasks.open !== "number" || typeof tasks.blocked !== "number") {
    return { status: "unknown", ratio: null, numerator: null, denominator: null };
  }
  if (tasks.open === 0) {
    return { status: "zero", ratio: 0, numerator: tasks.blocked, denominator: 0 };
  }
  const ratio = tasks.blocked / tasks.open;
  return {
    status: metricStatus(ratio, BLOCKED_WARN, BLOCKED_CRITICAL),
    ratio,
    numerator: tasks.blocked,
    denominator: tasks.open,
  };
}

export function evaluateFailedToday(runActivity: DashboardRunActivityDay[] | undefined): TrustMetric {
  if (!runActivity || runActivity.length === 0) {
    return { status: "unknown", ratio: null, numerator: null, denominator: null };
  }
  const today = runActivity[runActivity.length - 1];
  if (!today || typeof today.total !== "number") {
    return { status: "unknown", ratio: null, numerator: null, denominator: null };
  }
  if (today.total === 0) {
    return { status: "unknown", ratio: null, numerator: today.failed ?? 0, denominator: 0 };
  }
  const ratio = today.failed / today.total;
  return {
    status: metricStatus(ratio, FAILED_WARN, FAILED_CRITICAL),
    ratio,
    numerator: today.failed,
    denominator: today.total,
  };
}

export function evaluateSevenDay(runActivity: DashboardRunActivityDay[] | undefined): TrustEvaluation["sevenDay"] {
  const tail = (runActivity ?? []).slice(-7);
  let failed = 0;
  let total = 0;
  for (const day of tail) {
    failed += day.failed ?? 0;
    total += day.total ?? 0;
  }
  return {
    ratio: total === 0 ? null : failed / total,
    failed,
    total,
    days: tail,
  };
}

function statusToState(status: TrustMetric["status"]): TrustState {
  if (status === "critical") return "critical";
  if (status === "warn") return "needs_attention";
  if (status === "unknown") return "unknown";
  return "healthy";
}

function combineStates(...states: TrustState[]): TrustState {
  // unknown only wins when *all* states are unknown
  const nonUnknown = states.filter((s) => s !== "unknown");
  if (nonUnknown.length === 0) return "unknown";
  return nonUnknown.reduce<TrustState>(
    (acc, s) => (STATE_RANK[s] > STATE_RANK[acc] ? s : acc),
    "healthy",
  );
}

export function evaluateTrust(
  data: DashboardSummary | undefined,
  fetchFailed = false,
): TrustEvaluation {
  if (fetchFailed || !data) {
    return {
      state: "unknown",
      header: "Unknown",
      summary: "Trust data is not available yet.",
      blocked: { status: "unknown", ratio: null, numerator: null, denominator: null },
      failedToday: { status: "unknown", ratio: null, numerator: null, denominator: null },
      sevenDay: { ratio: null, failed: 0, total: 0, days: [] },
      agentsErrored: 0,
      agentsActive: 0,
      agentsRunning: 0,
    };
  }

  const blocked = evaluateBlocked(data.tasks);
  const failedToday = evaluateFailedToday(data.runActivity);
  const sevenDay = evaluateSevenDay(data.runActivity);

  // tasks.open=0 is treated as healthy for blocked metric per spec
  const blockedState = blocked.status === "zero" ? "healthy" : statusToState(blocked.status);
  const failedState = statusToState(failedToday.status);

  const state = combineStates(blockedState, failedState);

  let header: string;
  let summary: string;
  switch (state) {
    case "healthy":
      header = "Healthy";
      summary = "Work is flowing and runs are reliable.";
      break;
    case "needs_attention":
      header = "Needs attention";
      summary = "One trust signal is drifting above target.";
      break;
    case "critical":
      header = "Critical";
      summary = "Paperclip trust needs attention.";
      break;
    default:
      header = "Unknown";
      summary = "Trust data is not available yet.";
  }

  return {
    state,
    header,
    summary,
    blocked,
    failedToday,
    sevenDay,
    agentsErrored: data.agents?.error ?? 0,
    agentsActive: data.agents?.active ?? 0,
    agentsRunning: data.agents?.running ?? 0,
  };
}

export function formatPercent(ratio: number | null, fractionDigits = 1): string {
  if (ratio === null || !Number.isFinite(ratio)) return "Unknown";
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}
