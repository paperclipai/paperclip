import type { QuotaWindow } from "@paperclipai/shared";
import { cn, quotaSourceDisplayName } from "@/lib/utils";
import {
  formatCodexQuotaDetail,
  getCodexRemainingPercent,
  normalizeCodexQuotaLabel,
  splitCodexQuotaWindows,
} from "@/lib/codexQuota";

interface CodexSubscriptionPanelProps {
  windows: QuotaWindow[];
  source?: string | null;
  error?: string | null;
}

function fillClass(remainingPercent: number | null): string {
  if (remainingPercent == null) return "bg-zinc-700";
  if (remainingPercent <= 10) return "bg-red-400";
  if (remainingPercent <= 30) return "bg-amber-400";
  return "bg-emerald-400";
}

function isVisibleAccountWindow(window: QuotaWindow): boolean {
  if (normalizeCodexQuotaLabel(window.label) !== "credits") return true;
  const valueLabel = typeof window.valueLabel === "string" ? window.valueLabel.trim() : "";
  return valueLabel.length > 0 && valueLabel.toLowerCase() !== "n/a";
}

export function CodexSubscriptionPanel({
  windows,
  source = null,
  error = null,
}: CodexSubscriptionPanelProps) {
  const { accountWindows, modelWindows } = splitCodexQuotaWindows(windows);
  const visibleAccountWindows = accountWindows.filter(isVisibleAccountWindow);

  return (
    <div className="border border-border px-4 py-4">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Codex subscription
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            Live Codex quota windows.
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

      <div className="mt-4 space-y-5">
        {visibleAccountWindows.length > 0 ? (
          <div className="space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Account windows
            </div>
            <div className="space-y-3">
              {visibleAccountWindows.map((window) => (
                <QuotaWindowRow key={window.label} window={window} />
              ))}
            </div>
          </div>
        ) : null}

        {modelWindows.length > 0 ? (
          <div className="space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Model windows
            </div>
            <div className="space-y-3">
              {modelWindows.map((window) => (
                <QuotaWindowRow key={window.label} window={window} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function QuotaWindowRow({ window }: { window: QuotaWindow }) {
  const detail = formatCodexQuotaDetail(window);
  const remainingPercent = getCodexRemainingPercent(window);
  if (window.usedPercent == null) {
    return (
      <div className="border border-border px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-foreground">{window.label}</div>
          {window.valueLabel ? (
            <div className="text-sm font-semibold tabular-nums text-foreground">{window.valueLabel}</div>
          ) : null}
        </div>
        {detail ? (
          <div className="mt-2 text-xs text-muted-foreground">{detail}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="border border-border px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{window.label}</div>
          {detail ? (
            <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
          ) : null}
        </div>
        <div className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
          {remainingPercent != null ? `${remainingPercent}% remaining` : "—"}
        </div>
      </div>

      <div className="mt-3 h-2 overflow-hidden bg-muted">
        <div
          className={cn("h-full transition-[width] duration-200", fillClass(remainingPercent))}
          style={{ width: `${Math.max(0, Math.min(100, remainingPercent ?? 0))}%` }}
        />
      </div>
    </div>
  );
}
