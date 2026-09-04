import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const getModelCost = vi.hoisted(() => vi.fn());

vi.mock('./models.js', async () => {
  const actual = await vi.importActual<typeof import('./models.js')>('./models.js');
  return { ...actual, getModelCost };
});

import { resolveRunUsageAndCost, computeCostUsd } from './usage.js';

describe('computeCostUsd', () => {
  it('returns 0 for free models', () => {
    const cost = computeCostUsd(
      { inputTokens: 1000, outputTokens: 500, cachedTokens: 0, generationModel: null, modelName: null },
      { inputCostPerMTok: 0, outputCostPerMTok: 0, isFree: true },
    );
    expect(cost).toBe(0);
  });

  it('returns null for unknown costs', () => {
    const cost = computeCostUsd(
      { inputTokens: 1000, outputTokens: 500, cachedTokens: 0, generationModel: null, modelName: null },
      { inputCostPerMTok: 0, outputCostPerMTok: 0, isFree: false, isUnknown: true },
    );
    expect(cost).toBeNull();
  });

  it('computes metered cost', () => {
    const cost = computeCostUsd(
      { inputTokens: 2_000_000, outputTokens: 1_000_000, cachedTokens: 0, generationModel: null, modelName: null },
      { inputCostPerMTok: 5, outputCostPerMTok: 25, isFree: false },
    );
    expect(cost).toBe(35);
  });

  it('bills cached tokens at the published cache rate when the catalog offers one', () => {
    // prompt_tokens is cache-inclusive: 2M prompt of which 1.5M cached.
    const cost = computeCostUsd(
      { inputTokens: 2_000_000, outputTokens: 1_000_000, cachedTokens: 1_500_000, generationModel: null, modelName: null },
      { inputCostPerMTok: 5, cachedInputCostPerMTok: 0.5, outputCostPerMTok: 25, isFree: false },
    );
    // (2M - 1.5M) * $5/MTok + 1.5M * $0.5/MTok + 1M * $25/MTok = $2.50 + $0.75 + $25
    expect(cost).toBe(28.25);
  });

  it('never bills cached tokens at the full input rate', () => {
    // prompt_tokens is cache-inclusive: 2M prompt of which 1.5M cached.
    const cost = computeCostUsd(
      { inputTokens: 2_000_000, outputTokens: 1_000_000, cachedTokens: 1_500_000, generationModel: null, modelName: null },
      { inputCostPerMTok: 5, outputCostPerMTok: 25, isFree: false },
    );
    // (2M - 1.5M) * $5/MTok + 1M * $25/MTok = $2.50 + $25
    expect(cost).toBe(27.5);
  });
});

describe('resolveRunUsageAndCost', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'devin-usage-'));
    getModelCost.mockReset();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAtif(payload: Record<string, unknown>): string {
    const p = path.join(tmpDir, 'run.atif');
    writeFileSync(p, JSON.stringify(payload), 'utf8');
    return p;
  }

  it('parses token counts from an ATIF file', async () => {
    const atif = writeAtif({
      session_id: 'session-abc',
      final_metrics: {
        total_prompt_tokens: 100,
        total_completion_tokens: 50,
        total_cached_tokens: 10,
      },
    });
    getModelCost.mockResolvedValue({
      inputCostPerMTok: 0,
      outputCostPerMTok: 0,
      isFree: true,
    });
    const result = await resolveRunUsageAndCost({
      atifPath: atif,
      requestedModel: 'swe-1-7',
    });
    expect(result.sessionId).toBe('session-abc');
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 10,
    });
    expect(result.billingType).toBe('subscription_included');
    expect(result.costUsd).toBe(0);
  });

  it('prices only the delta when resuming with a baseline (resumed ATIFs are cumulative)', async () => {
    // Two turns in one cumulative transcript: turn 1 = 100 in/50 out/10 cached,
    // turn 2 = 40 in/20 out/5 cached. Baseline = turn-1 totals.
    const atif = writeAtif({
      session_id: 'session-abc',
      steps: [
        { metrics: { prompt_tokens: 60, completion_tokens: 30, cached_tokens: 10 }, extra: { generation_model: 'swe-1-7' } },
        { metrics: { prompt_tokens: 40, completion_tokens: 20, cached_tokens: 0 }, extra: { generation_model: 'swe-1-7' } },
        { metrics: { prompt_tokens: 25, completion_tokens: 15, cached_tokens: 3 }, extra: { generation_model: 'swe-1-7' } },
        { metrics: { prompt_tokens: 15, completion_tokens: 5, cached_tokens: 2 }, extra: { generation_model: 'swe-1-7' } },
      ],
      final_metrics: {
        total_steps: 4,
        total_prompt_tokens: 140,
        total_completion_tokens: 70,
        total_cached_tokens: 15,
      },
    });
    getModelCost.mockResolvedValue({
      inputCostPerMTok: 0,
      outputCostPerMTok: 0,
      isFree: true,
    });
    const result = await resolveRunUsageAndCost({
      atifPath: atif,
      requestedModel: 'swe-1-7',
      resumeBaseline: {
        totalSteps: 2,
        totalPromptTokens: 100,
        totalCompletionTokens: 50,
        totalCachedTokens: 10,
      },
    });
    expect(result.usage).toEqual({
      inputTokens: 40,
      outputTokens: 20,
      cachedInputTokens: 5,
    });
    // devinCumulative carries the FULL transcript totals so the next resume
    // can baseline against this run.
    expect(result.resultJson.devinCumulative).toEqual({
      totalSteps: 4,
      totalPromptTokens: 140,
      totalCompletionTokens: 70,
      totalCachedTokens: 15,
    });
    expect(result.resultJson.devinResumeDelta).toBe(true);
  });

  it('ignores a malformed baseline and prices the whole transcript', async () => {
    const atif = writeAtif({
      session_id: 'session-abc',
      final_metrics: {
        total_prompt_tokens: 100,
        total_completion_tokens: 50,
        total_cached_tokens: 10,
      },
    });
    getModelCost.mockResolvedValue({
      inputCostPerMTok: 0,
      outputCostPerMTok: 0,
      isFree: true,
    });
    const result = await resolveRunUsageAndCost({
      atifPath: atif,
      requestedModel: 'swe-1-7',
      resumeBaseline: { totalSteps: Number.NaN } as never,
    });
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 10,
    });
  });

  it('prefers the generation model from the last step', async () => {
    const atif = writeAtif({
      session_id: 'session-xyz',
      final_metrics: {
        total_prompt_tokens: 1,
        total_completion_tokens: 1,
        total_cached_tokens: 0,
      },
      steps: [{ extra: { generation_model: 'claude-opus-5-high' } }],
    });
    getModelCost.mockResolvedValue({
      inputCostPerMTok: 5,
      outputCostPerMTok: 25,
      isFree: false,
    });
    const result = await resolveRunUsageAndCost({
      atifPath: atif,
      requestedModel: 'swe-1-7',
    });
    expect(result.model).toBe('claude-opus-5-high');
    expect(result.billingType).toBe('metered_api');
    expect(result.resultJson.devinActualModel).toBe('claude-opus-5-high');
  });

  it('returns empty usage when the ATIF file is missing', async () => {
    const result = await resolveRunUsageAndCost({
      atifPath: path.join(tmpDir, 'missing.atif'),
      requestedModel: 'swe-1-7',
    });
    expect(result.sessionId).toBeNull();
    expect(result.usage).toBeUndefined();
    expect(result.billingType).toBe('unknown');
  });

  it('prices each step at its own model rates and excludes cached tokens', async () => {
    const atif = writeAtif({
      session_id: 'session-mixed',
      final_metrics: {
        total_prompt_tokens: 2_000_000,
        total_completion_tokens: 1_000_000,
        total_cached_tokens: 500_000,
      },
      steps: [
        {
          metrics: { prompt_tokens: 1_000_000, completion_tokens: 0, cached_tokens: 500_000 },
          extra: { generation_model: 'claude-opus-5-high' },
        },
        {
          metrics: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, cached_tokens: 0 },
          extra: { generation_model: 'swe-1-7' },
        },
      ],
    });
    getModelCost.mockImplementation(async (model: string) =>
      model === 'claude-opus-5-high'
        ? { inputCostPerMTok: 5, outputCostPerMTok: 25, isFree: false }
        : { inputCostPerMTok: 0, outputCostPerMTok: 0, isFree: true },
    );
    const result = await resolveRunUsageAndCost({
      atifPath: atif,
      requestedModel: 'swe-1-7',
    });
    // opus step: (1M - 0.5M cached) * $5 = $2.50; swe step: free. Total $2.50,
    // NOT $35 (aggregate at opus rates) and NOT including cached at full rate.
    expect(result.costUsd).toBe(2.5);
    expect(result.cacheAdjustedCostUsd).toBe(2.5);
    expect(result.billingType).toBe('metered_api');
    const breakdown = result.resultJson.devinModelBreakdown as Array<Record<string, unknown>>;
    expect(breakdown).toHaveLength(2);
    expect(breakdown[0]).toMatchObject({ model: 'claude-opus-5-high', costUsd: 2.5, cachedTokens: 500_000 });
    expect(breakdown[1]).toMatchObject({ model: 'swe-1-7', costUsd: 0 });
  });

  it('falls back to aggregate pricing when step sums do not cover final_metrics', async () => {
    const atif = writeAtif({
      session_id: 'session-partial',
      final_metrics: {
        total_prompt_tokens: 2_000_000,
        total_completion_tokens: 1_000_000,
        total_cached_tokens: 500_000,
      },
      steps: [
        // Only half the tokens are covered by step metrics.
        {
          metrics: { prompt_tokens: 1_000_000, completion_tokens: 500_000, cached_tokens: 250_000 },
          extra: { generation_model: 'swe-1-7' },
        },
      ],
    });
    getModelCost.mockImplementation(async (model: string) =>
      model === 'claude-opus-5-high'
        ? { inputCostPerMTok: 5, outputCostPerMTok: 25, isFree: false }
        : { inputCostPerMTok: 0, outputCostPerMTok: 0, isFree: true },
    );
    const result = await resolveRunUsageAndCost({
      atifPath: atif,
      requestedModel: 'claude-opus-5-high',
    });
    // Partial coverage means the uncovered tokens' model is unknowable; the
    // run reports unknown rather than a partial sum or a guessed model.
    expect(result.costUsd).toBeNull();
    expect(result.cacheAdjustedCostUsd).toBeNull();
    expect(result.billingType).toBe('unknown');
    // Usage totals still come from the authoritative final_metrics.
    expect(result.usage).toEqual({
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 500_000,
    });
  });

  it('reports null cost when any generating step model has unknown rates', async () => {
    const atif = writeAtif({
      session_id: 'session-unknown',
      final_metrics: { total_prompt_tokens: 10, total_completion_tokens: 5, total_cached_tokens: 0 },
      steps: [
        { metrics: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 0 }, extra: { generation_model: 'future-model' } },
      ],
    });
    getModelCost.mockResolvedValue(null);
    const result = await resolveRunUsageAndCost({ atifPath: atif, requestedModel: 'swe-1-7' });
    expect(result.costUsd).toBeNull();
    expect(result.cacheAdjustedCostUsd).toBeNull();
    expect(result.billingType).toBe('unknown');
  });

  it('carries a step with no generation_model at the nearest earlier generating model', async () => {
    const atif = writeAtif({
      session_id: 'session-carry',
      final_metrics: { total_prompt_tokens: 2_000_000, total_completion_tokens: 0, total_cached_tokens: 0 },
      steps: [
        { metrics: { prompt_tokens: 1_000_000, completion_tokens: 0, cached_tokens: 0 }, extra: { generation_model: 'claude-opus-5-high' } },
        { metrics: { prompt_tokens: 1_000_000, completion_tokens: 0, cached_tokens: 0 }, extra: {} },
      ],
    });
    getModelCost.mockResolvedValue({ inputCostPerMTok: 5, outputCostPerMTok: 25, isFree: false });
    const result = await resolveRunUsageAndCost({ atifPath: atif, requestedModel: 'swe-1-7' });
    expect(result.costUsd).toBe(10);
    expect(getModelCost).toHaveBeenCalledWith('claude-opus-5-high', expect.anything());
  });
});
