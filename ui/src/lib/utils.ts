import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  deriveAgentUrlKey,
  deriveProjectUrlKey,
  hasNonAsciiContent,
  normalizeProjectUrlKey,
} from "@penclipai/shared";
import type { BillingType, FinanceDirection, FinanceEventKind } from "@penclipai/shared";
import { getCurrentLocale, translateInstant } from "../i18n";

// Ledger and budget values remain USD-denominated; locale only affects formatting.
const DISPLAY_CURRENCY = "USD";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatUsdAmount(
  amountUsd: number,
  options?: { minimumFractionDigits?: number; maximumFractionDigits?: number },
): string {
  const locale = getCurrentLocale();
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: DISPLAY_CURRENCY,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: options?.minimumFractionDigits ?? 2,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2,
  }).format(amountUsd);
}

export function formatCents(cents: number): string {
  return formatUsdAmount(cents / 100, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatBudgetInputValue(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function parseBudgetInputValue(value: string): number | null {
  const normalized = value.trim();
  if (normalized.length === 0) return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

export function formatDate(date: Date | string): string {
  return new Intl.DateTimeFormat(getCurrentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

export function formatDateTime(date: Date | string): string {
  return new Intl.DateTimeFormat(getCurrentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

export function formatTime(
  date: Date | string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(getCurrentLocale(), options).format(new Date(date));
}

export function relativeTime(date: Date | string): string {
  const deltaSeconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(deltaSeconds);

  if (absoluteSeconds < 45) return translateInstant("common.justNow");

  const formatter = new Intl.RelativeTimeFormat(getCurrentLocale(), { numeric: "auto" });

  if (absoluteSeconds < 3_600) {
    return formatter.format(Math.round(deltaSeconds / 60), "minute");
  }
  if (absoluteSeconds < 86_400) {
    return formatter.format(Math.round(deltaSeconds / 3_600), "hour");
  }
  if (absoluteSeconds < 2_592_000) {
    return formatter.format(Math.round(deltaSeconds / 86_400), "day");
  }
  return formatDate(date);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Map a raw provider slug to a display-friendly name. */
export function providerDisplayName(provider: string): string {
  const map: Record<string, string> = {
    anthropic: "Anthropic",
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
  const map: Record<BillingType, string> = {
    metered_api: translateInstant("billingType.meteredApi"),
    subscription_included: translateInstant("billingType.subscription"),
    subscription_overage: translateInstant("billingType.subscriptionOverage"),
    credits: translateInstant("billingType.credits"),
    fixed: translateInstant("billingType.fixed"),
    unknown: translateInstant("billingType.unknown"),
  };
  return map[billingType];
}

export function quotaSourceDisplayName(source: string): string {
  const map: Record<string, string> = {
    "anthropic-oauth": "Anthropic OAuth",
    "claude-cli": "Claude CLI",
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
  const map: Record<FinanceEventKind, string> = {
    inference_charge: translateInstant("financeEventKind.inferenceCharge"),
    platform_fee: translateInstant("financeEventKind.platformFee"),
    credit_purchase: translateInstant("financeEventKind.creditPurchase"),
    credit_refund: translateInstant("financeEventKind.creditRefund"),
    credit_expiry: translateInstant("financeEventKind.creditExpiry"),
    byok_fee: translateInstant("financeEventKind.byokFee"),
    gateway_overhead: translateInstant("financeEventKind.gatewayOverhead"),
    log_storage_charge: translateInstant("financeEventKind.logStorage"),
    logpush_charge: translateInstant("financeEventKind.logpush"),
    provisioned_capacity_charge: translateInstant("financeEventKind.provisionedCapacity"),
    training_charge: translateInstant("financeEventKind.training"),
    custom_model_import_charge: translateInstant("financeEventKind.customModelImport"),
    custom_model_storage_charge: translateInstant("financeEventKind.customModelStorage"),
    manual_adjustment: translateInstant("financeEventKind.manualAdjustment"),
  };
  return map[eventKind];
}

export function financeDirectionDisplayName(direction: FinanceDirection): string {
  return direction === "credit"
    ? translateInstant("financeDirection.credit")
    : translateInstant("financeDirection.debit");
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
  const key = project.urlKey ?? deriveProjectUrlKey(project.name, project.id);
  if (key === normalizeProjectUrlKey(project.name) && hasNonAsciiContent(project.name)) {
    return project.id;
  }
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
