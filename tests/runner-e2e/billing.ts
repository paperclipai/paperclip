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
  assistant?: import("./types.js").RunnerE2EAggregateBillingSummary["assistant"];
  judge?: import("./types.js").RunnerE2EJudgeBillingSummary;
  testCount: number;
  agentRunDurationMs: number;
  leaseDurationMs: number;
  llm: RunnerE2EBillingSummary["llm"];
  reportedLlmCostUsd: number;
  estimatedLlmCostUsd?: number;
  estimatedRuntimeCostUsd: number;
  observedAndEstimatedCostUsd: number | null;
  testsWithCompleteBilling: number;
}

/** Render observed subtotals without presenting absent measurements as zero. */
export function billingCoverageLabel(value: string, covered: number, total: number): string {
  if (!Number.isInteger(covered) || !Number.isInteger(total) || covered <= 0 || total <= 0 || covered > total) {
    return "Unavailable";
  }
  return covered < total ? `${value} (partial: ${covered}/${total} runs)` : value;
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

function exactUsd(value: unknown): number | undefined {
  // Receipts use decimal USD strings. Do not accept coercions, scientific
  // notation, infinities, or values that lose their recorded precision.
  if (typeof value !== "string" || value !== value.trim() || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return undefined;
  const amount = Number(value);
  const normalized = value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  const [mantissa, exponent] = String(amount).split("e");
  const digits = mantissa!.replace(".", "");
  const position = (mantissa!.split(".")[0]!.length) + Number(exponent ?? 0);
  const decimal = exponent === undefined ? mantissa : position <= 0
    ? `0.${"0".repeat(-position)}${digits}`
    : position >= digits.length ? digits + "0".repeat(position - digits.length)
      : `${digits.slice(0, position)}.${digits.slice(position)}`;
  return Number.isFinite(amount) && amount <= Number.MAX_SAFE_INTEGER && decimal === normalized
    ? amount : undefined;
}

function usageCostUsd(usage: Record<string, unknown>): { amount: number; estimate?: { source: "rate_card"; version: string } } | undefined {
  const measurement = usageMeasurement(usage);
  const sources = [usage, measurement];
  if (sources.some(source => source.accountingReceiptReady === false || source.runDeltaComplete === false || source.complete === false || ["unpriced", "unavailable"].includes(String(source.costStatus)))) return undefined;
  const status = usage.costStatus ?? measurement.costStatus;
  if (status != null && status !== "reported" && status !== "estimated") return undefined;
  const exact = usage.costUsdExact ?? measurement.costUsdExact;
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
  if (status === "estimated") {
    const provenance = record(usage.pricingProvenance ?? measurement.pricingProvenance);
    const amount = exact == null ? direct : exactUsd(exact);
    if ((usage.accountingReceiptReady ?? measurement.accountingReceiptReady) !== true ||
        provenance.source !== "rate_card" || typeof provenance.version !== "string" || !provenance.version.trim() ||
        amount === undefined) return undefined;
    return { amount, estimate: { source: "rate_card", version: provenance.version } };
  }
  if (direct !== undefined) return { amount: direct };
  if (exact != null) {
    const amount = exactUsd(exact);
    return status === "reported" && (usage.accountingReceiptReady ?? measurement.accountingReceiptReady) === true && amount !== undefined ? { amount } : undefined;
  }
  const cost = record(usage.cost);
  const currency =
    typeof cost.currency === "string" ? cost.currency.toUpperCase() : "USD";
  if (currency !== "USD") return undefined;
  const amount = firstNumber(cost, ["amount", "total"]);
  return amount === undefined ? undefined : { amount };
}

function llmCostStatus(runCount: number, reported: number, estimated: number, measured: number): RunnerE2EBillingSummary["llm"]["costStatus"] {
  if (reported === runCount) return "reported";
  if (reported + estimated === runCount && estimated > 0) return "estimated";
  if (reported + estimated > 0) return "partial";
  return measured > 0 ? "unpriced" : "unavailable";
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
    "runIds" | "usage" | "environmentId" | "durationMs" | "runtimeUsage" | "firstTaskQuality" | "completionQuality" | "publicMcp"
  >,
): RunnerE2EBillingSummary {
  const requestedRunCount = Math.max(result.runIds?.length ?? 0, 1);
  const entries = usageEntries(result.usage, requestedRunCount);
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let runsWithTokenUsage = 0;
  let runsWithReportedCost = 0;
  let runsWithEstimatedCost = 0;
  let reportedCostUsd = 0;
  let estimatedLlmCostUsd = 0;
  const estimates = new Map<string, { source: "rate_card"; version: string }>();
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
    if (costUsd !== undefined && (costUsd.amount > 0 || input > 0 || output > 0 || cached > 0)) {
      if (costUsd.estimate) {
        runsWithEstimatedCost += 1;
        estimatedLlmCostUsd += costUsd.amount;
        estimates.set(costUsd.estimate.version, costUsd.estimate);
      } else {
        runsWithReportedCost += 1;
        reportedCostUsd += costUsd.amount;
      }
    }
  }
  const runCount = Math.max(requestedRunCount, entries.length);
  const costStatus = llmCostStatus(runCount, runsWithReportedCost, runsWithEstimatedCost, runsWithTokenUsage);
  const runtime = fallbackRuntimeUsage(result);
  const estimatedRuntimeCostUsd = runtime.estimatedListCostUsd ?? 0;
  const judgments = [...(result.firstTaskQuality ? [result.firstTaskQuality] : []), ...(result.completionQuality ?? [])];
  const sumKnown = (key: "inputTokens" | "outputTokens" | "estimatedCostUsd") => judgments.some(q => q[key] === null) ? null : judgments.reduce((sum, q) => sum + (q[key] ?? 0), 0);
  const quality = judgments.length ? { inputTokens: sumKnown("inputTokens"), outputTokens: sumKnown("outputTokens"), estimatedCostUsd: sumKnown("estimatedCostUsd"), reservedCostUsd: judgments.reduce((sum, q) => sum + q.reservedCostUsd, 0) } : undefined;
  const complete =
    (!quality || quality.estimatedCostUsd !== null) &&
    runsWithTokenUsage === runCount &&
    runsWithReportedCost + runsWithEstimatedCost === runCount &&
    runtime.costStatus !== "unavailable";
  return {
    ...(result.publicMcp ? { assistant: result.publicMcp } : {}),
    llm: {
      runCount,
      runsWithTokenUsage,
      runsWithReportedCost,
      runsWithEstimatedCost,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens: inputTokens + cachedInputTokens + outputTokens,
      reportedCostUsd,
      estimatedCostUsd: estimatedLlmCostUsd,
      estimateProvenance: [...estimates.values()],
      costStatus,
    },
    runtime,
    reportedCostUsd,
    estimatedLlmCostUsd,
    estimatedRuntimeCostUsd,
    ...(quality ? { judge: { inputTokens: quality.inputTokens, outputTokens: quality.outputTokens, estimatedCostUsd: quality.estimatedCostUsd, reservedCostUsd: quality.reservedCostUsd } } : {}),
    observedAndEstimatedCostUsd: quality?.estimatedCostUsd === null ? null : reportedCostUsd + estimatedLlmCostUsd + estimatedRuntimeCostUsd + (quality?.estimatedCostUsd ?? 0) + (result.publicMcp?.estimatedCostUsd ?? 0),
    complete,
  };
}

export function aggregateCampaignBilling(
  results: readonly RunnerE2EResult[],
): CampaignBillingSummary {
  // Connection journeys retain a sanitized billing projection instead of raw
  // provider usage. Recompute when usage exists; otherwise preserve that
  // measured projection, including incomplete probe coverage.
  const summaries = results.map(result => result.usage
    ? summarizeExecutionBilling(result)
    : result.billing ?? summarizeExecutionBilling(result));
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
  const runsWithEstimatedCost = summaries.reduce((total, summary) => total + (summary.llm.runsWithEstimatedCost ?? 0), 0);
  const estimatedLlmCostUsd = summaries.reduce((total, summary) => total + (summary.estimatedLlmCostUsd ?? 0), 0);
  const estimateProvenance = [...new Map(summaries.flatMap(summary => summary.llm.estimateProvenance ?? []).map(source => [source.version, source])).values()];
  const estimatedRuntimeCostUsd = summaries.reduce(
    (total, summary) => total + summary.estimatedRuntimeCostUsd,
    0,
  );
  const judges = summaries.flatMap(summary => summary.judge ? [summary.judge] : []);
  const assistants = summaries.flatMap(summary => summary.assistant ? [summary.assistant] : []);
  return {
    ...(assistants.length ? { assistant: {
      requests: assistants.reduce((n, u) => n + u.requests, 0),
      inputTokens: assistants.reduce((n, u) => n + u.inputTokens, 0),
      outputTokens: assistants.reduce((n, u) => n + u.outputTokens, 0),
      cachedInputTokens: assistants.reduce((n, u) => n + u.cachedInputTokens, 0),
      estimatedCostUsd: assistants.reduce((n, u) => n + u.estimatedCostUsd, 0),
    } } : {}),
    ...(judges.length ? { judge: {
      attempts: judges.length,
      inputTokens: judges.reduce((n, q) => n + (q.inputTokens ?? 0), 0),
      outputTokens: judges.reduce((n, q) => n + (q.outputTokens ?? 0), 0),
      estimatedCostUsd: judges.some(q => q.estimatedCostUsd === null) ? null : judges.reduce((n, q) => n + (q.estimatedCostUsd ?? 0), 0),
      reservedCostUsd: judges.reduce((n, q) => n + q.reservedCostUsd, 0),
      attemptsWithUnknownUsage: judges.filter(q => q.estimatedCostUsd === null).length,
    } } : {}),
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
      runsWithEstimatedCost,
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
      estimatedCostUsd: estimatedLlmCostUsd,
      estimateProvenance,
      costStatus: llmCostStatus(runCount, runsWithReportedCost, runsWithEstimatedCost, runsWithTokenUsage),
    },
    reportedLlmCostUsd,
    estimatedLlmCostUsd,
    estimatedRuntimeCostUsd,
    observedAndEstimatedCostUsd: summaries.some(s => s.observedAndEstimatedCostUsd === null) ? null : summaries.reduce((total, summary) => total + (summary.observedAndEstimatedCostUsd ?? 0), 0),
    testsWithCompleteBilling: summaries.filter((summary) => summary.complete)
      .length,
  };
}
