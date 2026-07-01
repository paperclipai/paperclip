import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BarChart3,
  Beaker,
  BookOpen,
  Clock,
  ExternalLink,
  FileText,
  FlaskConical,
  FolderOpen,
  Layers,
  ListChecks,
  ShieldCheck,
} from "lucide-react";
import type {
  ResearchPaperBadge,
  ResearchPaperEvidence,
  ResearchPaperMetric,
  ResearchPaperTone,
  ResearchToolbeltStatus,
} from "@paperclipai/shared";
import { researchPapersApi } from "../api/research-papers";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";

const TONE_STYLES: Record<ResearchPaperTone, { badge: string; dot: string }> = {
  reproduced: { badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  refuted: { badge: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300", dot: "bg-red-500" },
  data_blocked: { badge: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300", dot: "bg-amber-500" },
  claims_missing: { badge: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300", dot: "bg-sky-500" },
  claims_extracted: { badge: "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300", dot: "bg-indigo-500" },
  local_kill: { badge: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300", dot: "bg-rose-500" },
  not_comparable: { badge: "border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300", dot: "bg-zinc-400" },
  local_pass: { badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  not_assessed: { badge: "border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300", dot: "bg-zinc-400" },
  spike: { badge: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300", dot: "bg-violet-500" },
  neutral: { badge: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300", dot: "bg-slate-400" },
};

const CATEGORY_LABELS: Record<string, string> = {
  paper_family: "Paper family",
  micro_addon: "Micro-addon",
  execution_spike: "Execution spike",
};

const FRACTION_KEY = /cagr|total.?return|(^|[._])return$|max.?drawdown|hit.?rate|exposure|prob_sharpe|same_sign_rate|prob_sharpe_gt_0|_frac$/i;

function fmtNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 0.001 || abs >= 100_000)) return value.toExponential(2);
  return String(parseFloat(value.toPrecision(4)));
}

function fmtMetric(metric: ResearchPaperMetric): string {
  const { value, key } = metric;
  if (typeof value !== "number") return value === null ? "—" : String(value);
  if (FRACTION_KEY.test(key)) return `${(value * 100).toFixed(2)}%`;
  return fmtNumber(value);
}

function Badge({ badge }: { badge: ResearchPaperBadge }) {
  const tone = TONE_STYLES[badge.tone] ?? TONE_STYLES.neutral;
  return (
    <span
      title={badge.detail}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {badge.label}
    </span>
  );
}

function MetricGrid({ metrics }: { metrics: ResearchPaperMetric[] }) {
  if (metrics.length === 0) {
    return <p className="text-xs text-muted-foreground">No numeric values available.</p>;
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {metrics.map((metric) => (
        <div key={metric.key} className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-1.5">
          <span className="truncate text-xs text-muted-foreground" title={metric.label}>{metric.label}</span>
          <span className="font-mono text-xs font-medium tabular-nums text-foreground">{fmtMetric(metric)}</span>
        </div>
      ))}
    </div>
  );
}

function Section({ icon: Icon, title, children, hint }: { icon: typeof FileText; title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {hint ? <span className="text-xs text-muted-foreground">· {hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

function VerdictCell({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 break-words font-mono text-sm font-medium text-foreground">{value ?? "—"}</div>
      {hint ? <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function ToolbeltPanel({ toolbelts }: { toolbelts: ResearchToolbeltStatus[] }) {
  if (!toolbelts.length) return null;
  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Beaker className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">Research toolbelts</h3>
        <span className="text-xs text-muted-foreground">· local import-readiness, no broker/paid actions</span>
      </div>
      <div className="grid gap-2 lg:grid-cols-3">
        {toolbelts.map((toolbelt) => (
          <div key={toolbelt.name} className="rounded-xl border border-border bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground" title={toolbelt.name}>{toolbelt.name}</div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={toolbelt.path}>{toolbelt.path}</div>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${toolbelt.ready ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}>
                {toolbelt.ready ? "ready" : "partial"}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-1 text-center text-xs">
              <div className="rounded-lg bg-background/70 p-1.5"><div className="font-mono font-semibold">{toolbelt.toolCount}</div><div className="text-[10px] text-muted-foreground">tools</div></div>
              <div className="rounded-lg bg-background/70 p-1.5"><div className="font-mono font-semibold text-emerald-600">{toolbelt.importOk}</div><div className="text-[10px] text-muted-foreground">ok</div></div>
              <div className="rounded-lg bg-background/70 p-1.5"><div className="font-mono font-semibold text-amber-600">{toolbelt.failed}</div><div className="text-[10px] text-muted-foreground">failed</div></div>
            </div>
            {toolbelt.failedImports.length ? (
              <div className="mt-2 text-[11px] text-muted-foreground">
                Failed: <span className="font-mono">{toolbelt.failedImports.join(", ")}</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function PaperDetail({ paper }: { paper: ResearchPaperEvidence }) {
  const numericClaims = paper.claims.numericClaimValues ? Object.entries(paper.claims.numericClaimValues) : [];
  const failingGateEntries = paper.failingGates
    ? Array.isArray(paper.failingGates)
      ? [["", paper.failingGates] as [string, string[]]]
      : Object.entries(paper.failingGates)
    : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground">{CATEGORY_LABELS[paper.category] ?? paper.category}</span>
          {paper.paperId ? <span className="font-mono">{paper.paperId}</span> : null}
          {paper.family ? <span>· {paper.family.replace(/_/g, " ")}</span> : null}
        </div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{paper.title}</h2>
        {paper.authors.length > 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">{paper.authors.join(", ")}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {paper.badges.map((badge, idx) => (
            <Badge key={`${badge.axis}-${badge.tone}-${idx}`} badge={badge} />
          ))}
        </div>
        {paper.sourceUrl ? (
          <a
            href={paper.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Source paper
          </a>
        ) : null}
      </div>

      <Section icon={ShieldCheck} title="Verdict axes" hint="kept separate — a local kill is not a paper refutation">
        <div className="grid gap-2 sm:grid-cols-2">
          <VerdictCell label="Paper reproduction" value={paper.paperReproductionVerdict} />
          <VerdictCell label="Local validation" value={paper.localValidationVerdict} />
          <VerdictCell label="Claim value status" value={paper.claimValueStatus} />
          <VerdictCell label="Comparability" value={paper.comparability} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-md bg-muted/60 px-2 py-1">
            paper_refuted: <span className="font-mono font-medium">{paper.paperRefuted === null ? "—" : String(paper.paperRefuted)}</span>
          </span>
          {paper.notAPaperRefutation ? (
            <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-sky-700 dark:text-sky-300">
              Explicitly not a paper refutation
            </span>
          ) : null}
          <span className="rounded-md bg-muted/60 px-2 py-1">
            promotion_allowed: <span className="font-mono font-medium">{paper.promotionAllowed === null ? "not indicated" : String(paper.promotionAllowed)}</span>
          </span>
        </div>
      </Section>

      {paper.experimentDesign ? (
        <Section icon={BookOpen} title="Experiment design & summary">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs leading-5 text-foreground/90">
            {paper.experimentDesign}
          </pre>
        </Section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section icon={BarChart3} title="Measured values" hint="local proxy / adaptation">
          <MetricGrid metrics={paper.measured.summary} />
        </Section>
        <Section icon={BarChart3} title="Benchmark">
          <MetricGrid metrics={paper.benchmark.summary} />
        </Section>
      </div>

      {(paper.claims.primarySources?.length || numericClaims.length || paper.claims.qualitativeClaims?.length) ? (
        <Section icon={FileText} title="Paper claims">
          {paper.claims.numericClaimsExtracted === false ? (
            <p className="mb-2 text-xs text-amber-700 dark:text-amber-300">
              Primary-source numeric claim values were not preserved — no faithful reproduction was scored.
            </p>
          ) : null}
          {paper.claims.primarySources?.length ? (
            <div className="mb-3">
              <div className="text-xs font-medium text-muted-foreground">Primary sources</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-foreground/90">
                {paper.claims.primarySources.map((src) => <li key={src}>{src}</li>)}
              </ul>
            </div>
          ) : null}
          {numericClaims.length ? (
            <div className="mb-3">
              <div className="text-xs font-medium text-muted-foreground">Extracted numeric claims</div>
              <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
                {numericClaims.map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-1.5">
                    <span className="truncate text-xs text-muted-foreground">{key.replace(/_/g, " ")}</span>
                    <span className="font-mono text-xs font-medium">{typeof value === "object" ? JSON.stringify(value) : String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {paper.claims.qualitativeClaims?.length ? (
            <div>
              <div className="text-xs font-medium text-muted-foreground">Qualitative claims preserved</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-foreground/90">
                {paper.claims.qualitativeClaims.map((claim) => <li key={claim}>{claim}</li>)}
              </ul>
            </div>
          ) : null}
        </Section>
      ) : null}

      {(failingGateEntries.length > 0 || paper.blockers.length > 0 || paper.safetyFlags) ? (
        <Section icon={AlertTriangle} title="Gates, blockers & safety">
          {failingGateEntries.length > 0 ? (
            <div className="mb-3">
              <div className="text-xs font-medium text-muted-foreground">Failing gates</div>
              {failingGateEntries.map(([strategy, gates]) => (
                <div key={strategy || "gates"} className="mt-1">
                  {strategy ? <div className="text-xs font-medium text-foreground/80">{strategy.replace(/_/g, " ")}</div> : null}
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {gates.map((gate) => (
                      <span key={gate} className="rounded-md border border-rose-500/20 bg-rose-500/5 px-2 py-0.5 font-mono text-[11px] text-rose-700 dark:text-rose-300">{gate}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {paper.blockers.length > 0 ? (
            <div className="mb-3">
              <div className="text-xs font-medium text-muted-foreground">Blockers</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-foreground/90">
                {paper.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
              </ul>
            </div>
          ) : null}
          {paper.safetyFlags ? (
            <div>
              <div className="text-xs font-medium text-muted-foreground">Safety flags</div>
              <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
                {Object.entries(paper.safetyFlags).map(([flag, value]) => (
                  <div key={flag} className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-1.5">
                    <span className="truncate text-xs text-muted-foreground">{flag.replace(/_/g, " ")}</span>
                    <span className={`font-mono text-xs font-medium ${value ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`}>{String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section icon={Clock} title="Chronological log" hint="simplified, important events only">
        {paper.log.length === 0 ? (
          <p className="text-xs text-muted-foreground">No log events available.</p>
        ) : (
          <ol className="relative ml-2 border-l border-border">
            {paper.log.map((entry, idx) => (
              <li key={`${entry.label}-${idx}`} className="mb-3 ml-4 last:mb-0">
                <span className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full border border-background bg-muted-foreground/60" />
                <div className="text-sm font-medium text-foreground">{entry.label}</div>
                {entry.detail ? <div className="text-xs text-muted-foreground">{entry.detail}</div> : null}
                <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  {entry.ts ? <span className="font-mono">{new Date(entry.ts).toISOString().replace("T", " ").slice(0, 19)}Z</span> : <span>time n/a</span>}
                  {entry.source ? <span className="font-mono opacity-70">{entry.source}</span> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section icon={FolderOpen} title="Artifacts" hint={paper.artifactDir}>
        <div className="flex flex-col divide-y divide-border">
          {paper.artifacts.map((file) => (
            <div key={file.path} className="flex items-center justify-between gap-3 py-1.5">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-foreground">{file.name}</div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">{file.path}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5">{file.kind}</span>
                {file.bytes !== null ? <span>{file.bytes >= 1024 ? `${Math.round(file.bytes / 1024)}KB` : `${file.bytes}B`}</span> : null}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function OverviewCard({ paper, selected, onSelect }: { paper: ResearchPaperEvidence; selected: boolean; onSelect: () => void }) {
  const tone = TONE_STYLES[paper.headlineTone] ?? TONE_STYLES.neutral;
  const headlineMetric = paper.measured.summary.find((m) => /sharpe/i.test(m.key)) ?? paper.measured.summary[0];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-2xl border p-4 text-left transition hover:border-primary/50 ${selected ? "border-primary bg-primary/5 shadow-sm" : "border-border bg-card"}`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{CATEGORY_LABELS[paper.category] ?? paper.category}</span>
            {paper.paperId ? <span className="font-mono">· {paper.paperId}</span> : null}
          </div>
          <div className="mt-0.5 truncate text-sm font-semibold text-foreground" title={paper.title}>{paper.title}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {paper.badges.slice(0, 3).map((badge, idx) => <Badge key={`${badge.tone}-${idx}`} badge={badge} />)}
          </div>
          {headlineMetric ? (
            <div className="mt-2 text-[11px] text-muted-foreground">
              {headlineMetric.label}: <span className="font-mono text-foreground">{fmtMetric(headlineMetric)}</span>
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}

export function ResearchPapers() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [toneFilter, setToneFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: "Dashboard", href: "/dashboard" },
      { label: "Research Papers" },
    ]);
  }, [setBreadcrumbs]);

  const { data, isLoading } = useQuery({
    queryKey: ["research-papers", selectedCompanyId],
    queryFn: () => researchPapersApi.overview(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 60_000,
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return data.papers.filter((paper) => {
      if (categoryFilter !== "all" && paper.category !== categoryFilter) return false;
      if (toneFilter !== "all" && paper.headlineTone !== toneFilter) return false;
      if (term) {
        const haystack = `${paper.title} ${paper.paperId ?? ""} ${paper.family ?? ""} ${paper.authors.join(" ")}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [data, categoryFilter, toneFilter, search]);

  const selected = useMemo(() => {
    if (!filtered.length) return null;
    return filtered.find((paper) => paper.id === selectedId) ?? filtered[0];
  }, [filtered, selectedId]);

  if (!selectedCompanyId) {
    return <EmptyState icon={FlaskConical} message="Select a company to view research-paper evidence." />;
  }
  if (isLoading || !data) {
    return <PageSkeleton variant="dashboard" />;
  }

  const toneOptions = Object.keys(data.counts.byTone);

  return (
    <div className="mx-auto flex max-w-[110rem] flex-col gap-6 p-6">
      <section className="overflow-hidden rounded-[2rem] border border-slate-900/10 bg-[radial-gradient(circle_at_20%_20%,rgba(99,102,241,0.18),transparent_35%),linear-gradient(135deg,#0a0f1f,#111827_55%,#0f172a)] p-6 text-white shadow-2xl">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs uppercase tracking-[0.24em] text-indigo-100">
              <ShieldCheck className="h-3.5 w-3.5" /> Read-only evidence · no execution
            </div>
            <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Research paper evidence</h1>
            <p className="mt-3 text-sm leading-6 text-slate-200">
              Reproduction status for CPS research-paper experiments. Two verdict axes are kept separate: whether the
              paper's own claims were faithfully reproduced, and how a local adaptation/proxy fared. A local kill or
              non-comparable proxy is never treated as a refutation of the paper. This view only reads local artifacts.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
              <div className="text-3xl font-semibold">{data.counts.total}</div>
              <div className="text-xs uppercase tracking-wide text-slate-300">papers</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
              <div className="text-3xl font-semibold">{data.counts.byTone.refuted ?? 0}</div>
              <div className="text-xs uppercase tracking-wide text-slate-300">refuted</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
              <div className="text-3xl font-semibold">{(data.counts.byTone.reproduced ?? 0)}</div>
              <div className="text-xs uppercase tracking-wide text-slate-300">reproduced</div>
            </div>
          </div>
        </div>
      </section>

      <ToolbeltPanel toolbelts={data.toolbelts} />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1.5">
          {["all", ...Object.keys(data.counts.byCategory)].map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategoryFilter(cat)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${categoryFilter === cat ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {cat === "all" ? "All categories" : `${CATEGORY_LABELS[cat] ?? cat} (${data.counts.byCategory[cat]})`}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setToneFilter("all")}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${toneFilter === "all" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            All statuses
          </button>
          {toneOptions.map((tone) => (
            <button
              key={tone}
              type="button"
              onClick={() => setToneFilter(tone)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${toneFilter === tone ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${(TONE_STYLES[tone as ResearchPaperTone] ?? TONE_STYLES.neutral).dot}`} />
              {tone.replace(/_/g, " ")} ({data.counts.byTone[tone]})
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search title, paper id, author…"
          className="ml-auto w-full max-w-xs rounded-full border border-border bg-background px-4 py-1.5 text-sm outline-none focus:border-primary"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="flex flex-col gap-2.5 lg:col-span-5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Layers className="h-3.5 w-3.5" /> {filtered.length} of {data.counts.total} papers
          </div>
          {filtered.length === 0 ? (
            <EmptyState icon={ListChecks} message="No papers match the current filters." />
          ) : (
            filtered.map((paper) => (
              <OverviewCard
                key={paper.id}
                paper={paper}
                selected={selected?.id === paper.id}
                onSelect={() => setSelectedId(paper.id)}
              />
            ))
          )}

          <div className="mt-2 rounded-2xl border border-dashed border-border p-3 text-[11px] text-muted-foreground">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground"><Beaker className="h-3.5 w-3.5" /> Scanned roots</div>
            {data.roots.map((root) => (
              <div key={root.path} className="flex items-center justify-between gap-2">
                <span className="truncate font-mono" title={root.path}>{root.label}</span>
                <span className={root.present ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
                  {root.present ? `${root.count}` : "missing"}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="lg:col-span-7">
          {selected ? (
            <div className="lg:sticky lg:top-6">
              <PaperDetail paper={selected} />
            </div>
          ) : (
            <EmptyState icon={FlaskConical} message="Select a paper to see its evidence." />
          )}
        </div>
      </div>
    </div>
  );
}
