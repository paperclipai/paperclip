import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { deriveAgentUrlKey, deriveProjectUrlKey } from "@paperclipai/shared";
import type { BillingType, FinanceDirection, FinanceEventKind } from "@paperclipai/shared";
import { formatMessage } from "../i18n";
import { getRuntimeLocale } from "../i18n/runtime";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCents(cents: number): string {
  return new Intl.NumberFormat(getRuntimeLocale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatDate(date: Date | string | number): string {
  return new Intl.DateTimeFormat(getRuntimeLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

export function formatDateTime(date: Date | string | number): string {
  return new Intl.DateTimeFormat(getRuntimeLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

export function relativeTime(date: Date | string | number): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffSec = Math.round((now - then) / 1000);
  const formatter = new Intl.RelativeTimeFormat(getRuntimeLocale(), {
    numeric: "auto",
    style: "short",
  });
  if (diffSec < 60) return formatter.format(0, "second");
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return formatter.format(-diffMin, "minute");
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return formatter.format(-diffHr, "hour");
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return formatter.format(-diffDay, "day");
  return formatDate(date);
}

export function formatTokens(n: number): string {
  return new Intl.NumberFormat(getRuntimeLocale(), {
    notation: n >= 1_000 ? "compact" : "standard",
    compactDisplay: "short",
    maximumFractionDigits: n >= 1_000 ? 1 : 0,
  }).format(n);
}

/** Map a raw provider slug to a display-friendly name. */
export function providerDisplayName(provider: string): string {
  const locale = getRuntimeLocale();
  const key = {
    anthropic: "display.provider.anthropic",
    openai: "display.provider.openai",
    openrouter: "display.provider.openrouter",
    chatgpt: "display.provider.chatgpt",
    google: "display.provider.google",
    cursor: "display.provider.cursor",
    jetbrains: "display.provider.jetbrains",
  }[provider.toLowerCase()];
  return key ? formatMessage(locale, key) : provider;
}

export function billingTypeDisplayName(billingType: BillingType): string {
  const locale = getRuntimeLocale();
  const key = {
    metered_api: "display.billingType.metered_api",
    subscription_included: "display.billingType.subscription_included",
    subscription_overage: "display.billingType.subscription_overage",
    credits: "display.billingType.credits",
    fixed: "display.billingType.fixed",
    unknown: "display.billingType.unknown",
  }[billingType];
  return key ? formatMessage(locale, key) : billingType;
}

export function quotaSourceDisplayName(source: string): string {
  const locale = getRuntimeLocale();
  const key = {
    "anthropic-oauth": "display.quotaSource.anthropicOauth",
    "claude-cli": "display.quotaSource.claudeCli",
    "codex-rpc": "display.quotaSource.codexRpc",
    "codex-wham": "display.quotaSource.codexWham",
  }[source];
  return key ? formatMessage(locale, key) : source;
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
  const locale = getRuntimeLocale();
  const key = `display.financeEventKind.${eventKind}`;
  const value = formatMessage(locale, key);
  return value === key ? eventKind : value;
}

export function financeDirectionDisplayName(direction: FinanceDirection): string {
  const locale = getRuntimeLocale();
  return formatMessage(locale, direction === "credit" ? "display.financeDirection.credit" : "display.financeDirection.debit");
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

/** Build a project route reference using the short URL key when available. */
export function projectRouteRef(project: { id: string; urlKey?: string | null; name?: string | null }): string {
  return project.urlKey ?? deriveProjectUrlKey(project.name, project.id);
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
