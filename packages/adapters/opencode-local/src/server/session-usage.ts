/**
 * OpenCode V2 can drop the final `step_finish` record from `run --format json`
 * (upstream anomalco/opencode#53207), so stdout alone can under-report a turn.
 * The server keeps the aggregate cost/tokens on the session, which the adapter
 * reads back through `opencode api GET /api/session/{id}` after a run.
 */
export type OpenCodeSessionUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type OpenCodeSessionTotals = {
  usage: OpenCodeSessionUsage;
  costUsd: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Parse the `opencode api GET /api/session/{id}` payload. Returns null when the
 * payload does not carry complete token counters, so callers keep the stdout
 * accounting instead of replacing it with a synthetic value.
 */
export function parseOpenCodeSessionTotals(
  raw: string,
): OpenCodeSessionTotals | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const root = asRecord(parsed);
  if (!root) return null;
  // `opencode api` wraps responses in `{ data: ... }`; accept the bare session
  // shape too so the parser works across CLI output changes.
  const payload =
    asRecord(root.data) ??
    asRecord(root.info) ??
    asRecord(root.session) ??
    root;
  const tokens = asRecord(payload.tokens);
  if (!tokens) return null;
  const cache = asRecord(tokens.cache) ?? {};

  const input = asNonNegativeInteger(tokens.input);
  const output = asNonNegativeInteger(tokens.output);
  if (input === null || output === null) return null;
  // Missing optional counters count as zero; a present but invalid counter
  // means the payload is not trustworthy.
  const reasoning = tokens.reasoning === undefined
    ? 0
    : asNonNegativeInteger(tokens.reasoning);
  const cached = cache.read === undefined ? 0 : asNonNegativeInteger(cache.read);
  const written = cache.write === undefined ? 0 : asNonNegativeInteger(cache.write);
  if (reasoning === null || cached === null || written === null) return null;

  const inputTokens = input + written;
  const cachedInputTokens = cached;
  const outputTokens = output + reasoning;
  if (
    ![
      inputTokens,
      cachedInputTokens,
      outputTokens,
    ].every(Number.isSafeInteger)
  ) {
    return null;
  }

  return {
    usage: { inputTokens, cachedInputTokens, outputTokens },
    costUsd: asNonNegativeNumber(payload.cost),
  };
}

/**
 * The session payload is cumulative. Subtract the pre-run snapshot to report
 * only this attempt, clamping at zero if the session was compacted or reset.
 */
export function subtractOpenCodeSessionTotals(
  after: OpenCodeSessionTotals,
  before: OpenCodeSessionTotals | null,
): OpenCodeSessionTotals {
  if (!before) return after;
  const delta = (next: number, previous: number) => Math.max(0, next - previous);
  return {
    usage: {
      inputTokens: delta(after.usage.inputTokens, before.usage.inputTokens),
      cachedInputTokens: delta(after.usage.cachedInputTokens, before.usage.cachedInputTokens),
      outputTokens: delta(after.usage.outputTokens, before.usage.outputTokens),
    },
    costUsd:
      after.costUsd === null
        ? null
        : before.costUsd === null
          ? after.costUsd
          : Math.max(0, after.costUsd - before.costUsd),
  };
}
