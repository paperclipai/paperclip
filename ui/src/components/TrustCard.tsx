import type { ReactNode } from "react";
import { AlertOctagon, AlertTriangle, CheckCircle2, HelpCircle, RefreshCw } from "lucide-react";
import { Link } from "@/lib/router";
import type { DashboardSummary } from "@paperclipai/shared";
import {
  evaluateTrust,
  formatPercent,
  type TrustEvaluation,
  type TrustState,
} from "../lib/trustState";

interface TrustCardProps {
  data: DashboardSummary | undefined;
  isError: boolean;
  onRetry?: () => void;
}

interface RecoveryRow {
  key: string;
  label: string;
  evidence: string;
  cta: { label: string; to?: string; onClick?: () => void } | { disabledLabel: string };
  severityTone: "ok" | "warn" | "critical" | "unknown";
}

const stateChrome: Record<TrustState, { Icon: typeof CheckCircle2; iconClass: string; chipClass: string }> = {
  healthy: {
    Icon: CheckCircle2,
    iconClass: "text-emerald-600 dark:text-emerald-300",
    chipClass: "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100 border border-emerald-300/60 dark:border-emerald-500/30",
  },
  needs_attention: {
    Icon: AlertTriangle,
    iconClass: "text-amber-600 dark:text-amber-300",
    chipClass: "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100 border border-amber-300/60 dark:border-amber-500/30",
  },
  critical: {
    Icon: AlertOctagon,
    iconClass: "text-red-600 dark:text-red-300",
    chipClass: "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-100 border border-red-400/60 dark:border-red-500/40",
  },
  unknown: {
    Icon: HelpCircle,
    iconClass: "text-muted-foreground",
    chipClass: "bg-muted/60 text-muted-foreground border border-border",
  },
};

function buildRecoveryRows(ev: TrustEvaluation): RecoveryRow[] {
  const rows: RecoveryRow[] = [];

  // 1. Blocked work
  const blocked = ev.blocked;
  if (blocked.status === "unknown") {
    rows.push({
      key: "blocked",
      label: "Blocked work — Unknown",
      evidence: "Blocked-task count is not available yet.",
      cta: { label: "Review blocked work", to: "/issues" },
      severityTone: "unknown",
    });
  } else if (blocked.status === "zero") {
    rows.push({
      key: "blocked",
      label: "Blocked work — Healthy",
      evidence: "No open work is blocked.",
      cta: { label: "Review blocked work", to: "/issues" },
      severityTone: "ok",
    });
  } else {
    const tone: RecoveryRow["severityTone"] =
      blocked.status === "critical" ? "critical" : blocked.status === "warn" ? "warn" : "ok";
    const headline =
      blocked.status === "critical"
        ? "Blocked work is critical"
        : blocked.status === "warn"
        ? "Blocked work needs attention"
        : "Blocked work is healthy";
    rows.push({
      key: "blocked",
      label: headline,
      evidence: `${blocked.numerator} of ${blocked.denominator} open tasks are blocked.`,
      cta: { label: "Review blocked work", to: "/issues" },
      severityTone: tone,
    });
  }

  // 2. Failed runs today
  const failed = ev.failedToday;
  if (failed.status === "unknown") {
    rows.push({
      key: "failed",
      label: "Failed runs — Unknown",
      evidence: failed.denominator === 0 ? "No run data today." : "Failed-run rate is not available yet.",
      cta: { label: "Open failed runs", to: "/activity" },
      severityTone: "unknown",
    });
  } else {
    const tone: RecoveryRow["severityTone"] =
      failed.status === "critical" ? "critical" : failed.status === "warn" ? "warn" : "ok";
    const headline =
      failed.status === "critical"
        ? "Failed runs are critical"
        : failed.status === "warn"
        ? "Failed runs need attention"
        : "Failed runs are healthy";
    rows.push({
      key: "failed",
      label: headline,
      evidence: `${failed.numerator} of ${failed.denominator} runs failed today.`,
      cta: { label: "Open failed runs", to: "/activity" },
      severityTone: tone,
    });
  }

  // 3. Agent health
  const errored = ev.agentsErrored;
  const runningGap = ev.agentsActive - ev.agentsRunning;
  if (errored > 0 || runningGap > 0) {
    const tone: RecoveryRow["severityTone"] = errored > 0 ? "warn" : "ok";
    rows.push({
      key: "agents",
      label: "Agent health needs triage",
      evidence:
        errored > 0
          ? `${errored} agent${errored === 1 ? "" : "s"} in error state.`
          : `${runningGap} active agent${runningGap === 1 ? "" : "s"} not currently running.`,
      cta: { label: "Review errored agents", to: "/agents/error" },
      severityTone: tone,
    });
  }

  return rows.slice(0, 3);
}

function toneBadgeClass(tone: RecoveryRow["severityTone"]): string {
  switch (tone) {
    case "critical":
      return "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-100 border-red-400/60 dark:border-red-500/40";
    case "warn":
      return "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100 border-amber-300/60 dark:border-amber-500/30";
    case "ok":
      return "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100 border-emerald-300/60 dark:border-emerald-500/30";
    default:
      return "bg-muted/60 text-muted-foreground border-border";
  }
}

function toneLabel(tone: RecoveryRow["severityTone"]): string {
  switch (tone) {
    case "critical":
      return "Critical";
    case "warn":
      return "Warning";
    case "ok":
      return "OK";
    default:
      return "Unknown";
  }
}

interface SparklineProps {
  values: number[];
  ariaLabel: string;
}

function Sparkline({ values, ariaLabel }: SparklineProps) {
  if (values.length === 0) return null;
  const width = 120;
  const height = 28;
  const padX = 2;
  const max = Math.max(1, ...values);
  const step = values.length === 1 ? 0 : (width - padX * 2) / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = padX + i * step;
      const y = height - (v / max) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${height}`}
      className="h-7 w-[120px] text-muted-foreground"
    >
      <title>{ariaLabel}</title>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

function CtaButton({ cta }: { cta: RecoveryRow["cta"] }) {
  if ("disabledLabel" in cta) {
    return (
      <span className="text-xs text-muted-foreground italic shrink-0">{cta.disabledLabel}</span>
    );
  }
  if (cta.to) {
    return (
      <Link
        to={cta.to}
        className="shrink-0 inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium no-underline text-inherit hover:bg-accent/50"
      >
        {cta.label}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={cta.onClick}
      className="shrink-0 inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent/50"
    >
      {cta.label}
    </button>
  );
}

export function TrustCard({ data, isError, onRetry }: TrustCardProps): ReactNode {
  const ev = evaluateTrust(data, isError);
  const chrome = stateChrome[ev.state];
  const Icon = chrome.Icon;

  const sevenDayLabel =
    ev.sevenDay.ratio === null
      ? "7-day failed-run rate is not available yet"
      : `7-day failed-run rate trend: ${formatPercent(ev.sevenDay.ratio)} aggregate`;

  const rows = buildRecoveryRows(ev);
  const showRetry = ev.state === "unknown" && isError;

  return (
    <section
      aria-label="Paperclip trust card"
      className="rounded-lg border border-border bg-card p-4 sm:p-5 space-y-4"
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <Icon aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 ${chrome.iconClass}`} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${chrome.chipClass}`}
                aria-label={`Trust state: ${ev.header}`}
              >
                {ev.header}
              </span>
              <span className="text-xs text-muted-foreground">Paperclip trust</span>
            </div>
            <p className="mt-1 text-sm font-medium">{ev.summary}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Target: failed runs below 10% and blocked work below 35%.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:flex-col sm:items-end">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Last 7 days</span>
          {ev.sevenDay.days.length > 0 ? (
            <Sparkline
              values={ev.sevenDay.days.map((d) => (d.total === 0 ? 0 : d.failed / d.total))}
              ariaLabel={sevenDayLabel}
            />
          ) : (
            <span className="text-xs text-muted-foreground">{sevenDayLabel}</span>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <Metric
          label="Blocked work"
          value={
            ev.blocked.status === "unknown"
              ? "Unknown"
              : ev.blocked.status === "zero"
              ? "0%"
              : formatPercent(ev.blocked.ratio)
          }
          sub={
            ev.blocked.status === "unknown"
              ? "Blocked-task data is not available."
              : ev.blocked.status === "zero"
              ? "No open work is blocked."
              : `${ev.blocked.numerator} of ${ev.blocked.denominator} open`
          }
        />
        <Metric
          label="Failed runs today"
          value={ev.failedToday.status === "unknown" ? "Unknown" : formatPercent(ev.failedToday.ratio)}
          sub={
            ev.failedToday.status === "unknown"
              ? ev.failedToday.denominator === 0
                ? "No run data today."
                : "Failed-run rate is not available."
              : `${ev.failedToday.numerator} of ${ev.failedToday.denominator} runs`
          }
        />
      </div>

      {showRetry && onRetry ? (
        <div>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent/50"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Retry dashboard
          </button>
        </div>
      ) : null}

      {rows.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recovery focus
          </h3>
          <ul className="mt-2 space-y-2">
            {rows.map((row) => (
              <li
                key={row.key}
                className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <span
                    className={`shrink-0 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide border ${toneBadgeClass(row.severityTone)}`}
                    aria-label={`Severity: ${toneLabel(row.severityTone)}`}
                  >
                    {toneLabel(row.severityTone)}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{row.label}</p>
                    <p className="text-xs text-muted-foreground">{row.evidence}</p>
                  </div>
                </div>
                <CtaButton cta={row.cta} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function TrustCardSkeleton(): ReactNode {
  return (
    <section
      aria-label="Paperclip trust card loading"
      className="rounded-lg border border-border bg-card p-4 sm:p-5 space-y-4"
    >
      <div className="flex items-start gap-3">
        <div className="h-5 w-5 rounded-full bg-muted/60 animate-pulse" />
        <div className="space-y-2 flex-1">
          <div className="h-4 w-32 bg-muted/60 animate-pulse rounded" />
          <div className="h-3 w-56 bg-muted/40 animate-pulse rounded" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <div className="h-3 w-24 bg-muted/40 animate-pulse rounded" />
          <div className="h-7 w-16 bg-muted/60 animate-pulse rounded" />
        </div>
        <div className="space-y-2">
          <div className="h-3 w-24 bg-muted/40 animate-pulse rounded" />
          <div className="h-7 w-16 bg-muted/60 animate-pulse rounded" />
        </div>
      </div>
    </section>
  );
}
