import { readFile } from 'node:fs/promises';
import type { UsageSummary } from '@paperclipai/adapter-utils';
import { getModelCost, type ParsedModelCost } from './models.js';

export interface RunUsageAndCost {
  sessionId: string | null;
  usage?: UsageSummary;
  usageBasis?: 'per_run';
  costUsd: number | null;
  cacheAdjustedCostUsd?: number | null;
  billingType: 'metered_api' | 'subscription_included' | 'unknown';
  biller: string;
  provider: string;
  model: string | null;
  resultJson: Record<string, unknown>;
}

export interface TranscriptMetrics {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  generationModel: string | null;
  modelName: string | null;
}

interface StepMetrics {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  generationModel: string | null;
}

export interface ModelCostBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number | null;
}

function toFinite(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function readStepMetrics(step: unknown): StepMetrics | null {
  if (typeof step !== 'object' || step === null || Array.isArray(step)) return null;
  const s = step as Record<string, unknown>;
  const m =
    s.metrics && typeof s.metrics === 'object' && !Array.isArray(s.metrics)
      ? (s.metrics as Record<string, unknown>)
      : null;
  if (!m) return null;
  const extra =
    s.extra && typeof s.extra === 'object' && !Array.isArray(s.extra)
      ? (s.extra as Record<string, unknown>)
      : null;
  return {
    promptTokens: toFinite(m.prompt_tokens),
    completionTokens: toFinite(m.completion_tokens),
    cachedTokens: toFinite(m.cached_tokens),
    generationModel: nonEmptyString(extra?.generation_model),
  };
}

/** Cumulative totals captured at the end of the previous run on this session,
 * persisted in sessionParams so a resumed run can bill only its own delta.
 * A resumed ATIF is cumulative — verified live 2026-09-03 (two-turn probe on
 * session raspy-wholesaler: turn-1 run recorded 318549 prompt tokens; the
 * resumed ATIF's final_metrics total_prompt_tokens was 366918 and its first
 * step was turn 1's prompt, full history). */
export interface ResumeBaseline {
  totalSteps: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
}

export function readResumeBaseline(value: unknown): ResumeBaseline | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const r = value as Record<string, unknown>;
  const totalSteps = Number(r.totalSteps);
  if (!Number.isFinite(totalSteps)) return null;
  return {
    totalSteps,
    totalPromptTokens: toFinite(r.totalPromptTokens),
    totalCompletionTokens: toFinite(r.totalCompletionTokens),
    totalCachedTokens: toFinite(r.totalCachedTokens),
  };
}

async function readAtifMetrics(
  atifPath: string,
  opts: { skipSteps?: number } = {},
): Promise<{
  sessionId: string | null;
  metrics: TranscriptMetrics | null;
  steps: StepMetrics[];
  totalSteps: number;
}> {
  try {
    const raw = await readFile(atifPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sessionId =
      typeof parsed.session_id === 'string' ? parsed.session_id : null;

    const finalMetrics = (parsed.final_metrics ?? {}) as Record<string, unknown>;
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const totalSteps = toFinite(finalMetrics.total_steps) || rawSteps.length;
    const steps = rawSteps
      .slice(Math.max(0, opts.skipSteps ?? 0))
      .map(readStepMetrics)
      .filter((s): s is StepMetrics => s !== null);
    const lastStep = (Array.isArray(parsed.steps) ? parsed.steps : []).at(-1) as
      | Record<string, unknown>
      | undefined;
    const lastStepMetrics =
      lastStep?.metrics && typeof lastStep.metrics === 'object' && !Array.isArray(lastStep.metrics)
        ? (lastStep.metrics as Record<string, unknown>)
        : null;
    const hasFinalMetrics =
      'total_prompt_tokens' in finalMetrics ||
      'total_completion_tokens' in finalMetrics ||
      'total_cached_tokens' in finalMetrics;

    const lastStepExtra = (lastStep?.extra ?? {}) as Record<string, unknown>;
    const generationModel =
      nonEmptyString(lastStepExtra.generation_model) ??
      nonEmptyString(parsed.generation_model);

    const modelName =
      nonEmptyString(lastStep?.model_name) ?? nonEmptyString(parsed.model_name);

    const metrics: TranscriptMetrics = {
      inputTokens: hasFinalMetrics
        ? toFinite(finalMetrics.total_prompt_tokens)
        : toFinite(lastStepMetrics?.prompt_tokens),
      outputTokens: hasFinalMetrics
        ? toFinite(finalMetrics.total_completion_tokens)
        : toFinite(lastStepMetrics?.completion_tokens),
      cachedTokens: hasFinalMetrics
        ? toFinite(finalMetrics.total_cached_tokens)
        : toFinite(lastStepMetrics?.cached_tokens),
      generationModel,
      modelName,
    };

    return { sessionId, metrics, steps, totalSteps };
  } catch {
    return { sessionId: null, metrics: null, steps: [], totalSteps: 0 };
  }
}

/**
 * Cost of a token block at one model's catalog rates. ATIF `prompt_tokens`
 * is cache-inclusive (verified against live transcripts), so cached tokens are
 * subtracted before the input rate is applied: the catalog publishes only
 * In/Out rates, and cached reads are never billed at the full input rate.
 */
export function computeCostUsd(
  metrics: TranscriptMetrics,
  cost: ParsedModelCost | null,
): number | null {
  if (!cost || (cost.isUnknown && !cost.isFree)) {
    return null;
  }
  if (cost.isFree) return 0;
  const cachedTokens = Math.max(
    0,
    Number.isFinite(metrics.cachedTokens) ? metrics.cachedTokens : 0,
  );
  const inputTokens = Math.max(
    0,
    (Number.isFinite(metrics.inputTokens) ? metrics.inputTokens : 0) -
      cachedTokens,
  );
  const outputTokens = Math.max(
    0,
    Number.isFinite(metrics.outputTokens) ? metrics.outputTokens : 0,
  );
  // Cached reads bill at the published cache rate when the catalog offers
  // one (current format); on the legacy format (no cache rate) they are
  // excluded from billing entirely. Either way they are never billed at the
  // full input rate.
  const cachedCost =
    cost.cachedInputCostPerMTok != null
      ? (cachedTokens * cost.cachedInputCostPerMTok) / 1_000_000
      : 0;
  const inputCost = (inputTokens * cost.inputCostPerMTok) / 1_000_000;
  const outputCost = (outputTokens * cost.outputCostPerMTok) / 1_000_000;
  const total = inputCost + cachedCost + outputCost;
  return Number.isFinite(total) ? Number(total.toFixed(6)) : null;
}

function resolveActualModel(
  requestedModel: string,
  metrics: TranscriptMetrics | null,
): string {
  return (
    metrics?.generationModel ??
    metrics?.modelName ??
    (requestedModel || 'adaptive')
  );
}

export async function resolveRunUsageAndCost(options: {
  atifPath: string;
  requestedModel: string;
  command?: string;
  /** When set (a resumed session), only steps past the baseline are priced
   * and reported usage is the delta — resumed ATIFs are cumulative. */
  resumeBaseline?: ResumeBaseline | null;
}): Promise<RunUsageAndCost> {
  const { atifPath, requestedModel, command = 'devin' } = options;
  // Baselines arrive from stored session state — untrusted JSON, so validate
  // the shape here rather than trusting the caller (D-10).
  const resumeBaseline = readResumeBaseline(options.resumeBaseline);

  const empty: RunUsageAndCost = {
    sessionId: null,
    costUsd: null,
    cacheAdjustedCostUsd: null,
    billingType: 'unknown',
    biller: 'devin',
    provider: 'devin',
    model: requestedModel || null,
    resultJson: {},
  };

  const { sessionId, metrics: rawMetrics, steps, totalSteps } = await readAtifMetrics(
    atifPath,
    { skipSteps: resumeBaseline?.totalSteps ?? 0 },
  );
  if (!rawMetrics) {
    return { ...empty, sessionId };
  }
  // Delta the cumulative transcript against the previous run's baseline so a
  // resumed session bills only its own turn.
  const metrics: TranscriptMetrics = resumeBaseline
    ? {
        inputTokens: Math.max(0, rawMetrics.inputTokens - resumeBaseline.totalPromptTokens),
        outputTokens: Math.max(0, rawMetrics.outputTokens - resumeBaseline.totalCompletionTokens),
        cachedTokens: Math.max(0, rawMetrics.cachedTokens - resumeBaseline.totalCachedTokens),
        generationModel: rawMetrics.generationModel,
        modelName: rawMetrics.modelName,
      }
    : rawMetrics;

  const actualModel = resolveActualModel(requestedModel, metrics);

  // Price per generating step at that step's model rates. A step without a
  // generation_model inherits the nearest earlier generating step's model
  // (tool/intermediate steps run inside the same model context).
  const perModel = new Map<string, ModelCostBreakdown>();
  let carriedModel: string | null = null;
  for (const step of steps) {
    if (step.generationModel) carriedModel = step.generationModel;
    if (
      step.promptTokens === 0 &&
      step.completionTokens === 0 &&
      step.cachedTokens === 0
    ) {
      continue;
    }
    const model = step.generationModel ?? carriedModel ?? actualModel;
    const entry = perModel.get(model) ?? {
      model,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
    };
    entry.inputTokens += step.promptTokens;
    entry.outputTokens += step.completionTokens;
    entry.cachedTokens += step.cachedTokens;
    perModel.set(model, entry);
  }

  // Coverage guard: per-step pricing is only trusted when the step sums
  // exactly cover the authoritative final_metrics totals (verified to hold
  // on live transcripts). ATIFs with NO per-step metrics price the aggregate
  // at the resolved actual model. PARTIAL coverage means some tokens' model
  // is unknowable — report unknown rather than a partial sum or a guess.
  let stepInput = 0;
  let stepOutput = 0;
  let stepCached = 0;
  for (const entry of perModel.values()) {
    stepInput += entry.inputTokens;
    stepOutput += entry.outputTokens;
    stepCached += entry.cachedTokens;
  }
  const hasStepMetrics = perModel.size > 0;
  const stepsCoverTotals =
    hasStepMetrics &&
    stepInput === metrics.inputTokens &&
    stepOutput === metrics.outputTokens &&
    stepCached === metrics.cachedTokens;

  if (hasStepMetrics && !stepsCoverTotals) {
    const breakdownPartial: ModelCostBreakdown[] = [
      ...[...perModel.values()].map((entry) => ({ ...entry, costUsd: null })),
      {
        model: 'unknown',
        inputTokens: Math.max(0, metrics.inputTokens - stepInput),
        outputTokens: Math.max(0, metrics.outputTokens - stepOutput),
        cachedTokens: Math.max(0, metrics.cachedTokens - stepCached),
        costUsd: null,
      },
    ];
    return {
      sessionId,
      usage: {
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cachedInputTokens: metrics.cachedTokens,
      },
      usageBasis: 'per_run',
      costUsd: null,
      cacheAdjustedCostUsd: null,
      billingType: 'unknown',
      biller: 'devin',
      provider: 'devin',
      model: actualModel || requestedModel || null,
      resultJson: {
        devinSessionId: sessionId,
        devinRequestedModel: requestedModel,
        devinActualModel: actualModel,
        devinTotalSteps: totalSteps,
        // The current run's cost is unknown on partial coverage, but the
        // cumulative totals must still persist or the next resume double-bills.
        devinCumulative: {
          totalSteps,
          totalPromptTokens: rawMetrics.inputTokens,
          totalCompletionTokens: rawMetrics.outputTokens,
          totalCachedTokens: rawMetrics.cachedTokens,
        },
        devinTranscriptMetrics: {
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          cachedTokens: metrics.cachedTokens,
          generationModel: metrics.generationModel,
          modelName: metrics.modelName,
        },
        devinModelBreakdown: breakdownPartial,
        devinCoverageGap: true,
      },
    };
  }

  if (!hasStepMetrics) {
    perModel.set(actualModel, {
      model: actualModel,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cachedTokens: metrics.cachedTokens,
      costUsd: 0,
    });
  }

  const costByModel = new Map<string, ParsedModelCost | null>(
    await Promise.all(
      [...perModel.keys()].map(
        async (model) =>
          [model, await getModelCost(model, command).catch(() => null)] as const,
      ),
    ),
  );

  const breakdown: ModelCostBreakdown[] = [];
  let total = 0;
  let anyUnknown = false;
  let anyPriced = false;
  for (const entry of perModel.values()) {
    const cost = costByModel.get(entry.model) ?? null;
    const stepCost = computeCostUsd(
      {
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cachedTokens: entry.cachedTokens,
        generationModel: null,
        modelName: null,
      },
      cost,
    );
    if (stepCost === null) anyUnknown = true;
    if (cost && !cost.isFree && !cost.isUnknown) anyPriced = true;
    breakdown.push({ ...entry, costUsd: stepCost });
    total += stepCost ?? 0;
  }

  // Never silently under-report: one unknown model nulls the run's cost
  // instead of shipping a partial sum.
  const costUsd = anyUnknown ? null : Number(total.toFixed(6));

  const usage: UsageSummary = {
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cachedInputTokens: metrics.cachedTokens,
  };

  let billingType: RunUsageAndCost['billingType'];
  if (anyUnknown) {
    billingType = 'unknown';
  } else if (anyPriced) {
    billingType = 'metered_api';
  } else {
    billingType = 'subscription_included';
  }

  const resultJson: Record<string, unknown> = {
    devinSessionId: sessionId,
    devinRequestedModel: requestedModel,
    devinActualModel: actualModel,
    devinTotalSteps: totalSteps,
    devinCumulative: {
      totalSteps,
      totalPromptTokens: rawMetrics.inputTokens,
      totalCompletionTokens: rawMetrics.outputTokens,
      totalCachedTokens: rawMetrics.cachedTokens,
    },
    ...(resumeBaseline ? { devinResumeDelta: true } : {}),
    devinTranscriptMetrics: {
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cachedTokens: metrics.cachedTokens,
      generationModel: metrics.generationModel,
      modelName: metrics.modelName,
    },
    devinModelBreakdown: breakdown,
  };

  return {
    sessionId,
    usage,
    usageBasis: 'per_run',
    costUsd,
    // Cached reads are billed at the published cache rate when one exists
    // (or excluded on legacy catalogs) — never at the full input rate — so
    // the computed figure IS the post-cache-discount amount per the
    // adapter-utils contract.
    cacheAdjustedCostUsd: costUsd,
    billingType,
    biller: 'devin',
    provider: 'devin',
    model: actualModel || requestedModel || null,
    resultJson,
  };
}
