export interface OpenCodeProxyUsageMeasurement {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  activeSeconds: number;
  requests: number;
  providerCostUsd: number;
}

export interface OpenCodeProxyUsageSnapshot {
  total: OpenCodeProxyUsageMeasurement;
  last: OpenCodeProxyUsageMeasurement;
}

const ZERO_USAGE: OpenCodeProxyUsageMeasurement = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  activeSeconds: 0,
  requests: 0,
  providerCostUsd: 0,
});

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function integer(...values: unknown[]): number {
  for (const value of values) {
    if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  }
  return 0;
}

function finite(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return 0;
}

function add(
  left: OpenCodeProxyUsageMeasurement,
  right: OpenCodeProxyUsageMeasurement,
): OpenCodeProxyUsageMeasurement {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    activeSeconds: left.activeSeconds + right.activeSeconds,
    requests: left.requests + right.requests,
    providerCostUsd: left.providerCostUsd + right.providerCostUsd,
  };
}

function sum(
  values: Iterable<OpenCodeProxyUsageMeasurement>,
): OpenCodeProxyUsageMeasurement {
  let total = ZERO_USAGE;
  for (const value of values) total = add(total, value);
  return total;
}

/**
 * Converts one OpenCode assistant-message usage snapshot into PRP's existing
 * measurement shape. OpenCode's aggregate token total is input + output +
 * reasoning (plus cache fields reported separately), while PRP v1 has no
 * reasoning field. Folding reasoning into output preserves that exact
 * budget-relevant total without a schema fork; consumers must not add it again.
 */
export function openCodeProxyUsageMeasurement(
  value: unknown,
): OpenCodeProxyUsageMeasurement {
  const usage = record(value);
  const cache = record(usage.cache);
  const outputTokens = integer(usage.outputTokens, usage.output);
  const reasoningTokens = integer(usage.reasoningTokens, usage.reasoning);
  return {
    inputTokens: integer(usage.inputTokens, usage.input),
    outputTokens: outputTokens + reasoningTokens,
    cachedInputTokens: integer(usage.cachedInputTokens, cache.read),
    cacheWriteTokens: integer(usage.cacheWriteTokens, cache.write),
    activeSeconds: finite(usage.activeSeconds),
    requests: 1,
    providerCostUsd: finite(usage.providerCostUsd, usage.costUsd, usage.cost),
  };
}

/**
 * OpenCode emits a cumulative snapshot each time an assistant message changes.
 * Retain the latest value per message so repeated updates replace rather than
 * double-count it, then expose the whole current turn as Codex `last` usage.
 */
export class OpenCodeProxyUsageLedger {
  #completed = ZERO_USAGE;
  readonly #messagesByTurn = new Map<
    string,
    Map<string, OpenCodeProxyUsageMeasurement>
  >();

  update(input: {
    turnId: string;
    messageId: string;
    usage: unknown;
  }): OpenCodeProxyUsageSnapshot {
    if (!input.turnId || !input.messageId) {
      throw new Error("OpenCode usage requires turn and message identities");
    }
    const messages = this.#messagesByTurn.get(input.turnId) ?? new Map();
    messages.set(input.messageId, openCodeProxyUsageMeasurement(input.usage));
    this.#messagesByTurn.set(input.turnId, messages);
    const last = sum(messages.values());
    return { total: add(this.#completed, last), last };
  }

  completeTurn(turnId: string): void {
    const messages = this.#messagesByTurn.get(turnId);
    if (messages === undefined) return;
    this.#completed = add(this.#completed, sum(messages.values()));
    this.#messagesByTurn.delete(turnId);
  }

  reset(): void {
    this.#completed = ZERO_USAGE;
    this.#messagesByTurn.clear();
  }
}
