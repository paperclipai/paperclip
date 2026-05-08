import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { deriveAgentUrlKey, deriveProjectUrlKey, normalizeProjectUrlKey, hasNonAsciiContent } from "@paperclipai/shared";
import type { BillingType, FinanceDirection, FinanceEventKind } from "@paperclipai/shared";
import i18n from "@/i18n";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function asBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function asFiniteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function formatCents(cents: number): string {
  return new Intl.NumberFormat(i18n.language, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(i18n.language).format(n);
}

export function formatDate(date: Date | string): string {
  return new Intl.DateTimeFormat(i18n.language, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

export function formatDateTime(date: Date | string): string {
  return new Intl.DateTimeFormat(i18n.language, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

export function formatShortDate(date: Date | string): string {
  return new Intl.DateTimeFormat(i18n.language, {
    month: "short",
    day: "numeric",
  }).format(new Date(date));
}

export function relativeTime(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return i18n.t("relativeTime.justNow");
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return i18n.t("relativeTime.minutesAgo", { count: diffMin });
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return i18n.t("relativeTime.hoursAgo", { count: diffHr });
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return i18n.t("relativeTime.daysAgo", { count: diffDay });
  return formatDate(date);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Humanize a millisecond duration into a compact `1h 2m`, `45m 12s`, `12s` string. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

/** Map a raw provider slug to a display-friendly name. */
export function providerDisplayName(provider: string): string {
  const map: Record<string, string> = {
    anthropic: "Anthropic",
    aws_bedrock: "AWS Bedrock",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    chatgpt: "ChatGPT",
    google: "Google",
    cursor: "Cursor",
    jetbrains: "JetBrains AI",
  };
  return map[provider.toLowerCase()] ?? provider;
}

export function billingTypeDisplayName(billingType: BillingType): string {
  return i18n.t(`billingType.${billingType}`, { defaultValue: billingType });
}

export function quotaSourceDisplayName(source: string): string {
  const map: Record<string, string> = {
    "anthropic-oauth": "Anthropic OAuth",
    "claude-cli": "Claude CLI",
    "bedrock": "AWS Bedrock",
    "codex-rpc": "Codex app server",
    "codex-wham": "ChatGPT WHAM",
  };
  return map[source] ?? source;
}

function coerceBillingType(value: unknown): BillingType | null {
  if (
    value === "metered_api" ||
    value === "subscription_included" ||
    value === "subscription_overage" ||
    value === "credits" ||
    value === "fixed" ||
    value === "unknown"
  ) {
    return value;
  }
  return null;
}

function readRunCostUsd(payload: Record<string, unknown> | null): number {
  if (!payload) return 0;
  for (const key of ["costUsd", "cost_usd", "total_cost_usd"] as const) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export function visibleRunCostUsd(
  usage: Record<string, unknown> | null,
  result: Record<string, unknown> | null = null,
): number {
  const billingType = coerceBillingType(usage?.billingType) ?? coerceBillingType(result?.billingType);
  if (billingType === "subscription_included") return 0;
  return readRunCostUsd(usage) || readRunCostUsd(result);
}

export function financeEventKindDisplayName(eventKind: FinanceEventKind): string {
  return i18n.t(`financeEventKind.${eventKind}`, { defaultValue: eventKind });
}

export function financeDirectionDisplayName(direction: FinanceDirection): string {
  return i18n.t(`financeDirection.${direction}`, { defaultValue: direction });
}

/** Build an issue URL using the human-readable identifier when available. */
export function issueUrl(issue: { id: string; identifier?: string | null }): string {
  return `/issues/${issue.identifier ?? issue.id}`;
}

/** Build an agent route URL using the short URL key when available. */
export function agentRouteRef(agent: { id: string; urlKey?: string | null; name?: string | null }): string {
  return agent.urlKey ?? deriveAgentUrlKey(agent.name, agent.id);
}

/** Build an agent URL using the short URL key when available. */
export function agentUrl(agent: { id: string; urlKey?: string | null; name?: string | null }): string {
  return `/agents/${agentRouteRef(agent)}`;
}

/** Build a project route reference, falling back to UUID when the derived key is ambiguous. */
export function projectRouteRef(project: { id: string; urlKey?: string | null; name?: string | null }): string {
  const key = project.urlKey ?? deriveProjectUrlKey(project.name, project.id);
  // Guard for rolling deploys or legacy data where the server returned a bare slug without UUID suffix.
  if (key === normalizeProjectUrlKey(project.name) && hasNonAsciiContent(project.name)) return project.id;
  return key;
}

/** Build a project URL using the short URL key when available. */
export function projectUrl(project: { id: string; urlKey?: string | null; name?: string | null }): string {
  return `/projects/${projectRouteRef(project)}`;
}

/** Build a project workspace URL scoped under its project. */
export function projectWorkspaceUrl(
  project: { id: string; urlKey?: string | null; name?: string | null },
  workspaceId: string,
): string {
  return `${projectUrl(project)}/workspaces/${workspaceId}`;
}
