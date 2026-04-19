import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function windowPriority(label: string): number {
  const normalized = normalizeLabel(label);
  if (normalized.includes("5hlimit")) return 0;
  if (normalized.includes("weeklylimit")) return 1;
  if (normalized === "credits") return 2;
  return 3;
}

export function normalizeCodexQuotaLabel(label: string): string {
  return normalizeLabel(label);
}

export function isCodexModelSpecificWindow(label: string): boolean {
  const normalized = normalizeLabel(label);
  return normalized.includes("gpt53codexspark") || normalized.includes("gpt5");
}

export function orderCodexQuotaWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return [...windows].sort((a, b) => {
    const aPriority = windowPriority(a.label);
    const bPriority = windowPriority(b.label);
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.label.localeCompare(b.label);
  });
}

export function splitCodexQuotaWindows(windows: QuotaWindow[]): {
  accountWindows: QuotaWindow[];
  modelWindows: QuotaWindow[];
} {
  const ordered = orderCodexQuotaWindows(windows);
  return {
    accountWindows: ordered.filter((window) => !isCodexModelSpecificWindow(window.label)),
    modelWindows: ordered.filter((window) => isCodexModelSpecificWindow(window.label)),
  };
}

export function pickPrimaryCodexQuotaWindow(windows: QuotaWindow[]): QuotaWindow | null {
  const usageWindows = orderCodexQuotaWindows(
    windows.filter((window) => typeof window.usedPercent === "number"),
  );
  return usageWindows[0] ?? null;
}

export function findCodexCreditsQuotaWindow(windows: QuotaWindow[]): QuotaWindow | null {
  return (
    orderCodexQuotaWindows(windows).find((window) => {
      const valueLabel =
        typeof window.valueLabel === "string" ? window.valueLabel.trim() : "";
      return normalizeLabel(window.label) === "credits" &&
        valueLabel.length > 0 &&
        valueLabel.toLowerCase() !== "n/a";
    }) ?? null
  );
}

export function getCodexRemainingPercent(window: QuotaWindow): number | null {
  if (typeof window.usedPercent !== "number") return null;
  return Math.max(0, 100 - Math.max(0, Math.min(100, window.usedPercent)));
}

export function formatCodexQuotaErrorMessage(error: string | null | undefined): string | null {
  if (typeof error !== "string" || error.trim().length === 0) return null;
  const message = error.trim();
  const normalized = message.toLowerCase();
  if (
    normalized.includes("401") ||
    normalized.includes("unauthorized") ||
    normalized.includes("could not parse your authentication token") ||
    normalized.includes("authentication required")
  ) {
    return "Codex rate limits require a fresh ChatGPT login. Run `codex login` and try again.";
  }
  return message;
}

export function formatCodexQuotaDetail(window: QuotaWindow, now: Date = new Date()): string | null {
  if (typeof window.detail === "string" && window.detail.trim().length > 0) {
    return window.detail.trim();
  }
  if (!window.resetsAt) return null;

  const resetAt = new Date(window.resetsAt);
  if (Number.isNaN(resetAt.getTime())) return null;

  const isSameDay = resetAt.getFullYear() === now.getFullYear() &&
    resetAt.getMonth() === now.getMonth() &&
    resetAt.getDate() === now.getDate();

  if (isSameDay) {
    return resetAt.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return resetAt.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function findCodexQuotaResult(results: ProviderQuotaResult[] | undefined): ProviderQuotaResult | null {
  const quotaResults = results ?? [];
  return quotaResults.find((result) =>
    result.provider === "openai" &&
    typeof result.source === "string" &&
    result.source.startsWith("codex-"),
  ) ?? quotaResults.find((result) => result.provider === "openai") ?? null;
}
