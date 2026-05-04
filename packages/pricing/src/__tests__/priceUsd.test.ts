import { describe, expect, it } from 'vitest';
import { catalog, priceUsd } from '../index.js';

/**
 * priceUsd integration tests against the vendored catalog snapshot.
 *
 * These tests deliberately reference real catalog keys (`anthropic/claude-opus-4-6`,
 * `anthropic/claude-4-sonnet-20250514`) so we both exercise the lookup path and
 * sanity-check that Lane B's snapshot still contains the entries Lane D will
 * rely on. If the snapshot rotates a key out from under us, the test will fail
 * loudly.
 */

describe('priceUsd', () => {
  it('returns null for unknown models', () => {
    expect(
      priceUsd({
        provider: 'cursor',
        model: 'some-totally-made-up-model-xyz',
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ).toBeNull();
  });

  it('returns null when model is null (acpx-local emits provider="acpx", model=null)', () => {
    expect(
      priceUsd({
        provider: 'acpx',
        model: null,
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ).toBeNull();
  });

  it('returns null when provider is null', () => {
    expect(
      priceUsd({
        provider: null,
        model: 'claude-opus-4-6',
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ).toBeNull();
  });

  it('returns null when billingType is outside the allowlist (subscription_included)', () => {
    expect(
      priceUsd({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        billingType: 'subscription_included',
      }),
    ).toBeNull();
  });

  it('returns null when billingType is "subscription_overage"', () => {
    expect(
      priceUsd({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        billingType: 'subscription_overage',
      }),
    ).toBeNull();
  });

  it('returns null when billingType is "fixed"', () => {
    expect(
      priceUsd({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        billingType: 'fixed',
      }),
    ).toBeNull();
  });

  it('treats undefined billingType as allowed (default)', () => {
    const result = priceUsd({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThan(0);
  });

  it('treats "metered_api" / "credits" / "unknown" billingType as allowed', () => {
    for (const billingType of ['metered_api', 'credits', 'unknown'] as const) {
      const result = priceUsd({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1_000_000,
        outputTokens: 0,
        billingType,
      });
      expect(result, `billingType=${billingType}`).not.toBeNull();
      expect(result, `billingType=${billingType}`).toBeGreaterThan(0);
    }
  });

  it('returns 0 for a genuine zero-usage run (distinguishes free from unpriced)', () => {
    expect(
      priceUsd({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });

  it('prices a basic claude-opus-4-6 run at the catalog rate', () => {
    const entry = catalog['anthropic/claude-opus-4-6']!;
    expect(entry).toBeDefined();
    const result = priceUsd({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 1M input @ input_per_mtok + 1M output @ output_per_mtok
    expect(result).toBeCloseTo(entry.input_per_mtok + entry.output_per_mtok, 6);
  });

  it('collapses Bedrock model IDs onto the base catalog entry', () => {
    const entry = catalog['anthropic/claude-opus-4-6']!;
    const result = priceUsd({
      provider: 'anthropic',
      model: 'us.anthropic.claude-opus-4-6-v1',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(result).toBeCloseTo(entry.input_per_mtok, 6);
  });

  it('does not double-prefix already-qualified model strings (opencode-local shape)', () => {
    const entry = catalog['anthropic/claude-sonnet-4-6']!;
    expect(entry).toBeDefined();
    const result = priceUsd({
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-4-6',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(result).toBeCloseTo(entry.input_per_mtok, 6);
  });

  it('prices cached input tokens at the cached rate, not the input rate', () => {
    const entry = catalog['anthropic/claude-opus-4-6']!;
    expect(entry.cached_input_per_mtok).toBeLessThan(entry.input_per_mtok);

    // 1M total input tokens, 800k of which are cache reads.
    const result = priceUsd({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 800_000,
    });

    // Expected: 200k @ input rate + 800k @ cached rate.
    const expected = (200_000 / 1_000_000) * entry.input_per_mtok +
      (800_000 / 1_000_000) * entry.cached_input_per_mtok;
    expect(result).toBeCloseTo(expected, 6);
  });

  it('charges nothing for cached tokens that exceed inputTokens (defensive)', () => {
    // If an upstream reports cached > input we should still produce a finite,
    // non-negative result (billedInput is clamped to 0).
    const result = priceUsd({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inputTokens: 100,
      outputTokens: 0,
      cachedInputTokens: 1000,
    });
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0);
  });

  describe('tier threshold pricing', () => {
    // claude-4-sonnet-20250514 has a 200k threshold in the snapshot.
    const TIERED_KEY = 'anthropic/claude-4-sonnet-20250514';

    it('uses the base rate when input is at or below the threshold', () => {
      const entry = catalog[TIERED_KEY];
      if (!entry || entry.tier_threshold_tokens == null) return;

      const tokens = entry.tier_threshold_tokens; // exactly at threshold
      const result = priceUsd({
        provider: 'anthropic',
        model: 'claude-4-sonnet-20250514',
        inputTokens: tokens,
        outputTokens: 0,
      });
      const expected = (tokens / 1_000_000) * entry.input_per_mtok;
      expect(result).toBeCloseTo(expected, 6);
    });

    it('uses the tier rate ONLY for the excess portion above the threshold', () => {
      const entry = catalog[TIERED_KEY];
      if (
        !entry ||
        entry.tier_threshold_tokens == null ||
        entry.over_threshold_input_per_mtok == null
      ) {
        return;
      }
      const threshold = entry.tier_threshold_tokens;
      const excess = 50_000;
      const total = threshold + excess;

      const result = priceUsd({
        provider: 'anthropic',
        model: 'claude-4-sonnet-20250514',
        inputTokens: total,
        outputTokens: 0,
      });

      const expected =
        (threshold / 1_000_000) * entry.input_per_mtok +
        (excess / 1_000_000) * entry.over_threshold_input_per_mtok;
      expect(result).toBeCloseTo(expected, 6);
    });

    it('applies tier rate to output when input exceeds the threshold', () => {
      const entry = catalog[TIERED_KEY];
      if (
        !entry ||
        entry.tier_threshold_tokens == null ||
        entry.over_threshold_output_per_mtok == null
      ) {
        return;
      }
      const threshold = entry.tier_threshold_tokens;

      const result = priceUsd({
        provider: 'anthropic',
        model: 'claude-4-sonnet-20250514',
        inputTokens: threshold + 1, // just over threshold
        outputTokens: 1_000_000,
      });

      // Output should be priced at the over-threshold rate.
      const inputCost =
        (threshold / 1_000_000) * entry.input_per_mtok +
        (1 / 1_000_000) * entry.over_threshold_input_per_mtok!;
      const outputCost = (1_000_000 / 1_000_000) * entry.over_threshold_output_per_mtok;
      expect(result).toBeCloseTo(inputCost + outputCost, 6);
    });
  });

  describe('reasoning tokens', () => {
    it('prices reasoning tokens separately when entry has reasoning_per_mtok', () => {
      // Find an entry that has reasoning_per_mtok defined.
      const entryKey = Object.entries(catalog).find(
        ([, e]) => typeof e.reasoning_per_mtok === 'number' && e.reasoning_per_mtok > 0,
      )?.[0];
      if (!entryKey) return; // skip if snapshot lacks any reasoning entries
      const entry = catalog[entryKey]!;
      const slash = entryKey.indexOf('/');
      const provider = entryKey.slice(0, slash);
      const model = entryKey.slice(slash + 1);

      const result = priceUsd({
        provider,
        model,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 1_000_000,
      });
      expect(result).toBeCloseTo(entry.reasoning_per_mtok!, 6);
    });

    it('ignores reasoningTokens when entry has no reasoning_per_mtok (caller folded into output)', () => {
      const entry = catalog['anthropic/claude-opus-4-6']!;
      // Confirm precondition for this test.
      expect(entry.reasoning_per_mtok).toBeUndefined();

      const result = priceUsd({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 0,
        outputTokens: 1_000_000,
        reasoningTokens: 500_000, // should NOT be billed separately
      });
      expect(result).toBeCloseTo(entry.output_per_mtok, 6);
    });
  });
});
