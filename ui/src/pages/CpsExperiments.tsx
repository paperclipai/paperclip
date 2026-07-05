import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BarChart3, CheckCircle2, ChevronDown, Clock, Database, FileJson, FileText, FlaskConical, HardDrive, KeyRound, Lightbulb, ListChecks, ListOrdered, MessagesSquare, ShieldCheck, Tag, X } from "lucide-react";
import type { CpsExperimentEntry, CpsExperimentOverview } from "@paperclipai/shared";
import { cpsExperimentsApi } from "../api/cps-experiments";
import { VerdictOverview, GateBar, MetricBars, EquityCurve } from "../components/cps/CpsCharts";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { Link } from "@/lib/router";

type FeedbackDraft = {
  label: string;
  correctedVerdict?: string | null;
  routeToRole?: string | null;
  comment?: string | null;
};

const QUICK_LABELS = ["agree", "disagree", "too_optimistic", "too_conservative", "wrong_blocker", "proceed_autonomously", "archive", "requires_approval"];

// cps.experiment_judgment.v1 result_verdict enum.
const RESULT_VERDICTS = [
  "PROMOTE_TO_OPERATOR_DOSSIER",
  "SHADOW_ONLY",
  "LOCAL_PROXY_SUPPORTS_MECHANISM",
  "LOCAL_VALIDATION_KILL",
  "DATA_BLOCKED",
  "RULES_BLOCKED",
  "INCONCLUSIVE",
];

// Blocker route_to_role enum (schema uses quant_review, not quant_research).
const ROUTE_ROLES = ["data_engineering", "quant_review", "platform_engineering", "board", "external_vendor"];

// Canonical cps.paper_progress.v1 stage order.
const PAPER_STAGES = ["intake", "decomposed", "inventory", "data_check", "replication", "oos_validation", "shadow", "dossier"];

const STAGE_SEGMENT_STYLES: Record<string, string> = {
  done: "bg-emerald-500",
  in_progress: "bg-sky-500",
  stuck: "bg-rose-500",
  skipped: "bg-slate-400",
  pending: "bg-muted",
};

// Entry kinds grouped into operator-meaningful tabs: real strategies, paper/idea
// intakes, and internal system runs (autonomous bundles, scaffolds, evals).
const KIND_GROUPS = [
  { key: "strategies", label: "Strategies", kinds: new Set(["strategy_experiment", "local_proxy_validation", "shadow_ledger"]) },
  { key: "papers", label: "Papers & ideas", kinds: new Set(["idea_intake", "paper_repair"]) },
] as const;

function groupOfKind(kind: string): string {
  for (const group of KIND_GROUPS) {
    if (group.kinds.has(kind)) return group.key;
  }
  return "system";
}

const VIEWABLE_EXTS = new Set(["json", "jsonl", "txt", "md", "csv", "log", "yaml", "yml", "py", "toml", "cfg", "ini", "html"]);

function isViewableFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return VIEWABLE_EXTS.has(ext);
}

function stageStatusMap(progress: CpsExperimentEntry["progress"]): Record<string, { status: string; blocker?: Record<string, unknown> | null }> {
  const out: Record<string, { status: string; blocker?: Record<string, unknown> | null }> = {};
  for (const raw of Array.isArray(progress?.stages) ? progress.stages : []) {
    const rec = recordValue(raw);
    const stage = scalar(rec?.stage);
    const status = scalar(rec?.status);
    if (stage && status) out[stage] = { status, blocker: recordValue(rec?.blocker) };
  }
  return out;
}

function StageBar({ progress, compact = false }: { progress: CpsExperimentEntry["progress"]; compact?: boolean }) {
  if (!progress) return null;
  const map = stageStatusMap(progress);
  return (
    <div className={`flex w-full gap-0.5 ${compact ? "mt-2" : ""}`} title={PAPER_STAGES.map((stage) => `${stage}: ${map[stage]?.status ?? "pending"}`).join("\n")}>
      {PAPER_STAGES.map((stage) => {
        const status = map[stage]?.status ?? "pending";
        return <div key={stage} className={`h-1.5 flex-1 rounded-full ${STAGE_SEGMENT_STYLES[status] ?? "bg-muted"}`} />;
      })}
    </div>
  );
}

const DECISION_STYLES: Record<string, string> = {
  KILL_ARCHIVE: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  KILL: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  BLOCKED_BY_DATA: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  UNLABELED: "border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300",
};

function decisionClass(decision: string | null) {
  return DECISION_STYLES[decision ?? "UNLABELED"] ?? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
}

function fmtDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function fmtBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  let n = value;
  for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
    if (n < 1024 || unit === "TB") return `${unit === "B" ? n : n.toFixed(1)}${unit}`;
    n /= 1024;
  }
  return `${n}B`;
}

function scalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  return null;
}

function pickMetric(entry: CpsExperimentEntry, keys: string[]): string | null {
  for (const key of keys) {
    const direct = scalar(entry.summary[key]);
    if (direct) return direct;
    for (const value of Object.values(entry.summary)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const nested = scalar((value as Record<string, unknown>)[key]);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function judgmentScalar(entry: CpsExperimentEntry, snakeKey: string, camelKey?: string): string | null {
  const judgment = entry.judgment;
  if (!judgment) return null;
  return scalar(judgment[snakeKey]) ?? (camelKey ? scalar(judgment[camelKey]) : null);
}

function judgmentStatus(entry: CpsExperimentEntry, snakeKey: string, camelKey?: string): string | null {
  const judgment = entry.judgment;
  if (!judgment) return null;
  return scalar(recordValue(judgment[snakeKey])?.status) ?? (camelKey ? scalar(recordValue(judgment[camelKey])?.status) : null);
}

function nextActionPrompt(entry: CpsExperimentEntry): string | null {
  const next = recordValue(entry.judgment?.next_action) ?? recordValue(entry.judgment?.nextAction);
  return scalar(next?.prompt);
}

function HeroStat({ label, value, tone = "default" }: { label: string; value: number | string; tone?: "default" | "danger" | "warn" | "ok" }) {
  const toneClass = tone === "danger" ? "text-rose-300" : tone === "warn" ? "text-amber-200" : tone === "ok" ? "text-emerald-300" : "text-white";
  return (
    <span className="inline-flex items-baseline gap-1.5 rounded-lg bg-white/10 px-2.5 py-1">
      <span className={`font-mono text-sm font-semibold tabular-nums ${toneClass}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-slate-300">{label}</span>
    </span>
  );
}

// ---- Artifact file viewer (modal) ----

function CsvTable({ text }: { text: string }) {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const header = (lines[0] ?? "").split(",");
  const rows = lines.slice(1, 101).map((line) => line.split(","));
  const more = lines.length - 1 - rows.length;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[11px]">
        <thead>
          <tr className="border-b border-border">
            {header.map((cell, i) => <th key={i} className="whitespace-nowrap px-2 py-1.5 font-mono font-semibold text-muted-foreground">{cell}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-border/40">
              {row.map((cell, ci) => <td key={ci} className="whitespace-nowrap px-2 py-1 font-mono text-foreground/90">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 ? <div className="px-2 py-1.5 text-[11px] text-muted-foreground">… {more} more rows (download the artifact for the full file)</div> : null}
    </div>
  );
}

function FileViewerModal({ companyId, experimentId, name, onClose }: { companyId: string; experimentId: string; name: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["cps-file", companyId, experimentId, name],
    queryFn: () => cpsExperimentsApi.file(companyId, experimentId, name),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  let body: ReactNode;
  if (isLoading) {
    body = <div className="h-48 animate-pulse rounded-lg bg-muted/40" />;
  } else if (error || !data) {
    body = <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">Could not load this file: {error instanceof Error ? error.message : "not available"}</div>;
  } else if (data.contentType === "csv") {
    body = <CsvTable text={data.content} />;
  } else if (data.contentType === "json") {
    let pretty = data.content;
    try { pretty = JSON.stringify(JSON.parse(data.content), null, 2); } catch { /* show raw */ }
    body = <pre className="whitespace-pre-wrap break-words text-[11px] leading-5 text-foreground/90">{pretty}</pre>;
  } else {
    body = <pre className="whitespace-pre-wrap break-words text-[11px] leading-5 text-foreground/90">{data.content}</pre>;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="font-mono text-sm font-semibold text-foreground">{name}</span>
              {data ? <span className="text-[11px] text-muted-foreground">{fmtBytes(data.bytes)}</span> : null}
              {data?.truncated ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">truncated to 512KB</span> : null}
            </div>
            {data ? <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={data.path}>{data.path}</div> : null}
          </div>
          <button type="button" onClick={onClose} className="rounded-full border border-border p-1.5 text-muted-foreground transition hover:text-foreground" aria-label="Close file viewer">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-auto p-4">{body}</div>
      </div>
    </div>
  );
}

// ---- Compact expandable ops tile (merges the former full-width sections) ----

function OpsTile({ title, icon: Icon, headline, sub, badge, children }: {
  title: string;
  icon: typeof Clock;
  headline: string;
  sub: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-2xl border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-3 p-3 [&::-webkit-details-marker]:hidden">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">{title}{badge}</div>
          <div className="truncate text-[11px] text-muted-foreground">{sub}</div>
        </div>
        <span className="shrink-0 font-mono text-sm tabular-nums text-foreground">{headline}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition group-open:rotate-180" />
      </summary>
      <div className="border-t border-border p-3">{children}</div>
    </details>
  );
}

function TileBadge({ tone, children }: { tone: "warn" | "danger"; children: ReactNode }) {
  const cls = tone === "danger"
    ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
    : "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>{children}</span>;
}

// ---- Needs-you panel: every human-required item in one place ----

type NeedsYouItem = {
  key: string;
  text: string;
  sub?: string;
  link?: string | null;
  experimentId?: string;
};

function collectNeedsYou(data: CpsExperimentOverview): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const [index, action] of (data.operatorActions ?? []).entries()) {
    items.push({
      key: `action-${action.experimentId}-${action.stage}-${index}`,
      text: action.simpleAsk,
      sub: `${action.experimentId} · stage ${action.stage}${action.kind ? ` · ${action.kind}` : ""}`,
      link: action.link,
      experimentId: action.experimentId,
    });
  }
  if (data.backtestQueue?.starving) {
    items.push({ key: "queue-starving", text: "Backtests are waiting but no worker is reachable — wake a worker box (lillith / AMD-minis / finance-1). Nothing is rented or spent automatically." });
  }
  if (data.backtestQueue?.stopPresent) {
    items.push({ key: "queue-paused", text: "The backtest queue is paused (STOP file present)." });
  }
  for (const sub of data.dataInventory?.subscriptions.filter((s) => s.status !== "have") ?? []) {
    items.push({ key: `sub-${sub.provider}-${sub.subscription}`, text: `${sub.provider}: ${sub.subscription}`, sub: `unlocks ${sub.unlocks}`, link: sub.link || null });
  }
  if (data.toolCatalog?.present && data.toolCatalog.notReady.length) {
    items.push({ key: "tools-not-ready", text: `Tools not ready: ${data.toolCatalog.notReady.join(", ")}`, sub: "these become install tasks or asks — nothing installs itself" });
  }
  return items;
}

function NeedsYouPanel({ data, onView }: { data: CpsExperimentOverview; onView: (experimentId: string) => void }) {
  const items = collectNeedsYou(data);
  const chatHint = (
    <Link to="/board-chat" className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-500/10 px-3 py-1 text-[11px] font-semibold text-sky-700 transition hover:bg-sky-500/20 dark:text-sky-300">
      <MessagesSquare className="h-3.5 w-3.5" /> Conference Room — paste keys, answer asks, unblock the team
    </Link>
  );
  if (items.length === 0) {
    return (
      <section className="flex flex-wrap items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-2.5">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="text-xs text-emerald-800 dark:text-emerald-200">All clear — nothing needs you right now.</span>
        <span className="ml-auto">{chatHint}</span>
      </section>
    );
  }
  return (
    <section className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
        <AlertTriangle className="h-4 w-4" /> Needs you — only you can unblock these ({items.length})
        <span className="ml-auto">{chatHint}</span>
      </div>
      <div className="grid gap-1.5">
        {items.map((item) => (
          <div key={item.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card px-3 py-2 text-xs">
            <div className="min-w-0">
              <span className="text-foreground">{item.text}</span>
              {item.sub ? <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{item.sub}</div> : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {item.link ? (
                <a href={item.link} target="_blank" rel="noreferrer" className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 font-semibold text-amber-800 transition hover:bg-amber-500/20 dark:text-amber-200">Open link</a>
              ) : null}
              {item.experimentId ? (
                <button type="button" onClick={() => onView(item.experimentId!)} className="rounded-full border border-border px-3 py-1 text-muted-foreground transition hover:text-foreground">View</button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Operator credential drop: the value goes straight to the pods' env file on
// the box — never into the Paperclip DB — and the consumer gets a run request.
function CredentialDropForm({ companyId }: { companyId: string }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const mutation = useMutation({
    mutationFn: () => cpsExperimentsApi.provideCredential(companyId, { name: name.trim(), value, note: note.trim() || null }),
    onSuccess: (drop) => {
      setResult({ ok: true, text: `${drop.name} ${drop.replacedExisting ? "updated" : "added"} in ${drop.envPath} — the team was notified (run ${drop.runRequestId}). The value is never shown again.` });
      setName("");
      setValue("");
      setNote("");
    },
    onError: (err) => setResult({ ok: false, text: `Could not store the credential: ${err instanceof Error ? err.message : String(err)}` }),
  });
  const validName = /^[A-Z][A-Z0-9_]{1,63}$/.test(name.trim());
  return (
    <details className="rounded-2xl border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 p-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <KeyRound className="h-4 w-4 text-muted-foreground" /> Provide a credential
        <span className="text-[10px] font-normal text-muted-foreground">API keys go to the pods&apos; env file on this box — never into the database</span>
        <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
      </summary>
      <div className="border-t border-border p-4">
        <div className="grid gap-2 sm:grid-cols-[14rem_1fr_auto]">
          <input
            value={name}
            onChange={(event) => setName(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            placeholder="NAME, e.g. ALPACA_API_KEY"
            autoComplete="off"
            spellCheck={false}
            className="rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary"
          />
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Paste the secret value"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            className="rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary"
          />
          <button
            type="button"
            disabled={mutation.isPending || !validName || !value.trim()}
            onClick={() => { setResult(null); mutation.mutate(); }}
            className="rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {mutation.isPending ? "Storing…" : "Store & notify team"}
          </button>
        </div>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Note for the team (optional) — e.g. which ask this resolves"
          maxLength={500}
          className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
        />
        {result ? (
          <div className={`mt-2 rounded-lg px-3 py-2 text-xs ${result.ok ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200" : "bg-rose-500/10 text-rose-700 dark:text-rose-300"}`}>{result.text}</div>
        ) : null}
      </div>
    </details>
  );
}

function EntryCard({ entry, selected, onSelect }: { entry: CpsExperimentEntry; selected: boolean; onSelect: () => void }) {
  const mechanism = scalar(entry.summary.mechanism) ?? scalar(entry.summary.source_inspiration) ?? scalar(entry.summary.sourceInspiration);
  const oosMean = pickMetric(entry, ["mean_bps_event", "active_mean_bps_day", "event_mean_bps", "mean_bps_day"]);
  const oosSharpe = pickMetric(entry, ["event_sharpe_ann_sqrt52", "ann_sharpe", "event_sharpe_sqrtN"]);
  const resultVerdict = judgmentScalar(entry, "result_verdict", "resultVerdict");
  const dataFit = judgmentStatus(entry, "data_fit", "dataFit");
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-2xl border p-4 text-left transition ${selected ? "border-primary bg-primary/5 shadow-sm" : "border-border bg-card hover:border-primary/40"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-mono">{entry.kind}</span>
            <span>·</span>
            <span>{entry.status}</span>
          </div>
          <div className="mt-1 truncate text-sm font-semibold text-foreground" title={entry.id}>{entry.id}</div>
          {mechanism ? <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{mechanism}</div> : null}
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${decisionClass(entry.decision)}`}>
          {entry.decision ?? "UNLABELED"}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
        <div className="rounded-lg bg-muted/50 px-2 py-1">Updated: <span className="font-mono text-foreground">{fmtDate(entry.updatedUtc)}</span></div>
        <div className="rounded-lg bg-muted/50 px-2 py-1">Files: <span className="font-mono text-foreground">{entry.files.length}</span></div>
        {resultVerdict ? <div className="rounded-lg bg-muted/50 px-2 py-1">Judgment: <span className="font-mono text-foreground">{resultVerdict}</span></div> : null}
        {dataFit ? <div className="rounded-lg bg-muted/50 px-2 py-1">Data: <span className="font-mono text-foreground">{dataFit}</span></div> : null}
        {entry.operatorLabels?.count ? (
          <div className="rounded-lg bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300">
            Labeled: <span className="font-mono">{entry.operatorLabels.latestLabel}</span>{entry.operatorLabels.count > 1 ? ` ×${entry.operatorLabels.count}` : ""}
          </div>
        ) : null}
        {oosMean ? <div className="rounded-lg bg-muted/50 px-2 py-1">Mean: <span className="font-mono text-foreground">{oosMean}</span></div> : null}
        {oosSharpe ? <div className="rounded-lg bg-muted/50 px-2 py-1">Sharpe: <span className="font-mono text-foreground">{oosSharpe}</span></div> : null}
      </div>
      <StageBar progress={entry.progress ?? null} compact />
    </button>
  );
}

function EntryDetail({
  companyId,
  entry,
  onQueueFollowUp,
  onQueueJudgmentNext,
  onQueueGenerateJudgment,
  onCreateFeedback,
  isQueueing,
  isLabeling,
  queuedId,
  labeledId,
}: {
  companyId: string;
  entry: CpsExperimentEntry;
  onQueueFollowUp: (entry: CpsExperimentEntry) => void;
  onQueueJudgmentNext: (entry: CpsExperimentEntry) => void;
  onQueueGenerateJudgment: (entry: CpsExperimentEntry) => void;
  onCreateFeedback: (entry: CpsExperimentEntry, draft: FeedbackDraft) => void;
  isQueueing: boolean;
  isLabeling: boolean;
  queuedId: string | null;
  labeledId: string | null;
}) {
  const [correctionLabel, setCorrectionLabel] = useState("disagree");
  const [correctedVerdict, setCorrectedVerdict] = useState("");
  const [routeToRole, setRouteToRole] = useState("");
  const [comment, setComment] = useState("");
  const [viewingFile, setViewingFile] = useState<string | null>(null);

  useEffect(() => {
    setCorrectionLabel("disagree");
    setCorrectedVerdict("");
    setRouteToRole("");
    setComment("");
    setViewingFile(null);
  }, [entry.id]);

  const { data: equity, isLoading: equityLoading } = useQuery({
    queryKey: ["cps-equity", companyId, entry.id],
    queryFn: () => cpsExperimentsApi.equity(companyId, entry.id),
    staleTime: 5 * 60_000,
  });

  const failing = Array.isArray(entry.summary.failing_gates) ? entry.summary.failing_gates.filter((x): x is string => typeof x === "string") : [];
  const safety = entry.summary.safety && typeof entry.summary.safety === "object" ? entry.summary.safety as Record<string, unknown> : null;
  const resultVerdict = judgmentScalar(entry, "result_verdict", "resultVerdict");
  const promotionVerdict = judgmentScalar(entry, "promotion_verdict", "promotionVerdict");
  const rulesStatus = judgmentStatus(entry, "rules_disclosure", "rulesDisclosure");
  const dataStatus = judgmentStatus(entry, "data_fit", "dataFit");
  const executionStatus = judgmentStatus(entry, "execution_fit", "executionFit");
  const nextPrompt = nextActionPrompt(entry);
  const blockers = Array.isArray(entry.judgment?.blockers) ? entry.judgment.blockers : [];

  // Every artifact the index knows about, sidecars included; primary JSON first.
  const artifactNames = useMemo(() => {
    const names = new Set<string>();
    if (entry.primaryJson) names.add(entry.primaryJson);
    for (const file of entry.files) names.add(file);
    if (entry.judgmentPath) names.add("JUDGMENT.json");
    if (entry.progressPath) names.add("PROGRESS.json");
    return Array.from(names);
  }, [entry]);

  return (
    <div className="flex flex-col gap-4">
      {viewingFile ? (
        <FileViewerModal companyId={companyId} experimentId={entry.id} name={viewingFile} onClose={() => setViewingFile(null)} />
      ) : null}

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-foreground">{entry.kind}</span>
          <span>{entry.status}</span>
          <span>· updated {fmtDate(entry.updatedUtc)}</span>
        </div>
        <h2 className="mt-2 break-words text-xl font-semibold tracking-tight text-foreground">{entry.id}</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${decisionClass(entry.decision)}`}>{entry.decision ?? "UNLABELED"}</span>
          {entry.primaryJson ? (
            <button
              type="button"
              onClick={() => isViewableFile(entry.primaryJson!) && setViewingFile(entry.primaryJson)}
              className="rounded-full border border-border bg-muted px-2.5 py-0.5 font-mono text-xs transition hover:border-primary/40 hover:text-foreground"
              title="Open evidence JSON"
            >
              {entry.primaryJson}
            </button>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onQueueFollowUp(entry)}
            disabled={isQueueing}
            className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isQueueing ? "Queueing…" : "Queue bounded CPS follow-up"}
          </button>
          <button
            type="button"
            onClick={() => onQueueJudgmentNext(entry)}
            disabled={isQueueing || !nextPrompt}
            className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-60 dark:text-emerald-300"
          >
            {isQueueing ? "Queueing…" : "Run judgment next action"}
          </button>
          {queuedId ? <span className="rounded-full bg-emerald-500/10 px-3 py-1.5 font-mono text-xs text-emerald-700 dark:text-emerald-300">queued {queuedId}</span> : null}
        </div>
        {typeof entry.summary.gate_pass_count === "number" || typeof entry.summary.gate_fail_count === "number" ? (
          <div className="mt-4 max-w-sm">
            <GateBar passed={entry.summary.gate_pass_count as number} failed={entry.summary.gate_fail_count as number} />
          </div>
        ) : null}
      </section>

      <EquityCurve curve={equity} loading={equityLoading} />

      <MetricBars metrics={entry.metrics} />

      {entry.judgment ? (
        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><FileJson className="h-4 w-4 text-emerald-500" /> Judgment</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {resultVerdict ? <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs"><span className="text-muted-foreground">Result verdict</span><div className="font-mono text-foreground">{resultVerdict}</div></div> : null}
            {promotionVerdict ? <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs"><span className="text-muted-foreground">Promotion</span><div className="font-mono text-foreground">{promotionVerdict}</div></div> : null}
            {rulesStatus ? <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs"><span className="text-muted-foreground">Rules</span><div className="font-mono text-foreground">{rulesStatus}</div></div> : null}
            {dataStatus ? <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs"><span className="text-muted-foreground">Data</span><div className="font-mono text-foreground">{dataStatus}</div></div> : null}
            {executionStatus ? <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs"><span className="text-muted-foreground">Execution</span><div className="font-mono text-foreground">{executionStatus}</div></div> : null}
            {typeof entry.judgment.confidence === "number" ? <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs"><span className="text-muted-foreground">Confidence</span><div className="font-mono text-foreground">{entry.judgment.confidence}</div></div> : null}
          </div>
          {blockers.length ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {blockers.map((blocker, index) => <span key={`${scalar(blocker.kind) ?? "blocker"}-${index}`} className="rounded-md bg-amber-500/10 px-2 py-1 font-mono text-xs text-amber-700 dark:text-amber-300">{scalar(blocker.kind) ?? "blocker"}: {scalar(blocker.description) ?? scalar(blocker.route_to_role) ?? "see JSON"}</span>)}
            </div>
          ) : null}
          {nextPrompt ? <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-muted/40 p-3 text-xs leading-5 text-foreground/90">{nextPrompt}</pre> : null}

          <div className="mt-4 border-t border-border pt-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground"><Tag className="h-3.5 w-3.5" /> Operator label</div>
            {entry.operatorLabels?.count ? (
              <div className="mb-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300">
                {entry.operatorLabels.count} label{entry.operatorLabels.count > 1 ? "s" : ""} · latest <span className="font-mono">{entry.operatorLabels.latestLabel}</span>
                {entry.operatorLabels.latestCorrectedVerdict ? <> · corrected → <span className="font-mono">{entry.operatorLabels.latestCorrectedVerdict}</span></> : null}
                {entry.operatorLabels.latestRouteToRole ? <> · routed → <span className="font-mono">{entry.operatorLabels.latestRouteToRole}</span></> : null}
                {entry.operatorLabels.latestAt ? <> · {fmtDate(entry.operatorLabels.latestAt)}</> : null}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              {QUICK_LABELS.map((label) => (
                <button key={label} type="button" onClick={() => onCreateFeedback(entry, { label })} disabled={isLabeling} className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60">
                  {label.replace(/_/g, " ")}
                </button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => onCreateFeedback(entry, { label: "wrong_blocker", routeToRole: "data_engineering", comment: "Quick route: needs data engineering." })}
                disabled={isLabeling}
                className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-800 transition hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-60 dark:text-amber-300"
              >
                needs data engineering
              </button>
              <button
                type="button"
                onClick={() => onCreateFeedback(entry, { label: "wrong_blocker", routeToRole: "quant_review", comment: "Quick route: needs execution realism review." })}
                disabled={isLabeling}
                className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-[11px] font-semibold text-sky-800 transition hover:bg-sky-500/15 disabled:cursor-not-allowed disabled:opacity-60 dark:text-sky-300"
              >
                needs execution realism
              </button>
              {labeledId ? <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] text-emerald-700 dark:text-emerald-300">labeled {labeledId}</span> : null}
            </div>

            <details className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
              <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">Correction form</summary>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                  Label
                  <select value={correctionLabel} onChange={(event) => setCorrectionLabel(event.target.value)} className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary">
                    {QUICK_LABELS.map((label) => <option key={label} value={label}>{label.replace(/_/g, " ")}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                  Corrected verdict
                  <select value={correctedVerdict} onChange={(event) => setCorrectedVerdict(event.target.value)} className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary">
                    <option value="">— keep verdict —</option>
                    {RESULT_VERDICTS.map((verdict) => <option key={verdict} value={verdict}>{verdict}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                  Re-route blocker to
                  <select value={routeToRole} onChange={(event) => setRouteToRole(event.target.value)} className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary">
                    <option value="">— no re-route —</option>
                    {ROUTE_ROLES.map((role) => <option key={role} value={role}>{role.replace(/_/g, " ")}</option>)}
                  </select>
                </label>
              </div>
              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Free-text correction: what the judgment got wrong, what evidence it missed, what should happen instead…"
                rows={3}
                maxLength={2000}
                className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onCreateFeedback(entry, { label: correctionLabel, correctedVerdict: correctedVerdict || null, routeToRole: routeToRole || null, comment: comment.trim() || null })}
                  disabled={isLabeling}
                  className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isLabeling ? "Saving…" : "Save correction label"}
                </button>
                <span className="text-[11px] text-muted-foreground">Appends to LABELS.jsonl — never edits JUDGMENT.json directly.</span>
              </div>
            </details>
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-dashed border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">
            No `JUDGMENT.json` found yet. Queue `generate_judgment` to turn this experiment into training data — the executor emits a conservative draft (INCONCLUSIVE, needs_review) that you can then correct.
          </div>
          <button
            type="button"
            onClick={() => onQueueGenerateJudgment(entry)}
            disabled={isQueueing}
            className="mt-3 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isQueueing ? "Queueing…" : "Queue generate_judgment"}
          </button>
        </section>
      )}

      {entry.progress ? (
        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><ListChecks className="h-4 w-4 text-sky-500" /> Paper progress</div>
          <StageBar progress={entry.progress} />
          <div className="mt-3 grid gap-1.5">
            {PAPER_STAGES.map((stage) => {
              const info = stageStatusMap(entry.progress)[stage];
              const status = info?.status ?? "pending";
              const blocker = info?.blocker;
              const humanRequired = blocker?.human_required === true || blocker?.humanRequired === true;
              const chipClass = status === "done" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : status === "in_progress" ? "bg-sky-500/10 text-sky-700 dark:text-sky-300"
                : status === "stuck" ? "bg-rose-500/10 text-rose-700 dark:text-rose-300"
                : "bg-muted/50 text-muted-foreground";
              return (
                <div key={stage} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-1.5 text-xs">
                    <span className="text-foreground">{stage.replace(/_/g, " ")}</span>
                    <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${chipClass}`}>{status.replace(/_/g, " ")}</span>
                  </div>
                  {status === "stuck" && blocker ? (
                    <div className={`rounded-lg px-3 py-2 text-xs ${humanRequired ? "bg-amber-500/10 text-amber-800 dark:text-amber-200" : "bg-muted/50 text-muted-foreground"}`}>
                      {humanRequired ? <span className="font-semibold">Needs you: </span> : <span className="font-semibold">Blocked: </span>}
                      {scalar(blocker.simple_ask) ?? scalar(blocker.simpleAsk) ?? scalar(blocker.kind) ?? "see PROGRESS.json"}
                      {scalar(blocker.link) ? (
                        <a href={scalar(blocker.link)!} target="_blank" rel="noreferrer" className="ml-2 underline">Open link</a>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {failing.length ? (
        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-amber-500" /> Failing gates</div>
          <div className="flex flex-wrap gap-1.5">
            {failing.map((gate) => <span key={gate} className="rounded-md bg-amber-500/10 px-2 py-1 font-mono text-xs text-amber-700 dark:text-amber-300">{gate}</span>)}
          </div>
        </section>
      ) : null}

      {safety ? (
        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-emerald-500" /> Safety flags</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(safety).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-1.5 text-xs">
                <span className="text-muted-foreground">{key.replace(/_/g, " ")}</span>
                <span className="font-mono text-foreground">{String(value)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {artifactNames.length ? (
        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><FileText className="h-4 w-4 text-muted-foreground" /> Artifacts <span className="font-normal text-muted-foreground">({artifactNames.length})</span></div>
          <div className="flex flex-wrap gap-1.5">
            {artifactNames.map((name) => {
              const viewable = isViewableFile(name);
              return viewable ? (
                <button
                  key={name}
                  type="button"
                  onClick={() => setViewingFile(name)}
                  className="rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs text-foreground transition hover:border-primary/40 hover:bg-primary/5"
                  title="Click to view"
                >
                  {name}
                </button>
              ) : (
                <span key={name} className="rounded-md border border-border/50 bg-muted/20 px-2 py-1 font-mono text-xs text-muted-foreground" title="Binary artifact — not viewable inline">
                  {name}
                </span>
              );
            })}
          </div>
        </section>
      ) : null}

      <details className="rounded-2xl border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center gap-2 p-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <FileJson className="h-4 w-4 text-muted-foreground" /> Summary JSON
          <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
        </summary>
        <pre className="max-h-96 overflow-auto border-t border-border bg-muted/40 p-3 text-xs leading-5 text-foreground/90">{JSON.stringify(entry.summary, null, 2)}</pre>
      </details>
    </div>
  );
}

export function CpsExperiments() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [groupFilter, setGroupFilter] = useState("strategies");
  const [decisionFilter, setDecisionFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [queuedId, setQueuedId] = useState<string | null>(null);
  const [labeledId, setLabeledId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard", href: "/dashboard" }, { label: "Research Lab" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading } = useQuery({
    queryKey: ["cps-experiments", selectedCompanyId],
    queryFn: () => cpsExperimentsApi.overview(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 60_000,
  });

  const queryClient = useQueryClient();

  const queueMutation = useMutation({
    mutationFn: ({ entry, mode }: { entry: CpsExperimentEntry; mode: "generic" | "judgment_next" | "generate_judgment" }) => {
      const prompt = mode === "judgment_next"
        ? nextActionPrompt(entry) ?? `Generate or revise the CPS JUDGMENT.json for ${entry.id}. Preserve safety boundaries: no broker actions, no signal publishing, no paid data unless explicitly approved.`
        : mode === "generate_judgment"
          ? `Generate a typed JUDGMENT.json for ${entry.id} from existing local artifacts only. Never invent missing rules or results; if evidence is insufficient, emit INCONCLUSIVE with needs_review and low confidence. No broker actions, no signal publishing, no paid data.`
          : `Paperclip operator requested a bounded CPS follow-up for ${entry.id}. Review the artifact, preserve the current verdict unless evidence changes, and only run safe local research/backtest steps. No broker actions, no signal publishing. If data/paid API is needed, stop and report the exact need unless already explicitly allowed by the request.`;
      return cpsExperimentsApi.createRunRequest(selectedCompanyId!, {
        action: mode === "judgment_next" ? "run_next_safe_action" : mode === "generate_judgment" ? "generate_judgment" : (entry.decision === "KILL_ARCHIVE" || entry.decision === "KILL" ? "investigate_near_miss" : "rerun_with_variant"),
        experimentId: entry.id,
        prompt,
        maxRuntimeMinutes: mode === "judgment_next" ? 120 : mode === "generate_judgment" ? 60 : 90,
        allowPaidData: false,
        allowPaidCompute: false,
      });
    },
    onSuccess: (request) => setQueuedId(request.id),
  });

  const labelMutation = useMutation({
    mutationFn: ({ entry, draft }: { entry: CpsExperimentEntry; draft: FeedbackDraft }) => cpsExperimentsApi.createJudgmentFeedback(selectedCompanyId!, {
      experimentId: entry.id,
      ...draft,
    }),
    onSuccess: (feedback) => {
      setLabeledId(feedback.id);
      void queryClient.invalidateQueries({ queryKey: ["cps-experiments", selectedCompanyId] });
    },
  });

  const [ideaText, setIdeaText] = useState("");
  const [ideaUrl, setIdeaUrl] = useState("");
  const [ideaTitle, setIdeaTitle] = useState("");
  const [ideaSourceType, setIdeaSourceType] = useState<"x_post" | "article" | "paper" | "other">("x_post");
  const [ideaResult, setIdeaResult] = useState<string | null>(null);
  const ideaMutation = useMutation({
    mutationFn: () => cpsExperimentsApi.createIdea(selectedCompanyId!, {
      sourceType: ideaSourceType,
      pastedText: ideaText,
      url: ideaUrl.trim() || null,
      title: ideaTitle.trim() || null,
    }),
    onSuccess: (idea) => {
      setIdeaResult(`Idea ${idea.id} captured — snapshot ${idea.snapshot.fetchStatus}, decomposition queued (${idea.runRequestId}). It appears below as an experiment card within the next consumer cycle (~15 min).`);
      setIdeaText("");
      setIdeaUrl("");
      setIdeaTitle("");
      void queryClient.invalidateQueries({ queryKey: ["cps-experiments", selectedCompanyId] });
    },
    onError: (err) => setIdeaResult(`Could not capture the idea: ${err instanceof Error ? err.message : String(err)}`),
  });

  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0, strategies: 0, papers: 0, system: 0 };
    for (const entry of data?.entries ?? []) {
      counts.all += 1;
      counts[groupOfKind(entry.kind)] += 1;
    }
    return counts;
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return data.entries.filter((entry) => {
      if (groupFilter !== "all" && groupOfKind(entry.kind) !== groupFilter) return false;
      if (decisionFilter !== "all" && (entry.decision ?? "UNLABELED") !== decisionFilter) return false;
      if (term) {
        const haystack = `${entry.id} ${entry.kind} ${entry.decision ?? ""} ${entry.primaryJson ?? ""} ${JSON.stringify(entry.summary)} ${JSON.stringify(entry.judgment ?? {})}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [data, groupFilter, decisionFilter, search]);

  const selected = useMemo(() => filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null, [filtered, selectedId]);

  // "View" on a needs-you item must always reveal the experiment, so clear any
  // filter that would hide it.
  const revealExperiment = (experimentId: string) => {
    setGroupFilter("all");
    setDecisionFilter("all");
    setSearch("");
    setSelectedId(experimentId);
  };

  if (!selectedCompanyId) return <EmptyState icon={FlaskConical} message="Select a company to view CPS experiments." />;
  if (isLoading || !data) return <PageSkeleton variant="dashboard" />;

  const decisionOptions = Object.keys(data.counts.byDecision).sort((a, b) => (data.counts.byDecision[b] ?? 0) - (data.counts.byDecision[a] ?? 0));

  if (!data.source.present) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <EmptyState icon={AlertTriangle} message={`CPS experiment index not found at ${data.source.indexPath}. Nothing to show yet.`} />
      </div>
    );
  }

  const emptyMessage = data.counts.total === 0 ? "No CPS experiments are recorded in the local index yet." : "No experiments match the current filters.";
  const judgmentTotal = Object.values(data.counts.judgmentByResultVerdict).reduce((sum, value) => sum + value, 0);
  const killedTotal = data.counts.strategyByDecision.KILL_ARCHIVE ?? data.counts.judgmentByResultVerdict.LOCAL_VALIDATION_KILL ?? 0;
  const blockedTotal = (data.counts.judgmentByResultVerdict.DATA_BLOCKED ?? 0) + (data.counts.judgmentByResultVerdict.RULES_BLOCKED ?? 0) + (data.counts.strategyByDecision.BLOCKED_BY_DATA ?? 0);
  const promoteTotal = (data.counts.judgmentByResultVerdict.PROMOTE_TO_OPERATOR_DOSSIER ?? 0) + (data.counts.strategyByDecision.PROMOTE_TO_OPERATOR_DOSSIER ?? 0);

  const queue = data.backtestQueue;
  const inventory = data.dataInventory;
  const catalog = data.toolCatalog;

  return (
    <div className="mx-auto flex max-w-[110rem] flex-col gap-4 p-6">
      <section className="overflow-hidden rounded-2xl border border-slate-900/10 bg-[radial-gradient(circle_at_20%_20%,rgba(16,185,129,0.18),transparent_35%),linear-gradient(135deg,#07111f,#111827_55%,#0f172a)] p-4 text-white shadow-xl">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Research lab</h1>
            <p className="mt-0.5 max-w-xl text-xs leading-5 text-slate-300">
              Everything the company has tested — strategies, paper replications (GPTL/CPS), and autonomous system runs. Read-only; actions queue bounded research.
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] ${data.source.stale ? "bg-amber-500/20 text-amber-100" : "bg-emerald-500/20 text-emerald-100"}`} title={data.source.indexPath}>
              <Clock className="h-3 w-3" /> {data.source.stale ? "stale" : "fresh"} · {data.source.ageSeconds !== null ? `${Math.round(data.source.ageSeconds / 60)}m` : "—"}
            </span>
            <HeroStat label="entries" value={data.counts.total} />
            <HeroStat label="judged" value={judgmentTotal} tone="ok" />
            <HeroStat label="killed" value={killedTotal} tone="danger" />
            <HeroStat label="blocked" value={blockedTotal} tone="warn" />
            <HeroStat label="promote" value={promoteTotal} tone="ok" />
          </div>
        </div>
      </section>

      <NeedsYouPanel data={data} onView={revealExperiment} />

      <CredentialDropForm companyId={selectedCompanyId} />

      <VerdictOverview counts={data.counts} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {queue && (queue.present || queue.lastTick) ? (
          <OpsTile
            title="Backtest queue"
            icon={ListOrdered}
            headline={`${queue.summary?.pending ?? 0} waiting`}
            sub={`${(queue.summary?.leased ?? 0) + (queue.summary?.running ?? 0)} running · ${queue.lastTick ? `${queue.lastTick.reachableWorkers.length}/${Object.keys(queue.lastTick.probedWorkers).length} workers up` : "no tick yet"}`}
            badge={queue.starving ? <TileBadge tone="danger">starving</TileBadge> : queue.stopPresent ? <TileBadge tone="warn">paused</TileBadge> : null}
          >
            <div className="grid gap-2 text-xs">
              <div className="rounded-lg bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">Waiting</span>
                <div className="font-mono text-lg text-foreground">{queue.summary?.pending ?? 0}</div>
                <div className="text-muted-foreground">
                  {queue.oldestPendingAgeSeconds !== null && queue.oldestPendingAgeSeconds !== undefined ? `oldest ${Math.round(queue.oldestPendingAgeSeconds / 60)}m` : "queue is clear"}
                </div>
              </div>
              <div className="rounded-lg bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">Done / failed</span>
                <div className="font-mono text-lg text-foreground">{queue.summary?.completed ?? 0} / {queue.summary?.failed ?? 0}</div>
              </div>
              <div className="rounded-lg bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">Workers</span>
                <div className="truncate text-muted-foreground">
                  {queue.lastTick
                    ? Object.entries(queue.lastTick.probedWorkers).map(([worker, state]) => `${worker} ${state === "REACHABLE" ? "✓" : "✗"}`).join(" · ")
                    : "no dispatcher tick recorded yet"}
                </div>
                <div className="mt-1 text-muted-foreground">Last tick: <span className="font-mono">{queue.lastTick?.status ?? "—"}</span>{queue.lastTick?.atUtc ? ` · ${fmtDate(queue.lastTick.atUtc)}` : ""}</div>
              </div>
              <div className="text-[10px] text-muted-foreground">pods request backtests · free workers pick them up · paid compute never starts on its own</div>
            </div>
          </OpsTile>
        ) : null}

        {inventory ? (
          <OpsTile
            title="Data inventory"
            icon={HardDrive}
            headline={inventory.present ? fmtBytes(inventory.totalBytes) : "—"}
            sub={inventory.present
              ? `${inventory.tickVenues.filter((v) => v.live).length}/${inventory.tickVenues.length} recorders live · ${inventory.ohlcvSources.length} OHLCV sources`
              : "registry not built yet"}
            badge={!inventory.present ? <TileBadge tone="danger">not built</TileBadge> : inventory.stale ? <TileBadge tone="warn">stale</TileBadge> : null}
          >
            {inventory.present ? (
              <div className="grid gap-2 text-xs">
                <div className="rounded-lg bg-muted/50 px-3 py-2">
                  <span className="text-muted-foreground">Live tick recorders</span>
                  <div className="truncate text-muted-foreground">{inventory.tickVenues.map((v) => `${v.venue} ${v.live ? "✓" : "✗"}`).join(" · ") || "none"}</div>
                </div>
                <div className="rounded-lg bg-muted/50 px-3 py-2">
                  <span className="text-muted-foreground">OHLCV freshness</span>
                  <div className="text-muted-foreground">{inventory.staleSources.length ? `${inventory.staleSources.length} stale slices` : "all fresh"}</div>
                </div>
                <div className="rounded-lg bg-muted/50 px-3 py-2">
                  <span className="text-muted-foreground">Registry updated</span>
                  <div className="truncate font-mono text-foreground">{inventory.generatedUtc ? fmtDate(inventory.generatedUtc) : "—"}</div>
                </div>
                <div className="text-[10px] text-muted-foreground">pods check this before asking for new or paid data · nothing is bought automatically</div>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Registry not built yet — run <code className="font-mono">pnpm cps:data-inventory</code> in /root/paperclip.
              </div>
            )}
          </OpsTile>
        ) : null}

        {catalog?.present ? (
          <OpsTile
            title="Tool catalog"
            icon={ListChecks}
            headline={`${catalog.environments.filter((e) => e.ready).length}/${catalog.environments.length} envs`}
            sub={`${[...catalog.recorders, ...catalog.services].filter((i) => i.ok).length}/${catalog.recorders.length + catalog.services.length} services up · ${catalog.enginesAndAdapters.filter((i) => i.ok).length}/${catalog.enginesAndAdapters.length} engines`}
            badge={catalog.notReady.length ? <TileBadge tone="warn">{catalog.notReady.length} not ready</TileBadge> : catalog.stale ? <TileBadge tone="warn">stale</TileBadge> : null}
          >
            <div className="grid gap-2 text-xs">
              <div className="rounded-lg bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">Research environments</span>
                <div className="truncate text-muted-foreground">{catalog.environments.map((e) => `${e.name.replace(/-py\d+$/, "")} ${e.ready ? "✓" : "✗"}`).join(" · ")}</div>
              </div>
              <div className="rounded-lg bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">Services</span>
                <div className="truncate text-muted-foreground">{catalog.services.map((s) => `${s.name} ${s.ok ? "✓" : "✗"}`).join(" · ") || "—"}</div>
              </div>
              <div className="rounded-lg bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">Engines & adapters</span>
                <div className="truncate text-muted-foreground">{catalog.enginesAndAdapters.map((e) => `${e.name} ${e.ok ? "✓" : "✗"}`).join(" · ")}</div>
              </div>
              <div className="rounded-lg bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">Execution plane</span>
                <div className="truncate font-mono text-foreground">{catalog.executionPlane ?? "—"}</div>
                <div className="text-muted-foreground">{catalog.generatedUtc ? `updated ${fmtDate(catalog.generatedUtc)}` : ""}</div>
              </div>
              <div className="text-[10px] text-muted-foreground">what pods can use · missing tools become install tasks or asks, never ad-hoc installs</div>
            </div>
          </OpsTile>
        ) : null}

        {data.labels && data.datasetExport ? (
          <OpsTile
            title="Labels & dataset"
            icon={Database}
            headline={`${data.datasetExport.labeledJudgments}/${data.datasetExport.evalMinLabels}`}
            sub={`${data.labels.total} operator labels · ${data.datasetExport.trainingRows ?? 0} training rows`}
          >
            <div className="grid gap-2 text-xs">
              <div className="rounded-lg bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">Eval gate progress</span>
                <div className="font-mono text-lg text-foreground">{data.datasetExport.labeledJudgments} / {data.datasetExport.evalMinLabels}</div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, (data.datasetExport.labeledJudgments / data.datasetExport.evalMinLabels) * 100)}%` }} />
                </div>
              </div>
              <div className="rounded-lg bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">Exports</span>
                <div className="text-muted-foreground">training {data.datasetExport.trainingRows ?? "—"} · tinker {data.datasetExport.tinkerRows ?? "—"} · eval {data.datasetExport.evalRows ?? `gated until ${data.datasetExport.evalMinLabels}`}</div>
              </div>
              {Object.keys(data.labels.byLabel).length ? (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(data.labels.byLabel).map(([label, count]) => (
                    <span key={label} className="rounded-md bg-muted/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">{label}: {count}</span>
                  ))}
                </div>
              ) : null}
            </div>
          </OpsTile>
        ) : null}
      </div>

      <details className="rounded-2xl border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center gap-2 p-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <Lightbulb className="h-4 w-4 text-muted-foreground" /> Paste an idea
          <span className="text-[10px] font-normal text-muted-foreground">X post · article · paper — the CEO decomposes and routes it to a pod</span>
          <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
        </summary>
        <div className="border-t border-border p-4">
          <div className="grid gap-2 lg:grid-cols-[1fr_16rem]">
            <textarea
              value={ideaText}
              onChange={(event) => setIdeaText(event.target.value)}
              rows={4}
              placeholder="Paste the idea content here (the strategy claim, thread text, abstract…). This text is what survives if the page disappears — paste the substance, not just a link."
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            />
            <div className="flex flex-col gap-2">
              <select
                value={ideaSourceType}
                onChange={(event) => setIdeaSourceType(event.target.value as "x_post" | "article" | "paper" | "other")}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
              >
                <option value="x_post">X post</option>
                <option value="article">Article</option>
                <option value="paper">Paper / PDF</option>
                <option value="other">Other</option>
              </select>
              <input
                value={ideaUrl}
                onChange={(event) => setIdeaUrl(event.target.value)}
                placeholder="Source URL (optional, snapshotted now)"
                className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
              />
              <input
                value={ideaTitle}
                onChange={(event) => setIdeaTitle(event.target.value)}
                placeholder="Short title (optional)"
                className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
              />
              <button
                type="button"
                disabled={ideaMutation.isPending || ideaText.trim().length < 20}
                onClick={() => { setIdeaResult(null); ideaMutation.mutate(); }}
                className="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {ideaMutation.isPending ? "Capturing…" : "Send to the team"}
              </button>
            </div>
          </div>
          {ideaResult ? (
            <div className="mt-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{ideaResult}</div>
          ) : null}
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {[{ key: "strategies", label: "Strategies" }, { key: "papers", label: "Papers & ideas" }, { key: "system", label: "System runs" }, { key: "all", label: "All" }].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setGroupFilter(tab.key)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${groupFilter === tab.key ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {tab.label} <span className="font-mono tabular-nums">({groupCounts[tab.key] ?? 0})</span>
            </button>
          ))}
        </div>
        <select
          value={decisionFilter}
          onChange={(event) => setDecisionFilter(event.target.value)}
          className="rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground outline-none focus:border-primary"
        >
          <option value="all">All decisions</option>
          {decisionOptions.map((decision) => <option key={decision} value={decision}>{decision} ({data.counts.byDecision[decision]})</option>)}
        </select>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search id, mechanism, verdict…" className="ml-auto w-full max-w-xs rounded-full border border-border bg-background px-4 py-1.5 text-sm outline-none focus:border-primary" />
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="flex flex-col gap-2.5 lg:col-span-5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><ListChecks className="h-3.5 w-3.5" /> {filtered.length} of {data.counts.total} experiments</div>
          {filtered.length === 0 ? <EmptyState icon={BarChart3} message={emptyMessage} /> : filtered.map((entry) => (
            <EntryCard key={entry.id} entry={entry} selected={selected?.id === entry.id} onSelect={() => setSelectedId(entry.id)} />
          ))}
        </div>
        <div className="lg:col-span-7">
          {selected ? (
            <div className="lg:sticky lg:top-6">
              <EntryDetail
                companyId={selectedCompanyId}
                entry={selected}
                onQueueFollowUp={(entry) => queueMutation.mutate({ entry, mode: "generic" })}
                onQueueJudgmentNext={(entry) => queueMutation.mutate({ entry, mode: "judgment_next" })}
                onQueueGenerateJudgment={(entry) => queueMutation.mutate({ entry, mode: "generate_judgment" })}
                onCreateFeedback={(entry, draft) => labelMutation.mutate({ entry, draft })}
                isQueueing={queueMutation.isPending}
                isLabeling={labelMutation.isPending}
                queuedId={queuedId}
                labeledId={labeledId}
              />
            </div>
          ) : <EmptyState icon={FlaskConical} message="Select an experiment to see details." />}
        </div>
      </div>
    </div>
  );
}
