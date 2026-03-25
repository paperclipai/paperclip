import {
  CheckCircle2,
  XCircle,
  Clock,
  Timer,
  Loader2,
  Slash,
} from "lucide-react";
import type { HeartbeatRun } from "@paperclipai/shared";

export const runStatusIcons: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  succeeded: { icon: CheckCircle2, color: "text-green-600 dark:text-green-400" },
  failed: { icon: XCircle, color: "text-red-600 dark:text-red-400" },
  running: { icon: Loader2, color: "text-cyan-600 dark:text-cyan-400" },
  queued: { icon: Clock, color: "text-yellow-600 dark:text-yellow-400" },
  timed_out: { icon: Timer, color: "text-orange-600 dark:text-orange-400" },
  cancelled: { icon: Slash, color: "text-neutral-500 dark:text-neutral-400" },
};

export function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export function runMetrics(run: HeartbeatRun) {
  const usage = (run.usageJson ?? null) as Record<string, unknown> | null;
  const result = (run.resultJson ?? null) as Record<string, unknown> | null;
  const input = usageNumber(usage, "inputTokens", "input_tokens");
  const output = usageNumber(usage, "outputTokens", "output_tokens");
  const cached = usageNumber(
    usage,
    "cachedInputTokens",
    "cached_input_tokens",
    "cache_read_input_tokens",
  );
  const cost =
    usageNumber(usage, "costUsd", "cost_usd", "total_cost_usd") ||
    usageNumber(result, "total_cost_usd", "cost_usd", "costUsd");
  return { input, output, cached, cost, totalTokens: input + output };
}

export function runSummary(run: HeartbeatRun): string {
  if (run.resultJson) {
    return String(
      (run.resultJson as Record<string, unknown>).summary ??
      (run.resultJson as Record<string, unknown>).result ??
      "",
    );
  }
  return run.error ?? "";
}

export const SOURCE_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "timer", label: "Timer" },
  { value: "assignment", label: "Assignment" },
  { value: "on_demand", label: "On-demand" },
  { value: "automation", label: "Automation" },
  { value: "chat", label: "Chat" },
] as const;
