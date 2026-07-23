import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import type { Agent, Issue } from "@paperclipai/shared";
import { ChevronRight, Inbox, Target } from "lucide-react";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import {
  getInitiativesRollup,
  getNeedsYouIssues,
  getParkedSummary,
} from "../lib/needs-attention";

const INITIATIVE_DISPLAY_LIMIT = 8;
const PARKED_DISPLAY_LIMIT = 25;

function issueHref(issue: Issue): string {
  return `/issues/${issue.identifier ?? issue.id}`;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
      {children}
    </h3>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
      <div
        className="h-full rounded-full bg-emerald-400"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

interface NeedsAttentionPanelProps {
  issues: Issue[];
  currentUserId: string | null;
  agentMap?: Map<string, Agent>;
}

/**
 * Dashboard "Needs Your Attention" prioritization view (FUS-762).
 *
 * Surfaces the human decision queue (in_review tasks assigned to the current user)
 * above everything else, rolls up top-level initiatives with progress, and collapses
 * blocked / agent-review tasks behind a count so they stop adding noise.
 */
export function NeedsAttentionPanel({
  issues,
  currentUserId,
  agentMap,
}: NeedsAttentionPanelProps) {
  const [parkedOpen, setParkedOpen] = useState(false);

  const needsYou = useMemo(
    () => getNeedsYouIssues(issues, currentUserId),
    [issues, currentUserId],
  );
  const initiatives = useMemo(() => getInitiativesRollup(issues), [issues]);
  const parked = useMemo(() => getParkedSummary(issues), [issues]);

  const agentName = (id: string | null) =>
    (id && agentMap?.get(id)?.name) || null;

  return (
    <section className="space-y-4">
      {/* #1 — Needs You: the daily decision queue */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Inbox className="h-4 w-4 text-violet-400" />
            <span className="text-sm font-semibold">Needs You</span>
            {needsYou.length > 0 && (
              <span className="inline-flex items-center justify-center rounded-full bg-violet-500/15 text-violet-300 text-xs font-medium px-2 py-0.5">
                {needsYou.length}
              </span>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            In review · assigned to you
          </span>
        </div>

        {needsYou.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              You&apos;re all caught up — nothing in review needs your decision.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {needsYou.map((issue) => (
              <Link
                key={issue.id}
                to={issueHref(issue)}
                className="flex items-center gap-3 px-4 py-3 text-sm no-underline text-inherit hover:bg-accent/50 transition-colors"
              >
                <span className="flex shrink-0 items-center gap-1.5">
                  <PriorityIcon priority={issue.priority} />
                  <StatusIcon
                    status={issue.status}
                    blockerAttention={issue.blockerAttention}
                  />
                </span>
                <span className="text-xs font-mono text-muted-foreground shrink-0">
                  {issue.identifier ?? issue.id.slice(0, 8)}
                </span>
                <span className="flex-1 min-w-0 truncate">{issue.title}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {timeAgo(issue.updatedAt)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* #2 — Initiatives roll-up */}
      {initiatives.length > 0 && (
        <div>
          <SectionHeading>
            <span className="inline-flex items-center gap-2">
              <Target className="h-3.5 w-3.5" />
              Initiatives
              <span className="text-muted-foreground/70 normal-case font-normal tracking-normal">
                ({initiatives.length})
              </span>
            </span>
          </SectionHeading>
          <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
            {initiatives.slice(0, INITIATIVE_DISPLAY_LIMIT).map((rollup) => (
              <Link
                key={rollup.issue.id}
                to={issueHref(rollup.issue)}
                className="flex items-center gap-3 px-4 py-3 text-sm no-underline text-inherit hover:bg-accent/50 transition-colors"
              >
                <PriorityIcon priority={rollup.issue.priority} />
                <span className="text-xs font-mono text-muted-foreground shrink-0">
                  {rollup.issue.identifier ?? rollup.issue.id.slice(0, 8)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {rollup.issue.title}
                </span>
                <span className="hidden sm:flex w-24 shrink-0 items-center gap-2">
                  <ProgressBar percent={rollup.progressPercent} />
                  <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">
                    {rollup.progressPercent}%
                  </span>
                </span>
                <span className="text-xs text-muted-foreground shrink-0 tabular-nums w-16 text-right">
                  {rollup.openChildren} open
                </span>
              </Link>
            ))}
            {initiatives.length > INITIATIVE_DISPLAY_LIMIT && (
              <Link
                to="/issues"
                className="block px-4 py-2.5 text-xs text-muted-foreground no-underline hover:bg-accent/50 transition-colors"
              >
                +{initiatives.length - INITIATIVE_DISPLAY_LIMIT} more initiatives
              </Link>
            )}
          </div>
        </div>
      )}

      {/* #3 — Parked: blocked + agent-review, collapsed */}
      {parked.total > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <button
            type="button"
            onClick={() => setParkedOpen((open) => !open)}
            className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-accent/50 transition-colors"
          >
            <ChevronRight
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                parkedOpen && "rotate-90",
              )}
            />
            <span className="text-sm font-medium">Parked</span>
            <span className="text-xs text-muted-foreground">
              {parked.blocked.length} blocked · {parked.agentReview.length} in agent
              review
            </span>
            <span className="ml-auto inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground text-xs font-medium px-2 py-0.5">
              {parked.total}
            </span>
          </button>

          {parkedOpen && (
            <div className="divide-y divide-border border-t border-border">
              {parked.issues.slice(0, PARKED_DISPLAY_LIMIT).map((issue) => {
                const name = agentName(issue.assigneeAgentId);
                return (
                  <Link
                    key={issue.id}
                    to={issueHref(issue)}
                    className="flex items-center gap-3 px-4 py-2.5 text-sm no-underline text-inherit hover:bg-accent/50 transition-colors"
                  >
                    <StatusIcon
                      status={issue.status}
                      blockerAttention={issue.blockerAttention}
                    />
                    <span className="text-xs font-mono text-muted-foreground shrink-0">
                      {issue.identifier ?? issue.id.slice(0, 8)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                    {name && (
                      <span className="hidden sm:inline-flex shrink-0">
                        <Identity name={name} size="sm" />
                      </span>
                    )}
                  </Link>
                );
              })}
              {parked.total > PARKED_DISPLAY_LIMIT && (
                <div className="px-4 py-2.5 text-xs text-muted-foreground">
                  Showing first {PARKED_DISPLAY_LIMIT} of {parked.total} parked
                  tasks
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
