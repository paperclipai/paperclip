function firstNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}...` : value;
}

/**
 * Heartbeat run list responses only need the operator-facing summary fields.
 * Trim the common text fields so agent pages and inbox cards stay light even
 * when adapters return verbose JSON payloads.
 */
export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary = firstNonEmptyString(resultJson.summary);
  const result = firstNonEmptyString(resultJson.result);
  const message = firstNonEmptyString(resultJson.message);
  const error = firstNonEmptyString(resultJson.error);
  const totalCostUsd = resultJson.total_cost_usd ?? null;
  const costUsd = resultJson.cost_usd ?? null;
  const camelCostUsd = resultJson.costUsd ?? null;

  const summarized = Object.fromEntries(
    Object.entries({
      summary: summary ? truncate(summary, 500) : null,
      result: result ? truncate(result, 500) : null,
      message: message ? truncate(message, 500) : null,
      error: error ? truncate(error, 500) : null,
      total_cost_usd: totalCostUsd,
      cost_usd: costUsd,
      costUsd: camelCostUsd,
    }).filter(([, value]) => value !== null),
  );

  return Object.keys(summarized).length > 0 ? summarized : null;
}
