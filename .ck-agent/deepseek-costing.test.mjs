import test from "node:test";
import assert from "node:assert/strict";
import {
  addDeepSeekUsage,
  calculateDeepSeekCostUsd,
  emptyDeepSeekMeter,
  normalizeDeepSeekUsage,
} from "./deepseek-costing.mjs";

test("splits cache hits from uncached prompt tokens", () => {
  assert.deepEqual(normalizeDeepSeekUsage({
    prompt_tokens: 1_000,
    prompt_cache_hit_tokens: 250,
    prompt_cache_miss_tokens: 750,
    completion_tokens: 100,
  }), { inputTokens: 750, cachedInputTokens: 250, outputTokens: 100 });
});

test("derives uncached input when older responses omit miss tokens", () => {
  assert.deepEqual(normalizeDeepSeekUsage({
    prompt_tokens: 1_000,
    prompt_cache_hit_tokens: 250,
    completion_tokens: 100,
  }), { inputTokens: 750, cachedInputTokens: 250, outputTokens: 100 });
});

test("prices V4 Pro using current USD cache, input, and output rates", () => {
  assert.equal(calculateDeepSeekCostUsd("deepseek-v4-pro", {
    prompt_tokens: 2_000_000,
    prompt_cache_hit_tokens: 1_000_000,
    prompt_cache_miss_tokens: 1_000_000,
    completion_tokens: 1_000_000,
  }), 1.308625);
});

test("prices V4 Flash and accumulates multiple calls", () => {
  const meter = emptyDeepSeekMeter();
  addDeepSeekUsage(meter, "deepseek-v4-flash", {
    prompt_tokens: 2_000_000,
    prompt_cache_hit_tokens: 1_000_000,
    prompt_cache_miss_tokens: 1_000_000,
    completion_tokens: 1_000_000,
  });
  addDeepSeekUsage(meter, "deepseek-v4-flash", {
    prompt_tokens: 1_000,
    completion_tokens: 100,
  });
  assert.deepEqual(meter, {
    inputTokens: 1_001_000,
    cachedInputTokens: 1_000_000,
    outputTokens: 1_000_100,
    costUsd: 0.422968,
  });
});

test("unknown models retain usage but do not invent a price", () => {
  const meter = emptyDeepSeekMeter();
  addDeepSeekUsage(meter, "future-model", { prompt_tokens: 10, completion_tokens: 5 });
  assert.deepEqual(meter, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, costUsd: 0 });
  assert.equal(calculateDeepSeekCostUsd("future-model", { prompt_tokens: 10 }), null);
});
