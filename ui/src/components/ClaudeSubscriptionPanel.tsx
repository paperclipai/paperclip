import type { QuotaWindow } from "@paperclipai/shared";
import { cn, formatDateTime, quotaSourceDisplayName } from "@/lib/utils";
import { useI18n } from "@/i18n";

interface ClaudeSubscriptionPanelProps {
  windows: QuotaWindow[];
  source?: string | null;
  error?: string | null;
}

const WINDOW_ORDER = [
  "currentsession",
  "currentweekallmodels",
  "currentweeksonnetonly",
  "currentweeksonnet",
  "currentweekopusonly",
  "currentweekopus",
  "extrausage",
] as const;

function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function detailText(window: QuotaWindow, t: (key: string, vars?: Record<string, string | number>) => string): string | null {
  if (typeof window.detail === "string" && window.detail.trim().length > 0) return window.detail.trim();
  if (window.resetsAt) {
    return t("costs.resetsAt", { date: formatDateTime(window.resetsAt) });
  }
  return null;
}

function orderedWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return [...windows].sort((a, b) => {
    const aIndex = WINDOW_ORDER.indexOf(normalizeLabel(a.label) as (typeof WINDOW_ORDER)[number]);
    const bIndex = WINDOW_ORDER.indexOf(normalizeLabel(b.label) as (typeof WINDOW_ORDER)[number]);
    return (aIndex === -1 ? WINDOW_ORDER.length : aIndex) - (bIndex === -1 ? WINDOW_ORDER.length : bIndex);
  });
}

function fillClass(usedPercent: number | null): string {
  if (usedPercent == null) return "bg-zinc-700";
  if (usedPercent >= 90) return "bg-red-400";
  if (usedPercent >= 70) return "bg-amber-400";
  return "bg-primary/70";
}

export function ClaudeSubscriptionPanel({
  windows,
  source = null,
  error = null,
}: ClaudeSubscriptionPanelProps) {
  const { t } = useI18n();
  const ordered = orderedWindows(windows);

  return (
    <div className="border border-border px-4 py-4">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {t("costs.anthropicSubscription")}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {t("costs.claudeWindowsDescription")}
          </div>
        </div>
        {source ? (
          <span className="shrink-0 border border-border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {quotaSourceDisplayName(source)}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="mt-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="mt-4 space-y-4">
        {ordered.map((window) => {
          const normalized = normalizeLabel(window.label);
          const detail = detailText(window, t);
          if (normalized === "extrausage") {
            return (
              <div
                key={window.label}
                className="border border-border px-3.5 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-foreground">{window.label}</div>
                  {window.valueLabel ? (
                    <div className="text-sm font-medium text-foreground">{window.valueLabel}</div>
                  ) : null}
                </div>
                {detail ? (
                  <div className="mt-2 text-sm text-muted-foreground">{detail}</div>
                ) : null}
              </div>
            );
          }

          const width = Math.min(100, Math.max(0, window.usedPercent ?? 0));
          return (
            <div
              key={window.label}
              className="border border-border px-3.5 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{window.label}</div>
                  {detail ? (
                    <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
                  ) : null}
                </div>
                {window.usedPercent != null ? (
                  <div className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                    {t("costs.usedPercent", { percent: window.usedPercent })}
                  </div>
                ) : null}
              </div>

              <div className="mt-3 h-2 overflow-hidden bg-muted">
                <div
                  className={cn("h-full transition-[width] duration-200", fillClass(window.usedPercent))}
                  style={{ width: `${width}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
