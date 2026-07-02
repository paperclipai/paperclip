import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AlertTriangle, BarChart3, Clock, FileJson, FlaskConical, ListChecks, ShieldCheck } from "lucide-react";
import type { CpsExperimentEntry } from "@paperclipai/shared";
import { cpsExperimentsApi } from "../api/cps-experiments";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";

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

function CountCard({ label, value, tone = "default" }: { label: string; value: number | string; tone?: "default" | "danger" | "warn" | "ok" }) {
  const toneClass = tone === "danger" ? "text-rose-300" : tone === "warn" ? "text-amber-200" : tone === "ok" ? "text-emerald-300" : "text-white";
  return (
    <div className="rounded-2xl border border-white/10 bg-white/10 p-4 text-center">
      <div className={`text-3xl font-semibold ${toneClass}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-slate-300">{label}</div>
    </div>
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
        {oosMean ? <div className="rounded-lg bg-muted/50 px-2 py-1">Mean: <span className="font-mono text-foreground">{oosMean}</span></div> : null}
        {oosSharpe ? <div className="rounded-lg bg-muted/50 px-2 py-1">Sharpe: <span className="font-mono text-foreground">{oosSharpe}</span></div> : null}
      </div>
    </button>
  );
}

function EntryDetail({
  entry,
  onQueueFollowUp,
  onQueueJudgmentNext,
  onCreateFeedback,
  isQueueing,
  isLabeling,
  queuedId,
  labeledId,
}: {
  entry: CpsExperimentEntry;
  onQueueFollowUp: (entry: CpsExperimentEntry) => void;
  onQueueJudgmentNext: (entry: CpsExperimentEntry) => void;
  onCreateFeedback: (entry: CpsExperimentEntry, label: string) => void;
  isQueueing: boolean;
  isLabeling: boolean;
  queuedId: string | null;
  labeledId: string | null;
}) {
  const failing = Array.isArray(entry.summary.failing_gates) ? entry.summary.failing_gates.filter((x): x is string => typeof x === "string") : [];
  const safety = entry.summary.safety && typeof entry.summary.safety === "object" ? entry.summary.safety as Record<string, unknown> : null;
  const resultVerdict = judgmentScalar(entry, "result_verdict", "resultVerdict");
  const promotionVerdict = judgmentScalar(entry, "promotion_verdict", "promotionVerdict");
  const rulesStatus = judgmentStatus(entry, "rules_disclosure", "rulesDisclosure");
  const dataStatus = judgmentStatus(entry, "data_fit", "dataFit");
  const executionStatus = judgmentStatus(entry, "execution_fit", "executionFit");
  const nextPrompt = nextActionPrompt(entry);
  const blockers = Array.isArray(entry.judgment?.blockers) ? entry.judgment.blockers : [];
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-foreground">{entry.kind}</span>
          <span>{entry.status}</span>
          <span>· updated {fmtDate(entry.updatedUtc)}</span>
        </div>
        <h2 className="mt-2 break-words text-2xl font-semibold tracking-tight text-foreground">{entry.id}</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${decisionClass(entry.decision)}`}>{entry.decision ?? "UNLABELED"}</span>
          {entry.primaryJson ? <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 font-mono text-xs">{entry.primaryJson}</span> : null}
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
      </section>

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
          <div className="mt-3 flex flex-wrap gap-1.5">
            {["agree", "disagree", "too_optimistic", "too_conservative", "wrong_blocker", "proceed_autonomously", "archive", "requires_approval"].map((label) => (
              <button key={label} type="button" onClick={() => onCreateFeedback(entry, label)} disabled={isLabeling} className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60">
                {label.replace(/_/g, " ")}
              </button>
            ))}
            {labeledId ? <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] text-emerald-700 dark:text-emerald-300">labeled {labeledId}</span> : null}
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
          No `JUDGMENT.json` found yet. Queue `generate_judgment` or run a CPS judgment writer to turn this experiment into training data.
        </section>
      )}

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

      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><FileJson className="h-4 w-4 text-muted-foreground" /> Summary JSON</div>
        <pre className="max-h-96 overflow-auto rounded-lg bg-muted/40 p-3 text-xs leading-5 text-foreground/90">{JSON.stringify(entry.summary, null, 2)}</pre>
      </section>
    </div>
  );
}

export function CpsExperiments() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [kindFilter, setKindFilter] = useState("all");
  const [decisionFilter, setDecisionFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [queuedId, setQueuedId] = useState<string | null>(null);
  const [labeledId, setLabeledId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard", href: "/dashboard" }, { label: "CPS Experiments" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading } = useQuery({
    queryKey: ["cps-experiments", selectedCompanyId],
    queryFn: () => cpsExperimentsApi.overview(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 60_000,
  });

  const queueMutation = useMutation({
    mutationFn: ({ entry, mode }: { entry: CpsExperimentEntry; mode: "generic" | "judgment_next" }) => {
      const prompt = mode === "judgment_next"
        ? nextActionPrompt(entry) ?? `Generate or revise the CPS JUDGMENT.json for ${entry.id}. Preserve safety boundaries: no broker actions, no signal publishing, no paid data unless explicitly approved.`
        : `Paperclip operator requested a bounded CPS follow-up for ${entry.id}. Review the artifact, preserve the current verdict unless evidence changes, and only run safe local research/backtest steps. No broker actions, no signal publishing. If data/paid API is needed, stop and report the exact need unless already explicitly allowed by the request.`;
      return cpsExperimentsApi.createRunRequest(selectedCompanyId!, {
        action: mode === "judgment_next" ? "run_next_safe_action" : (entry.decision === "KILL_ARCHIVE" || entry.decision === "KILL" ? "investigate_near_miss" : "rerun_with_variant"),
        experimentId: entry.id,
        prompt,
        maxRuntimeMinutes: mode === "judgment_next" ? 120 : 90,
        allowPaidData: false,
        allowPaidCompute: false,
      });
    },
    onSuccess: (request) => setQueuedId(request.id),
  });

  const labelMutation = useMutation({
    mutationFn: ({ entry, label }: { entry: CpsExperimentEntry; label: string }) => cpsExperimentsApi.createJudgmentFeedback(selectedCompanyId!, {
      experimentId: entry.id,
      label,
    }),
    onSuccess: (feedback) => setLabeledId(feedback.id),
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return data.entries.filter((entry) => {
      if (kindFilter !== "all" && entry.kind !== kindFilter) return false;
      if (decisionFilter !== "all" && (entry.decision ?? "UNLABELED") !== decisionFilter) return false;
      if (term) {
        const haystack = `${entry.id} ${entry.kind} ${entry.decision ?? ""} ${entry.primaryJson ?? ""} ${JSON.stringify(entry.summary)} ${JSON.stringify(entry.judgment ?? {})}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [data, kindFilter, decisionFilter, search]);

  const selected = useMemo(() => filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null, [filtered, selectedId]);

  if (!selectedCompanyId) return <EmptyState icon={FlaskConical} message="Select a company to view CPS experiments." />;
  if (isLoading || !data) return <PageSkeleton variant="dashboard" />;

  const kindOptions = Object.keys(data.counts.byKind);
  const decisionOptions = Object.keys(data.counts.byDecision);

  if (!data.source.present) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <EmptyState icon={AlertTriangle} message={`CPS experiment index not found at ${data.source.indexPath}. Nothing to show yet.`} />
      </div>
    );
  }

  const emptyMessage = data.counts.total === 0 ? "No CPS experiments are recorded in the local index yet." : "No experiments match the current filters.";

  return (
    <div className="mx-auto flex max-w-[110rem] flex-col gap-6 p-6">
      <section className="overflow-hidden rounded-[2rem] border border-slate-900/10 bg-[radial-gradient(circle_at_20%_20%,rgba(16,185,129,0.18),transparent_35%),linear-gradient(135deg,#07111f,#111827_55%,#0f172a)] p-6 text-white shadow-2xl">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs uppercase tracking-[0.24em] text-emerald-100">
              <ShieldCheck className="h-3.5 w-3.5" /> Local-first tracker · read-only
            </div>
            <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">CPS experiments</h1>
            <p className="mt-3 text-sm leading-6 text-slate-200">
              Live view of the local CPS experiment index. It separates artifact health from strategy verdicts and exposes kill/archive/data-blocked evidence without running new jobs or touching brokers.
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
              <span className="rounded-md bg-white/10 px-2 py-1"><Clock className="mr-1 inline h-3 w-3" /> index age: {data.source.ageSeconds ?? "—"}s</span>
              <span className={`rounded-md px-2 py-1 ${data.source.stale ? "bg-amber-500/20 text-amber-100" : "bg-emerald-500/20 text-emerald-100"}`}>{data.source.stale ? "stale" : "fresh"}</span>
              <span className="rounded-md bg-white/10 px-2 py-1 font-mono">{data.source.indexPath}</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-center lg:grid-cols-4">
            <CountCard label="entries" value={data.counts.total} />
            <CountCard label="judgments" value={Object.values(data.counts.judgmentByResultVerdict).reduce((sum, value) => sum + value, 0)} tone="ok" />
            <CountCard label="killed" value={data.counts.strategyByDecision.KILL_ARCHIVE ?? data.counts.judgmentByResultVerdict.LOCAL_VALIDATION_KILL ?? 0} tone="danger" />
            <CountCard label="blocked" value={(data.counts.judgmentByResultVerdict.DATA_BLOCKED ?? 0) + (data.counts.judgmentByResultVerdict.RULES_BLOCKED ?? 0) + (data.counts.strategyByDecision.BLOCKED_BY_DATA ?? 0)} tone="warn" />
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1.5">
          {["all", ...kindOptions].map((kind) => (
            <button key={kind} type="button" onClick={() => setKindFilter(kind)} className={`rounded-full border px-3 py-1 text-xs font-medium transition ${kindFilter === kind ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
              {kind === "all" ? "All kinds" : `${kind} (${data.counts.byKind[kind]})`}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {["all", ...decisionOptions].map((decision) => (
            <button key={decision} type="button" onClick={() => setDecisionFilter(decision)} className={`rounded-full border px-3 py-1 text-xs font-medium transition ${decisionFilter === decision ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
              {decision === "all" ? "All decisions" : `${decision} (${data.counts.byDecision[decision]})`}
            </button>
          ))}
        </div>
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
                entry={selected}
                onQueueFollowUp={(entry) => queueMutation.mutate({ entry, mode: "generic" })}
                onQueueJudgmentNext={(entry) => queueMutation.mutate({ entry, mode: "judgment_next" })}
                onCreateFeedback={(entry, label) => labelMutation.mutate({ entry, label })}
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
