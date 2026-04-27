// Pricing table (USD per million tokens) as of 2026-04-22.
// Source: platform.claude.com/docs/en/pricing + managed-agents docs.
// Runtime charge: $0.08 per session-hour, metered to milliseconds.

interface Pricing {
  input: number;
  output: number;
  cacheCreation5m: number;
  cacheRead: number;
}

const PER_MODEL: Record<string, Pricing> = {
  "claude-opus-4-7": { input: 15, output: 75, cacheCreation5m: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheCreation5m: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheCreation5m: 1.25, cacheRead: 0.1 },
};

const RUNTIME_PER_HOUR = 0.08;

export interface UsageInput {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function calcTokenCostUsd(model: string, usage: UsageInput): number {
  const p = PER_MODEL[model];
  if (!p) return 0;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheCreationInputTokens * p.cacheCreation5m +
      usage.cacheReadInputTokens * p.cacheRead) /
    1_000_000
  );
}

export function calcRuntimeCostUsd(activeSeconds: number): number {
  return (activeSeconds / 3600) * RUNTIME_PER_HOUR;
}
