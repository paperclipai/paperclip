const TRANSIENT_ACPX_TERMINAL_FAILURE_CATEGORIES = new Set(["connection", "service"]);

/** Read legacy ACPX diagnostics at their owner boundary. */
export function isTransientAcpxTurnFailure(latestRun: { resultJson?: unknown } | null | undefined) {
  const resultJson = latestRun?.resultJson;
  if (typeof resultJson !== "object" || resultJson === null) return true;
  const failure = (resultJson as Record<string, unknown>).terminalSessionFailure;
  if (typeof failure !== "object" || failure === null) return true;
  const rawCategory = (failure as Record<string, unknown>).category;
  const category = typeof rawCategory === "string" && rawCategory.trim() ? rawCategory.trim() : null;
  return category === null || TRANSIENT_ACPX_TERMINAL_FAILURE_CATEGORIES.has(category);
}

