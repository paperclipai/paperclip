// Dependency-free, CSP-safe charts for the CPS board. Verdicts are STATES, so we
// use the app's status-color language (never color-alone: every segment is labeled
// with its count). Palette CVD-validated (dataviz skill): worst adjacent ΔE 27
// (light) / 18.5 (dark), above the 12 floor. 2px surface gaps between segments.

import type { ReactNode } from "react";
import type { CpsEquityCurve, CpsExperimentMetric } from "@paperclipai/shared";

type Style = { label: string; cls: string };

const VERDICT: Record<string, Style> = {
  LOCAL_VALIDATION_KILL: { label: "Kill", cls: "bg-rose-500 dark:bg-rose-400" },
  INCONCLUSIVE: { label: "Inconclusive", cls: "bg-slate-400 dark:bg-slate-500" },
  DATA_BLOCKED: { label: "Data-blocked", cls: "bg-amber-500 dark:bg-amber-400" },
  RULES_BLOCKED: { label: "Rules-blocked", cls: "bg-violet-500 dark:bg-violet-400" },
  SHADOW_ONLY: { label: "Shadow", cls: "bg-sky-500 dark:bg-sky-400" },
  LOCAL_PROXY_SUPPORTS_MECHANISM: { label: "Supports (review)", cls: "bg-emerald-500 dark:bg-emerald-400" },
  PROMOTE_TO_OPERATOR_DOSSIER: { label: "Promote", cls: "bg-teal-500 dark:bg-teal-400" },
};
const VERDICT_ORDER = [
  "LOCAL_VALIDATION_KILL", "INCONCLUSIVE", "DATA_BLOCKED", "RULES_BLOCKED",
  "SHADOW_ONLY", "LOCAL_PROXY_SUPPORTS_MECHANISM", "PROMOTE_TO_OPERATOR_DOSSIER",
];
const PROMO: Record<string, Style> = {
  do_not_promote: { label: "Do not promote", cls: "bg-rose-500 dark:bg-rose-400" },
  blocked: { label: "Blocked", cls: "bg-amber-500 dark:bg-amber-400" },
  needs_review: { label: "Needs review", cls: "bg-sky-500 dark:bg-sky-400" },
  promote: { label: "Promote", cls: "bg-emerald-500 dark:bg-emerald-400" },
};

type Seg = { key: string; label: string; count: number; cls: string };

function toSegs(counts: Record<string, number>, styles: Record<string, Style>, order?: string[]): Seg[] {
  const keys = order ? [...order, ...Object.keys(counts).filter((k) => !order.includes(k))] : Object.keys(counts);
  return keys
    .map((k) => ({ key: k, label: styles[k]?.label ?? k, count: counts[k] ?? 0, cls: styles[k]?.cls ?? "bg-muted-foreground/40" }))
    .filter((s) => s.count > 0);
}

function ProportionBar({ title, segs }: { title: string; segs: Seg[] }) {
  const total = segs.reduce((s, d) => s + d.count, 0);
  if (total === 0) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{total} total</span>
      </div>
      <div
        className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-muted/50"
        role="img"
        aria-label={`${title}: ${segs.map((d) => `${d.label} ${d.count}`).join(", ")}`}
      >
        {segs.map((d) => (
          <div
            key={d.key}
            className={`${d.cls} first:rounded-l-full last:rounded-r-full`}
            style={{ flexGrow: d.count }}
            title={`${d.label}: ${d.count} (${Math.round((d.count / total) * 100)}%)`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {segs.map((d) => (
          <span key={d.key} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={`h-2 w-2 shrink-0 rounded-full ${d.cls}`} />
            <span className="text-foreground">{d.label}</span>
            <span className="font-mono tabular-nums">{d.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Pool-level verdict + promotion mix — replaces cold number cards with an at-a-glance visual. */
export function VerdictOverview({ counts }: {
  counts: { judgmentByResultVerdict: Record<string, number>; judgmentByPromotionVerdict: Record<string, number> };
}) {
  const verdictSegs = toSegs(counts.judgmentByResultVerdict || {}, VERDICT, VERDICT_ORDER);
  const promoSegs = toSegs(counts.judgmentByPromotionVerdict || {}, PROMO, ["do_not_promote", "blocked", "needs_review", "promote"]);
  if (verdictSegs.length === 0 && promoSegs.length === 0) return null;
  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 text-sm font-semibold text-foreground">Judgment mix</div>
      <div className="grid gap-5 lg:grid-cols-2">
        <ProportionBar title="Result verdict" segs={verdictSegs} />
        <ProportionBar title="Promotion" segs={promoSegs} />
      </div>
    </section>
  );
}

/** Per-experiment honest-validation gate pass/fail bar (from index summary counts). */
export function GateBar({ passed, failed }: { passed?: number; failed?: number }) {
  const p = typeof passed === "number" ? passed : 0;
  const f = typeof failed === "number" ? failed : 0;
  if (p + f === 0) return null;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[11px] text-muted-foreground">
        <span>Validation gates</span>
        <span className="tabular-nums"><span className="text-emerald-600 dark:text-emerald-400">{p} pass</span> · <span className="text-rose-600 dark:text-rose-400">{f} fail</span></span>
      </div>
      <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted/50" role="img" aria-label={`${p} gates passed, ${f} failed`}>
        {p > 0 && <div className="bg-emerald-500 first:rounded-l-full last:rounded-r-full dark:bg-emerald-400" style={{ flexGrow: p }} title={`${p} passed`} />}
        {f > 0 && <div className="bg-rose-500 first:rounded-l-full last:rounded-r-full dark:bg-rose-400" style={{ flexGrow: f }} title={`${f} failed`} />}
      </div>
    </div>
  );
}

// ---- Per-strategy OOS metric bars (evidence-derived) ----
const DIVERGING = new Set(["signed", "pct_signed", "signed_bps"]);
const DOMAIN: Record<string, number> = { signed: 2, pct_signed: 0.5, signed_bps: 20, pct_neg: 0.6, ratio: 1, pvalue: 1 };

function fmtMetric(m: CpsExperimentMetric): string {
  switch (m.kind) {
    case "signed": return m.value.toFixed(2);
    case "signed_bps": return `${m.value.toFixed(1)} bps`;
    case "pct_signed":
    case "pct_neg": return `${(m.value * 100).toFixed(1)}%`;
    case "ratio": return `${(m.value * 100).toFixed(0)}%`;
    case "pvalue": return m.value.toFixed(3);
    default: return String(m.value);
  }
}

function MetricRow({ m }: { m: CpsExperimentMetric }) {
  const dom = DOMAIN[m.kind] ?? 1;
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
  const bar = DIVERGING.has(m.kind) ? (() => {
    const frac = clamp(m.value / dom, -1, 1);
    const pos = frac >= 0;
    return (
      <div className="relative h-2 w-full rounded-full bg-muted/50" title={`${m.key} = ${m.value}`}>
        <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
        <div
          className={`absolute inset-y-0 rounded-full ${pos ? "bg-emerald-500 dark:bg-emerald-400" : "bg-rose-500 dark:bg-rose-400"}`}
          style={pos ? { left: "50%", width: `${frac * 50}%` } : { left: `${50 + frac * 50}%`, width: `${-frac * 50}%` }}
        />
      </div>
    );
  })() : (() => {
    const w = clamp(Math.abs(m.value) / dom, 0, 1) * 100;
    const cls = m.kind === "pct_neg" ? "bg-rose-500 dark:bg-rose-400"
      : m.kind === "pvalue" ? (m.value < 0.1 ? "bg-emerald-500 dark:bg-emerald-400" : "bg-amber-500 dark:bg-amber-400")
        : "bg-sky-500 dark:bg-sky-400";
    return (
      <div className="h-2 w-full rounded-full bg-muted/50" title={`${m.key} = ${m.value}`}>
        <div className={`h-2 rounded-full ${cls}`} style={{ width: `${w}%` }} />
      </div>
    );
  })();
  return (
    <div className="grid grid-cols-[7.5rem_1fr_4.75rem] items-center gap-2">
      <span className="truncate text-[11px] text-muted-foreground" title={m.key}>{m.label}</span>
      {bar}
      <span className="text-right font-mono text-[11px] tabular-nums text-foreground">{fmtMetric(m)}</span>
    </div>
  );
}

// ---- Per-strategy equity curve (reconstructed from the trades CSV) ----

const SPLIT_LABELS: Record<string, string> = { train: "Train", validation: "Validation", val: "Validation", oos: "OOS", stress: "Stress", test: "Test" };
// Shade only the non-train regimes so the OOS section reads at a glance.
const SPLIT_FILL: Record<string, string> = {
  validation: "fill-slate-500/10 dark:fill-slate-400/10",
  val: "fill-slate-500/10 dark:fill-slate-400/10",
  oos: "fill-sky-500/10 dark:fill-sky-400/15",
  test: "fill-sky-500/10 dark:fill-sky-400/15",
  stress: "fill-amber-500/10 dark:fill-amber-400/15",
};

function fmtDateShort(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().slice(0, 10);
}

/**
 * Cumulative net-return line chart. Loading and "not measured" states are
 * rendered inside the same card so the section never jumps around.
 */
export function EquityCurve({ curve, loading }: { curve?: CpsEquityCurve | null; loading?: boolean }) {
  const W = 640;
  const H = 190;
  const PAD = { l: 10, r: 64, t: 14, b: 22 };

  let body: ReactNode;
  if (loading) {
    body = <div className="h-40 animate-pulse rounded-lg bg-muted/40" />;
  } else if (!curve || !curve.present || curve.points.length < 2) {
    body = (
      <div className="flex h-24 items-center justify-center rounded-lg bg-muted/30 text-xs text-muted-foreground">
        not measured{curve?.reason ? <span className="ml-1.5 font-mono text-[10px] opacity-70">· {curve.reason}</span> : null}
      </div>
    );
  } else {
    const pts = curve.points;
    const values = pts.map((p) => p.cumBps);
    const lo = Math.min(0, ...values);
    const hi = Math.max(0, ...values);
    const span = hi - lo || 1;
    const x = (i: number) => PAD.l + (i / (pts.length - 1)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - lo) / span) * (H - PAD.t - PAD.b);
    const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.cumBps).toFixed(1)}`).join(" ");
    const final = curve.finalCumBps ?? values[values.length - 1];
    const positive = final >= 0;
    // Region rects per split segment (boundaries carry the start index of each).
    const regions = curve.splitBoundaries.map((b, i) => {
      const endIndex = i + 1 < curve.splitBoundaries.length ? curve.splitBoundaries[i + 1].index : pts.length - 1;
      return { split: b.split, x0: x(b.index), x1: x(endIndex) };
    });
    body = (
      <>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
          aria-label={`Cumulative net return, ${curve.totalTrades} trades, final ${final.toFixed(1)} bps`}>
          {regions.map((r) => (
            SPLIT_FILL[r.split] ? <rect key={`${r.split}-${r.x0}`} x={r.x0} y={PAD.t} width={Math.max(0, r.x1 - r.x0)} height={H - PAD.t - PAD.b} className={SPLIT_FILL[r.split]} /> : null
          ))}
          {regions.filter((r) => SPLIT_LABELS[r.split]).map((r) => (
            <text key={`lbl-${r.split}-${r.x0}`} x={r.x0 + 4} y={PAD.t + 10} className="fill-muted-foreground" fontSize="9">{SPLIT_LABELS[r.split]}</text>
          ))}
          <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} className="stroke-border" strokeDasharray="3 3" strokeWidth="1" />
          <polyline points={line} fill="none" strokeWidth="1.6" strokeLinejoin="round"
            className={positive ? "stroke-emerald-500 dark:stroke-emerald-400" : "stroke-rose-500 dark:stroke-rose-400"} />
          <circle cx={x(pts.length - 1)} cy={y(final)} r="2.5" className={positive ? "fill-emerald-500 dark:fill-emerald-400" : "fill-rose-500 dark:fill-rose-400"} />
          <text x={x(pts.length - 1) + 6} y={y(final) + 3.5} fontSize="10" className={`font-mono ${positive ? "fill-emerald-600 dark:fill-emerald-400" : "fill-rose-600 dark:fill-rose-400"}`}>
            {final >= 0 ? "+" : ""}{final.toFixed(0)} bps
          </text>
          <text x={PAD.l} y={H - 6} fontSize="9" className="fill-muted-foreground">{fmtDateShort(pts[0].t)}</text>
          <text x={W - PAD.r} y={H - 6} fontSize="9" textAnchor="end" className="fill-muted-foreground">{fmtDateShort(pts[pts.length - 1].t)}</text>
        </svg>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <span>{curve.totalTrades} trades</span>
          <span>column <span className="font-mono">{curve.returnColumn}</span> from <span className="font-mono">{curve.csvName}</span></span>
          {regions.some((r) => r.split === "oos" || r.split === "test") ? <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-sky-500/20" /> OOS shaded</span> : null}
        </div>
      </>
    );
  }
  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-2 text-sm font-semibold text-foreground">Equity curve <span className="ml-1 font-normal text-muted-foreground">cumulative net, bps</span></div>
      {body}
    </section>
  );
}

/** Per-experiment OOS performance bars from the evidence oos_net summary. */
export function MetricBars({ metrics }: { metrics?: CpsExperimentMetric[] | null }) {
  if (!metrics || metrics.length === 0) return null;
  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 text-sm font-semibold text-foreground">OOS performance</div>
      <div className="flex flex-col gap-2">
        {metrics.map((m) => <MetricRow key={m.key} m={m} />)}
      </div>
      <div className="mt-2.5 text-[10px] text-muted-foreground">Evidence-derived from the run's <span className="font-mono">oos_net</span> summary · green favorable, red adverse</div>
    </section>
  );
}
