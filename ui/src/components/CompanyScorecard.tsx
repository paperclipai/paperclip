import type {
  CompanyScorecard as CompanyScorecardData,
  ScorecardActivityItem,
  ScorecardAttentionItem,
  ScorecardPulse,
} from "@paperclipai/shared";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

interface CompanyScorecardProps {
  scorecard: CompanyScorecardData;
}

const PULSE_LABELS: Record<ScorecardPulse, string> = {
  green: "Healthy",
  amber: "Needs attention",
  red: "Action required",
  grey: "No recent activity",
};

const PULSE_DOT_CLASSES: Record<ScorecardPulse, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  grey: "bg-muted-foreground/40",
};

const ATTENTION_REASON_LABELS: Record<ScorecardAttentionItem["reason"], string> = {
  blocked: "Blocked",
  in_review_waiting: "Review waiting",
  stalled: "Stalled",
};

const ACTIVITY_KIND_LABELS: Record<ScorecardActivityItem["kind"], string> = {
  comment: "commented",
  status_change: "updated",
  run_started: "started a run",
  run_finished: "finished a run",
};

export function CompanyScorecard({ scorecard }: CompanyScorecardProps) {
  const { pulse, counters, attention, activity, computedAt } = scorecard;
  return (
    <section
      data-testid="company-scorecard"
      data-pulse={pulse}
      className="rounded-xl border bg-card text-card-foreground"
    >
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className={cn("h-2.5 w-2.5 rounded-full", PULSE_DOT_CLASSES[pulse])}
          />
          <div>
            <p className="text-sm font-medium leading-none">Company scorecard</p>
            <p className="text-xs text-muted-foreground mt-1">{PULSE_LABELS[pulse]}</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground tabular-nums" title={computedAt}>
          updated {timeAgo(computedAt)}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">
        <CountersBlock
          label="Issues"
          rows={[
            ["Todo", counters.issues.todo],
            ["In progress", counters.issues.inProgress],
            ["In review", counters.issues.inReview],
            ["Blocked", counters.issues.blocked],
            ["Done · 7d", counters.issues.done7d],
          ]}
        />
        <CountersBlock
          label="Agents"
          rows={[
            ["Active", counters.agents.active],
            ["Idle", counters.agents.idle],
            ["Paused", counters.agents.paused],
          ]}
        />
        <CountersBlock
          label="Runs · 24h"
          rows={[
            ["Succeeded", counters.runs24h.succeeded],
            ["Failed", counters.runs24h.failed],
            ["Other", counters.runs24h.other],
          ]}
        />
      </div>

      <div className="grid grid-cols-1 gap-px bg-border lg:grid-cols-2">
        <AttentionList items={attention} />
        <ActivityFeed items={activity} />
      </div>
    </section>
  );
}

function CountersBlock({
  label,
  rows,
}: {
  label: string;
  rows: Array<[string, number]>;
}) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
        {rows.map(([rowLabel, value]) => (
          <div key={rowLabel} className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{rowLabel}</dt>
            <dd className="font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function AttentionList({ items }: { items: ScorecardAttentionItem[] }) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Attention</p>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nothing flagged.</p>
      ) : (
        <ul className="mt-2 space-y-1.5 text-sm">
          {items.map((item) => (
            <li key={item.issueId} className="flex items-start justify-between gap-2">
              <span className="min-w-0 truncate">
                <span className="font-mono text-xs text-muted-foreground">{item.identifier}</span>
                <span className="ml-2">{item.title}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {ATTENTION_REASON_LABELS[item.reason]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityFeed({ items }: { items: ScorecardActivityItem[] }) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Activity</p>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No recent activity.</p>
      ) : (
        <ul className="mt-2 space-y-1.5 text-sm">
          {items.map((item, idx) => (
            <li
              key={`${item.occurredAt}-${idx}`}
              className="flex items-start justify-between gap-2"
            >
              <span className="min-w-0 truncate">
                <span className="font-medium">{item.agentName ?? "system"}</span>
                <span className="ml-1 text-muted-foreground">
                  {ACTIVITY_KIND_LABELS[item.kind]}
                </span>
                {item.issueIdentifier && (
                  <span className="ml-1 font-mono text-xs text-muted-foreground">
                    {item.issueIdentifier}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {timeAgo(item.occurredAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
