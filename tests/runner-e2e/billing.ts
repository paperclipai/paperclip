import type {
  RunnerE2EBillingSummary,
  RunnerE2EResult,
  RunnerE2ERuntimeUsage,
  RunnerEnvironmentId,
} from "./types.js";

// Public list prices are deliberately versioned here instead of being treated
// as provider-reported charges. Credits, discounts, and Daytona's first 5 GiB
// storage allowance can make the invoice amount lower than this estimate.
export const DAYTONA_LIST_PRICING = {
  asOf: "2026-08-27",
  url: "https://www.daytona.io/pricing",
  cpuCoreHourUsd: 0.0504,
  memoryGiBHourUsd: 0.0162,
  diskGiBHourUsd: 0.000108,
} as const;

export interface RuntimeLeaseUsageInput {
  acquiredAt?: string | Date | null;
  releasedAt?: string | Date | null;
  updatedAt?: string | Date | null;
  metadata?: Record<string, unknown> | null;
}

export interface AgentRunUsageInput {
  startedAt?: string | Date | null;
  finishedAt?: string | Date | null;
}

export interface CampaignBillingSummary {
  testCount: number;
  agentRunDurationMs: number;
  leaseDurationMs: number;
  llm: RunnerE2EBillingSummary["llm"];
  reportedLlmCostUsd: number;
  estimatedRuntimeCostUsd: number;
  observedAndEstimatedCostUsd: number;
  testsWithCompleteBilling: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function firstNumber(source: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = finiteNumber(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function usageMeasurement(usage: Record<string, unknown>) {
  const candidates = [
    record(usage.runDelta),
    record(usage.total),
    record(usage.cumulative),
    usage,
  ];
  return (
    candidates.find(
      (candidate) =>
        firstNumber(candidate, [
          "inputTokens",
          "input",
          "promptTokens",
          "outputTokens",
          "output",
          "completionTokens",
        ]) !== undefined,
    ) ?? usage
  );
}

function usageCostUsd(usage: Record<string, unknown>) {
  const measurement = usageMeasurement(usage);
  const direct =
    firstNumber(usage, [
      "cacheAdjustedCostUsd",
      "costUsd",
      "providerCostUsd",
    ]) ??
    firstNumber(measurement, [
      "cacheAdjustedCostUsd",
      "costUsd",
      "providerCostUsd",
    ]);
  if (direct !== undefined) return direct;
  const cost = record(usage.cost);
  const currency =
    typeof cost.currency === "string" ? cost.currency.toUpperCase() : "USD";
  if (currency !== "USD") return undefined;
  return firstNumber(cost, ["amount", "total"]);
}

function usageEntries(
  rawUsage: Record<string, unknown> | null | undefined,
  runCount: number,
) {
  const runs = Array.isArray(rawUsage?.runs) ? rawUsage.runs : null;
  if (runs) {
    const entries = runs.map((entry) => {
      const candidate = record(entry);
      const usage = candidate.usage;
      return usage && typeof usage === "object" && !Array.isArray(usage)
        ? (usage as Record<string, unknown>)
        : null;
    });
    return [
      ...entries,
      ...Array.from(
        { length: Math.max(0, runCount - entries.length) },
        () => null,
      ),
    ];
  }
  return Array.from({ length: Math.max(1, runCount) }, (_, index) =>
    index === 0 && rawUsage ? rawUsage : null,
  );
}

function durationBetween(
  startedAt: string | Date | null | undefined,
  finishedAt: string | Date | null | undefined,
) {
  const started = startedAt ? new Date(startedAt).getTime() : Number.NaN;
  const finished = finishedAt ? new Date(finishedAt).getTime() : Number.NaN;
  return Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, finished - started)
    : 0;
}

function resourceValue(
  metadata: Record<string, unknown> | null | undefined,
  key: "cpu" | "memory" | "disk",
) {
  return finiteNumber(metadata?.[key]);
}

export function buildRuntimeUsage(input: {
  environmentId: RunnerEnvironmentId;
  runs: readonly AgentRunUsageInput[];
  leases?: readonly RuntimeLeaseUsageInput[];
  fallbackFinishedAt?: string | Date;
}): RunnerE2ERuntimeUsage {
  const agentRunDurationMs = input.runs.reduce(
    (total, run) => total + durationBetween(run.startedAt, run.finishedAt),
    0,
  );
  if (input.environmentId === "local") {
    return {
      provider: "local",
      agentRunDurationMs,
      leaseDurationMs: null,
      leaseCount: 0,
      costStatus: "not_metered",
      costSource: "local_not_metered",
    };
  }

  const leases = input.leases ?? [];
  let leaseDurationMs = 0;
  let estimatedListCostUsd = 0;
  let resourcesComplete = leases.length > 0;
  const resourceRows: Array<{ cpu: number; memory: number; disk: number }> = [];
  for (const lease of leases) {
    const finishedAt =
      lease.releasedAt ?? input.fallbackFinishedAt ?? lease.updatedAt ?? null;
    const durationMs = durationBetween(lease.acquiredAt, finishedAt);
    leaseDurationMs += durationMs;
    const cpu = resourceValue(lease.metadata, "cpu");
    const memory = resourceValue(lease.metadata, "memory");
    const disk = resourceValue(lease.metadata, "disk");
    if (cpu === undefined || memory === undefined || disk === undefined) {
      resourcesComplete = false;
      continue;
    }
    resourceRows.push({ cpu, memory, disk });
    const hours = durationMs / 3_600_000;
    estimatedListCostUsd +=
      hours *
      (cpu * DAYTONA_LIST_PRICING.cpuCoreHourUsd +
        memory * DAYTONA_LIST_PRICING.memoryGiBHourUsd +
        disk * DAYTONA_LIST_PRICING.diskGiBHourUsd);
  }
  const commonResource = (key: "cpu" | "memory" | "disk") => {
    const values = new Set(resourceRows.map((row) => row[key]));
    return values.size === 1 ? resourceRows[0]?.[key] : undefined;
  };
  return {
    provider: "daytona",
    agentRunDurationMs,
    leaseDurationMs: leases.length > 0 ? leaseDurationMs : null,
    leaseCount: leases.length,
    ...(commonResource("cpu") === undefined
      ? {}
      : { cpuCores: commonResource("cpu") }),
    ...(commonResource("memory") === undefined
      ? {}
      : { memoryGiB: commonResource("memory") }),
    ...(commonResource("disk") === undefined
      ? {}
      : { diskGiB: commonResource("disk") }),
    ...(resourcesComplete ? { estimatedListCostUsd } : {}),
    costStatus: resourcesComplete ? "estimated" : "unavailable",
    costSource: resourcesComplete
      ? "daytona_public_list_price"
      : "provider_cost_unavailable",
    ...(resourcesComplete
      ? {
          pricingAsOf: DAYTONA_LIST_PRICING.asOf,
          pricingUrl: DAYTONA_LIST_PRICING.url,
        }
      : {}),
  };
}

export function fallbackRuntimeUsage(
  result: Pick<
    RunnerE2EResult,
    "environmentId" | "durationMs" | "runtimeUsage"
  >,
) {
  if (result.runtimeUsage) return result.runtimeUsage;
  return {
    provider: result.environmentId,
    agentRunDurationMs: result.durationMs,
    leaseDurationMs: null,
    leaseCount: 0,
    costStatus:
      result.environmentId === "local" ? "not_metered" : "unavailable",
    costSource:
      result.environmentId === "local"
        ? "local_not_metered"
        : "provider_cost_unavailable",
  } satisfies RunnerE2ERuntimeUsage;
}

export function summarizeExecutionBilling(
  result: Pick<
    RunnerE2EResult,
    "runIds" | "usage" | "environmentId" | "durationMs" | "runtimeUsage"
  >,
): RunnerE2EBillingSummary {
  const requestedRunCount = Math.max(result.runIds?.length ?? 0, 1);
  const entries = usageEntries(result.usage, requestedRunCount);
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let runsWithTokenUsage = 0;
  let runsWithReportedCost = 0;
  let reportedCostUsd = 0;
  for (const usage of entries) {
    if (!usage) continue;
    const measurement = usageMeasurement(usage);
    const input =
      firstNumber(measurement, ["inputTokens", "input", "promptTokens"]) ?? 0;
    const output =
      firstNumber(measurement, [
        "outputTokens",
        "output",
        "completionTokens",
      ]) ?? 0;
    const cached =
      firstNumber(measurement, [
        "cachedInputTokens",
        "cacheReadTokens",
        "cachedReadTokens",
      ]) ?? 0;
    inputTokens += input;
    outputTokens += output;
    cachedInputTokens += cached;
    if (input > 0 || output > 0 || cached > 0) runsWithTokenUsage += 1;
    const costUsd = usageCostUsd(usage);
    if (costUsd !== undefined && (costUsd > 0 || input > 0 || output > 0)) {
      runsWithReportedCost += 1;
      reportedCostUsd += costUsd;
    }
  }
  const runCount = Math.max(requestedRunCount, entries.length);
  const costStatus =
    runsWithReportedCost === runCount
      ? "reported"
      : runsWithReportedCost > 0
        ? "partial"
        : runsWithTokenUsage > 0
          ? "unpriced"
          : "unavailable";
  const runtime = fallbackRuntimeUsage(result);
  const estimatedRuntimeCostUsd = runtime.estimatedListCostUsd ?? 0;
  const complete =
    runsWithTokenUsage === runCount &&
    runsWithReportedCost === runCount &&
    runtime.costStatus !== "unavailable";
  return {
    llm: {
      runCount,
      runsWithTokenUsage,
      runsWithReportedCost,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens: inputTokens + cachedInputTokens + outputTokens,
      reportedCostUsd,
      costStatus,
    },
    runtime,
    reportedCostUsd,
    estimatedRuntimeCostUsd,
    observedAndEstimatedCostUsd: reportedCostUsd + estimatedRuntimeCostUsd,
    complete,
  };
}

export function aggregateCampaignBilling(
  results: readonly RunnerE2EResult[],
): CampaignBillingSummary {
  const summaries = results.map(summarizeExecutionBilling);
  const runCount = summaries.reduce(
    (total, summary) => total + summary.llm.runCount,
    0,
  );
  const runsWithTokenUsage = summaries.reduce(
    (total, summary) => total + summary.llm.runsWithTokenUsage,
    0,
  );
  const runsWithReportedCost = summaries.reduce(
    (total, summary) => total + summary.llm.runsWithReportedCost,
    0,
  );
  const reportedLlmCostUsd = summaries.reduce(
    (total, summary) => total + summary.reportedCostUsd,
    0,
  );
  const estimatedRuntimeCostUsd = summaries.reduce(
    (total, summary) => total + summary.estimatedRuntimeCostUsd,
    0,
  );
  return {
    testCount: results.length,
    agentRunDurationMs: summaries.reduce(
      (total, summary) => total + summary.runtime.agentRunDurationMs,
      0,
    ),
    leaseDurationMs: summaries.reduce(
      (total, summary) => total + (summary.runtime.leaseDurationMs ?? 0),
      0,
    ),
    llm: {
      runCount,
      runsWithTokenUsage,
      runsWithReportedCost,
      inputTokens: summaries.reduce(
        (total, summary) => total + summary.llm.inputTokens,
        0,
      ),
      outputTokens: summaries.reduce(
        (total, summary) => total + summary.llm.outputTokens,
        0,
      ),
      cachedInputTokens: summaries.reduce(
        (total, summary) => total + summary.llm.cachedInputTokens,
        0,
      ),
      totalTokens: summaries.reduce(
        (total, summary) => total + summary.llm.totalTokens,
        0,
      ),
      reportedCostUsd: reportedLlmCostUsd,
      costStatus:
        runsWithReportedCost === runCount
          ? "reported"
          : runsWithReportedCost > 0
            ? "partial"
            : runsWithTokenUsage > 0
              ? "unpriced"
              : "unavailable",
    },
    reportedLlmCostUsd,
    estimatedRuntimeCostUsd,
    observedAndEstimatedCostUsd: reportedLlmCostUsd + estimatedRuntimeCostUsd,
    testsWithCompleteBilling: summaries.filter((summary) => summary.complete)
      .length,
  };
}
