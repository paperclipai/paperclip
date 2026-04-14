import {
  createTranslator,
  formatDateForLocale,
  formatDateTimeForLocale,
  formatRelativeTimeForLocale,
  formatShortDateForLocale,
} from "@paperclipai/i18n";
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { deriveAgentUrlKey, deriveProjectUrlKey, normalizeProjectUrlKey, hasNonAsciiContent } from "@paperclipai/shared";
import type {
  BillingType,
  BudgetScopeType,
  BudgetWindowKind,
  FinanceDirection,
  FinanceEventKind,
  PauseReason,
} from "@paperclipai/shared";
import { getCurrentLocale } from "./locale-store";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatDate(date: Date | string): string {
  return formatDateForLocale(getCurrentLocale(), date);
}

export function formatDateTime(date: Date | string): string {
  return formatDateTimeForLocale(getCurrentLocale(), date);
}

export function formatShortDate(date: Date | string): string {
  return formatShortDateForLocale(getCurrentLocale(), date);
}

export function relativeTime(date: Date | string): string {
  return formatRelativeTimeForLocale(getCurrentLocale(), date);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function t() {
  return createTranslator(getCurrentLocale()).t;
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
  const translate = t();
  const map: Record<BillingType, string> = {
    metered_api: translate("finance.billingType.meteredApi"),
    subscription_included: translate("finance.billingType.subscriptionIncluded"),
    subscription_overage: translate("finance.billingType.subscriptionOverage"),
    credits: translate("finance.billingType.credits"),
    fixed: translate("finance.billingType.fixed"),
    unknown: translate("finance.billingType.unknown"),
  };
  return map[billingType];
}

export function quotaSourceDisplayName(source: string): string {
  const translate = t();
  const map: Record<string, string> = {
    "anthropic-oauth": translate("finance.quotaSource.anthropicOauth"),
    "claude-cli": translate("finance.quotaSource.claudeCli"),
    "bedrock": translate("finance.quotaSource.awsBedrock"),
    "codex-rpc": translate("finance.quotaSource.codexAppServer"),
    "codex-wham": translate("finance.quotaSource.chatgptWham"),
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
  const translate = t();
  const map: Record<FinanceEventKind, string> = {
    inference_charge: translate("finance.eventKind.inferenceCharge"),
    platform_fee: translate("finance.eventKind.platformFee"),
    credit_purchase: translate("finance.eventKind.creditPurchase"),
    credit_refund: translate("finance.eventKind.creditRefund"),
    credit_expiry: translate("finance.eventKind.creditExpiry"),
    byok_fee: translate("finance.eventKind.byokFee"),
    gateway_overhead: translate("finance.eventKind.gatewayOverhead"),
    log_storage_charge: translate("finance.eventKind.logStorageCharge"),
    logpush_charge: translate("finance.eventKind.logpushCharge"),
    provisioned_capacity_charge: translate("finance.eventKind.provisionedCapacityCharge"),
    training_charge: translate("finance.eventKind.trainingCharge"),
    custom_model_import_charge: translate("finance.eventKind.customModelImportCharge"),
    custom_model_storage_charge: translate("finance.eventKind.customModelStorageCharge"),
    manual_adjustment: translate("finance.eventKind.manualAdjustment"),
  };
  return map[eventKind];
}

export function financeDirectionDisplayName(direction: FinanceDirection): string {
  const translate = t();
  return direction === "credit" ? translate("finance.direction.credit") : translate("finance.direction.debit");
}

export function budgetScopeDisplayName(scopeType: BudgetScopeType): string {
  const translate = t();
  const map: Record<BudgetScopeType, string> = {
    company: translate("budget.scope.company"),
    agent: translate("budget.scope.agent"),
    project: translate("budget.scope.project"),
  };
  return map[scopeType];
}

export function budgetWindowDisplayName(windowKind: BudgetWindowKind): string {
  const translate = t();
  return windowKind === "lifetime"
    ? translate("budget.window.lifetime")
    : translate("budget.window.calendarMonthUtc");
}

export function pauseReasonDisplayName(reason: PauseReason): string {
  const translate = t();
  const map: Record<PauseReason, string> = {
    manual: translate("budget.pauseReason.manual"),
    budget: translate("budget.pauseReason.budget"),
    system: translate("budget.pauseReason.system"),
  };
  return map[reason];
}

export function issueStatusDisplayName(status: string): string {
  const translate = t();
  const map: Record<string, string> = {
    backlog: translate("issue.statusBacklog"),
    todo: translate("issue.statusTodo"),
    in_progress: translate("issue.statusInProgress"),
    in_review: translate("issue.statusInReview"),
    blocked: translate("issue.statusBlocked"),
    done: translate("issue.statusDone"),
    cancelled: translate("issue.statusCancelled"),
  };
  return map[status] ?? status;
}

export function issuePriorityDisplayName(priority: string): string {
  const translate = t();
  const map: Record<string, string> = {
    critical: translate("issue.priorityCritical"),
    high: translate("issue.priorityHigh"),
    medium: translate("issue.priorityMedium"),
    low: translate("issue.priorityLow"),
  };
  return map[priority] ?? priority;
}

export function runtimeServiceStatusDisplayName(status: string): string {
  const translate = t();
  const map: Record<string, string> = {
    starting: translate("projectProperties.runtimeServiceStatus.starting"),
    running: translate("projectProperties.runtimeServiceStatus.running"),
    stopped: translate("projectProperties.runtimeServiceStatus.stopped"),
    failed: translate("projectProperties.runtimeServiceStatus.failed"),
  };
  return map[status] ?? status;
}

export function runtimeServiceLifecycleDisplayName(lifecycle: string): string {
  const translate = t();
  const map: Record<string, string> = {
    shared: translate("projectProperties.runtimeServiceLifecycle.shared"),
    isolated: translate("projectProperties.runtimeServiceLifecycle.isolated"),
    ephemeral: translate("projectProperties.runtimeServiceLifecycle.ephemeral"),
  };
  return map[lifecycle] ?? lifecycle;
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
