import type { RunnerE2EBillingSummary } from "./types.js";
import { billingCoverageLabel } from "./billing.js";

export function isPublicReportTimestamp(value: unknown): value is string {
  return typeof value === "string" && value === value.trim()
    && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function html(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function durationLabel(durationMs: number | null) {
  if (durationMs === null) return "Unknown";
  if (durationMs < 1_000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function tokenLabel(value: number, llm?: RunnerE2EBillingSummary["llm"]) {
  const formatted = new Intl.NumberFormat("en-US").format(value);
  return llm ? billingCoverageLabel(formatted, llm.runsWithTokenUsage, llm.runCount) : formatted;
}

export function llmCostLabel(value: number, llm: RunnerE2EBillingSummary["llm"]) {
  return billingCoverageLabel(usdLabel(value), llm.runsWithReportedCost, llm.runCount, (llm.runsWithPartialReportedCost ?? 0) > 0);
}

export function usdLabel(value: number | null) {
  if (value === null) return "Unknown";
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}
