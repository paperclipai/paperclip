import type { Issue } from "@paperclipai/shared";
import { CheckCircle2, CircleDashed, Clock, FileText, ShieldAlert, Sparkles, XCircle } from "lucide-react";
import type { RunForIssue } from "../api/activity";
import { cn, relativeTime } from "../lib/utils";

type OutcomeTone = "approved" | "needs_changes" | "blocked" | "failed" | "running" | "pending" | "neutral";

type Criterion = {
  label: string;
  value: string;
  passed?: boolean | null;
};

type ParsedOutcome = {
  tone: OutcomeTone;
  label: string;
  headline: string;
  summary: string | null;
  criteria: Criterion[];
  sourceLabel: string | null;
  sourceTime: string | null;
};

type IssueOutcomeCardProps = {
  issue: Issue;
  runs?: RunForIssue[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function titleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function latestMeaningfulRun(runs: RunForIssue[] | undefined) {
  return [...(runs ?? [])]
    .filter((run) => run.resultJson || run.status === "running" || run.status === "queued")
    .sort((a, b) => {
      const aTime = new Date(a.finishedAt ?? a.startedAt ?? a.createdAt).getTime();
      const bTime = new Date(b.finishedAt ?? b.startedAt ?? b.createdAt).getTime();
      return bTime - aTime;
    })[0] ?? null;
}

function findPaperclipResult(resultJson: unknown) {
  const root = asRecord(resultJson);
  if (!root) return null;
  return (
    asRecord(root.paperclip_result)
    ?? asRecord(root.paperclipResult)
    ?? asRecord(root.outcome)
    ?? root
  );
}

function criteriaFromResult(result: Record<string, unknown> | null): Criterion[] {
  if (!result) return [];
  const explicit = result.criteria ?? result.score_grid ?? result.scoreGrid;
  if (Array.isArray(explicit)) {
    return explicit.flatMap((item, index) => {
      const record = asRecord(item);
      if (!record) return [];
      const label = readString(record.label, record.name, record.criterion) ?? `Criterion ${index + 1}`;
      const value = readString(record.value, record.status, record.score, record.result) ?? "Recorded";
      return [{ label, value, passed: readBoolean(record.passed ?? record.pass) }];
    }).slice(0, 4);
  }

  const named: Array<[string, unknown]> = [
    ["Decision", result.decision ?? result.status],
    ["Quality", result.quality ?? result.quality_score ?? result.qualityScore],
    ["Evidence", result.evidence ?? result.evidence_status ?? result.evidenceStatus],
    ["Clinical review", result.clinical_review_required ?? result.clinicalReviewRequired],
  ];
  return named.flatMap(([label, raw]) => {
    if (raw === undefined || raw === null || raw === "") return [];
    const bool = readBoolean(raw);
    return [{
      label,
      value: bool === null ? titleCase(String(raw)) : bool ? "Required" : "Clear",
      passed: label === "Clinical review" && bool !== null ? !bool : null,
    }];
  }).slice(0, 4);
}

function toneFrom(issue: Issue, run: RunForIssue | null, result: Record<string, unknown> | null): OutcomeTone {
  const decision = readString(result?.decision, result?.status, result?.outcome)?.toLowerCase() ?? null;
  if (decision) {
    if (/approve|approved|accept|accepted|pass|passed|success|shipped/.test(decision)) return "approved";
    if (/revision|changes|revise|needs/.test(decision)) return "needs_changes";
    if (/block|blocked|hold|clinical/.test(decision)) return "blocked";
    if (/reject|rejected|fail|failed|error/.test(decision)) return "failed";
  }
  if (run?.status === "running" || run?.status === "queued" || issue.status === "in_progress") return "running";
  if (run?.status === "failed" || issue.status === "cancelled") return "failed";
  if (issue.status === "done") return "approved";
  if (!run) return "pending";
  return "neutral";
}

function parseOutcome(issue: Issue, runs?: RunForIssue[]): ParsedOutcome {
  const run = latestMeaningfulRun(runs);
  const result = findPaperclipResult(run?.resultJson);
  const tone = toneFrom(issue, run, result);
  const fallbackHeadline = issue.status === "done"
    ? "Work is marked done"
    : run
      ? "Latest run outcome"
      : "No run outcome yet";
  const headline = readString(result?.headline, result?.title, result?.decision_headline, result?.decisionHeadline, result?.summary)
    ?? fallbackHeadline;
  const summary = readString(result?.message, result?.rationale, result?.body, result?.result);
  const label = readString(result?.decision, result?.status, result?.outcome)
    ?? (tone === "running" ? "In progress" : tone === "pending" ? "Awaiting agent output" : titleCase(tone));
  return {
    tone,
    label: titleCase(label),
    headline,
    summary,
    criteria: criteriaFromResult(result),
    sourceLabel: run ? `Run ${run.runId.slice(0, 8)}` : null,
    sourceTime: run ? relativeTime(run.finishedAt ?? run.startedAt ?? run.createdAt) : null,
  };
}

const TONE_CLASS: Record<OutcomeTone, string> = {
  approved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100",
  needs_changes: "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100",
  blocked: "border-orange-500/35 bg-orange-500/10 text-orange-900 dark:text-orange-100",
  failed: "border-red-500/35 bg-red-500/10 text-red-900 dark:text-red-100",
  running: "border-cyan-500/30 bg-cyan-500/10 text-cyan-900 dark:text-cyan-100",
  pending: "border-border bg-muted/20 text-foreground",
  neutral: "border-border bg-background text-foreground",
};

function OutcomeIcon({ tone, className }: { tone: OutcomeTone; className?: string }) {
  const iconClassName = cn("h-4 w-4", className);
  if (tone === "approved") return <CheckCircle2 className={iconClassName} />;
  if (tone === "failed") return <XCircle className={iconClassName} />;
  if (tone === "blocked" || tone === "needs_changes") return <ShieldAlert className={iconClassName} />;
  if (tone === "running") return <Clock className={iconClassName} />;
  if (tone === "pending") return <CircleDashed className={iconClassName} />;
  return <Sparkles className={iconClassName} />;
}

export function IssueOutcomeCard({ issue, runs }: IssueOutcomeCardProps) {
  const outcome = parseOutcome(issue, runs);

  return (
    <section className={cn("rounded-xl border p-4 shadow-sm", TONE_CLASS[outcome.tone])} aria-label="Issue outcome">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mt-0.5 rounded-full bg-background/70 p-2 shadow-sm">
          <OutcomeIcon tone={outcome.tone} className="text-current" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wide text-current/70">
            <span>{outcome.label}</span>
            {outcome.sourceLabel ? <span>· {outcome.sourceLabel}</span> : null}
            {outcome.sourceTime ? <span>· {outcome.sourceTime}</span> : null}
          </div>
          <h3 className="text-base font-semibold leading-6 text-current">{outcome.headline}</h3>
          {outcome.summary ? <p className="text-sm leading-6 text-current/80">{outcome.summary}</p> : null}
        </div>
      </div>

      {outcome.criteria.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {outcome.criteria.map((criterion) => (
            <div key={criterion.label} className="rounded-lg border border-current/10 bg-background/60 px-3 py-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                {criterion.passed === true ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : null}
                {criterion.passed === false ? <XCircle className="h-3.5 w-3.5 text-red-500" /> : null}
                {criterion.passed === null || criterion.passed === undefined ? <FileText className="h-3.5 w-3.5" /> : null}
                {criterion.label}
              </div>
              <div className="mt-1 text-sm font-medium text-foreground">{criterion.value}</div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
