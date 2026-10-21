import type { RunnerE2EBillingSummary } from "./types.js";
import { billingCoverageLabel } from "./billing.js";

export function html(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function durationLabel(durationMs: number) {
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
  return billingCoverageLabel(usdLabel(value), llm.runsWithReportedCost, llm.runCount);
}

export function usdLabel(value: number | null) {
  if (value === null) return "Unknown";
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}
