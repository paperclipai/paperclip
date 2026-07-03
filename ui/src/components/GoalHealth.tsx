import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Goal, Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { cn, formatDate, issueUrl } from "../lib/utils";

interface GoalHealthProps {
  goal: Goal;
  companyId: string;
  // The goal itself plus every descendant goal id — issues bind to the most
  // specific goal, so a parent's health must roll up its whole subtree.
  goalIds: string[];
}

type HealthTone = "on-target" | "at-risk" | "off-target" | "unknown";

function toneFromRatio(ratio: number | null): HealthTone {
  if (ratio === null || !Number.isFinite(ratio)) return "unknown";
  if (ratio >= 0.9) return "on-target";
  if (ratio >= 0.7) return "at-risk";
  return "off-target";
}

const TONE_LABEL: Record<HealthTone, string> = {
  "on-target": "On target",
  "at-risk": "At risk",
  "off-target": "Off target",
  unknown: "No data",
};

const TONE_CLASS: Record<HealthTone, string> = {
  "on-target": "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "at-risk": "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "off-target": "bg-red-500/15 text-red-600 dark:text-red-400",
  unknown: "bg-muted text-muted-foreground",
};

function HealthPill({ tone, children }: { tone: HealthTone; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-sm", TONE_CLASS[tone])}>
      {children}
    </span>
  );
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function sprintLabel(issue: Issue): string | null {
  const sprint = (issue.labels ?? []).find((l) => l.name.startsWith("sprint-"));
  return sprint ? sprint.name.replace(/^sprint-/, "") : null;
}

export function GoalHealth({ goal, companyId, goalIds }: GoalHealthProps) {
  const issueResults = useQueries({
    queries: goalIds.map((gid) => ({
      queryKey: queryKeys.issues.listByGoal(companyId, gid),
      queryFn: () => issuesApi.list(companyId, { goalId: gid, excludeRoutineExecutions: true }),
      enabled: !!companyId,
    })),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const isLoading = issueResults.some((r) => r.isLoading);

  // Merge + dedupe issues across the subtree's goals.
  const issues = useMemo(() => {
    const byId = new Map<string, Issue>();
    for (const r of issueResults) {
      for (const issue of r.data ?? []) byId.set(issue.id, issue);
    }
    return [...byId.values()];
  }, [issueResults]);

  const agentName = (id: string | null) => (id ? agents?.find((a) => a.id === id)?.name ?? "Agent" : null);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of issues) c[i.status] = (c[i.status] ?? 0) + 1;
    return c;
  }, [issues]);

  // Sprint visualization — filter to one sprint and/or group the table by sprint.
  const [groupBySprint, setGroupBySprint] = useState(true);
  const [sprintFilter, setSprintFilter] = useState<string>("all");

  const NO_SPRINT = "__none__";

  const sprintsPresent = useMemo(() => {
    const s = new Set<string>();
    for (const i of issues) {
      const sp = sprintLabel(i);
      if (sp) s.add(sp);
    }
    // Most recent week first (labels sort lexically = chronologically).
    return [...s].sort().reverse();
  }, [issues]);

  const visibleIssues = useMemo(() => {
    if (sprintFilter === "all") return issues;
    if (sprintFilter === NO_SPRINT) return issues.filter((i) => !sprintLabel(i));
    return issues.filter((i) => sprintLabel(i) === sprintFilter);
  }, [issues, sprintFilter]);

  // Buckets for grouped rendering: each sprint (newest first) then "No sprint".
  const sprintBuckets = useMemo(() => {
    const sorted = [...visibleIssues].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const buckets = new Map<string, Issue[]>();
    for (const i of sorted) {
      const key = sprintLabel(i) ?? NO_SPRINT;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(i);
    }
    const orderedKeys = [...sprintsPresent.filter((s) => buckets.has(s))];
    if (buckets.has(NO_SPRINT)) orderedKeys.push(NO_SPRINT);
    return orderedKeys.map((key) => ({ key, items: buckets.get(key)! }));
  }, [visibleIssues, sprintsPresent]);

  const renderRow = (issue: Issue) => {
    const sprint = sprintLabel(issue);
    const assignee = agentName(issue.assigneeAgentId) ?? (issue.assigneeUserId ? "Board" : null);
    return (
      <Link
        key={issue.id}
        to={issueUrl(issue)}
        className={cn(GRID, "px-3 py-2 text-sm items-center border-b border-border last:border-b-0 hover:bg-accent/50")}
      >
        <span className="text-xs text-muted-foreground tabular-nums">{issue.identifier ?? "—"}</span>
        <span className="truncate">{issue.title}</span>
        <span className="text-xs text-muted-foreground truncate">{assignee ?? "Unassigned"}</span>
        <span className="text-xs">
          {sprint ? (
            <span className="inline-flex items-center px-1.5 py-0.5 bg-muted rounded-sm tabular-nums">{sprint}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{formatDate(issue.createdAt)}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {issue.completedAt ? formatDate(issue.completedAt) : "—"}
        </span>
        <span>
          <StatusBadge status={issue.status} />
        </span>
      </Link>
    );
  };

  const done = counts.done ?? 0;
  const cancelled = counts.cancelled ?? 0;
  const blocked = counts.blocked ?? 0;
  const considered = issues.length - cancelled;
  const doneFrac = considered > 0 ? done / considered : 0;

  // Time burn — start at the goal's creation, end at its target date.
  const now = Date.now();
  const startMs = new Date(goal.createdAt).getTime();
  const endMs = goal.targetDate ? new Date(goal.targetDate).getTime() : null;
  const timeElapsedFrac =
    endMs && endMs > startMs ? clamp01((now - startMs) / (endMs - startMs)) : null;

  const executionRatio = timeElapsedFrac && timeElapsedFrac > 0 ? doneFrac / timeElapsedFrac : null;
  const executionTone = toneFromRatio(executionRatio);

  // Outcome — the real scoreboard. Current vs the linear ramp expected by now.
  const target = goal.metricTarget != null ? Number(goal.metricTarget) : null;
  const current = goal.metricCurrent != null ? Number(goal.metricCurrent) : 0;
  const hasMetric = target != null && target > 0;
  const progressFrac = hasMetric ? clamp01(current / (target as number)) : null;
  const outcomeRatio =
    hasMetric && timeElapsedFrac && timeElapsedFrac > 0 ? current / (target as number) / timeElapsedFrac : null;
  const outcomeTone = toneFromRatio(outcomeRatio);
  const expectedNow = hasMetric && timeElapsedFrac != null ? Math.round((target as number) * timeElapsedFrac) : null;

  const fmtNum = (n: number) => n.toLocaleString("en-US");

  return (
    <div className="space-y-6">
      {/* Outcome metric */}
      <div className="border border-border p-4 space-y-3">
        {hasMetric ? (
          <>
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold tabular-nums">{fmtNum(current)}</span>
                <span className="text-sm text-muted-foreground">/ {fmtNum(target as number)}</span>
                {goal.metricUnit && <span className="text-sm text-muted-foreground">{goal.metricUnit}</span>}
              </div>
              <HealthPill tone={outcomeTone}>Outcome · {TONE_LABEL[outcomeTone]}</HealthPill>
            </div>
            <div className="h-2 w-full bg-muted rounded-sm overflow-hidden relative">
              <div
                className="h-full bg-foreground/70"
                style={{ width: `${(progressFrac ?? 0) * 100}%` }}
              />
              {timeElapsedFrac != null && (
                <div
                  className="absolute top-0 bottom-0 w-px bg-foreground/40"
                  style={{ left: `${timeElapsedFrac * 100}%` }}
                  title="Where you should be by now"
                />
              )}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                {expectedNow != null ? `Expected ~${fmtNum(expectedNow)} by now` : "Set a target date for pacing"}
              </span>
              <span>{goal.targetDate ? `Ship-by ${formatDate(goal.targetDate)}` : "No target date"}</span>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No metric set. Add a target + current value in the properties panel to track outcome health.
          </p>
        )}
      </div>

      {/* Execution */}
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <HealthPill tone={executionTone}>Execution · {TONE_LABEL[executionTone]}</HealthPill>
        <span className="text-muted-foreground">
          {done}/{considered} done
        </span>
        {(counts.in_progress ?? 0) > 0 && (
          <span className="text-muted-foreground">{counts.in_progress} in progress</span>
        )}
        {(counts.in_review ?? 0) > 0 && (
          <span className="text-muted-foreground">{counts.in_review} in review</span>
        )}
        {blocked > 0 && <span className="text-red-600 dark:text-red-400">{blocked} blocked</span>}
        {timeElapsedFrac != null && (
          <span className="text-muted-foreground">· {Math.round(timeElapsedFrac * 100)}% of time elapsed</span>
        )}
      </div>

      {/* Issues table */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading issues…</p>
      ) : issues.length === 0 ? (
        <p className="text-sm text-muted-foreground">No issues tied to this goal or its sub-goals yet.</p>
      ) : (
        <div className="space-y-2">
          {/* Sprint controls */}
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="text-muted-foreground">Sprint:</span>
            <SprintChip label="All" active={sprintFilter === "all"} onClick={() => setSprintFilter("all")} />
            {sprintsPresent.map((s) => (
              <SprintChip key={s} label={s} active={sprintFilter === s} onClick={() => setSprintFilter(s)} />
            ))}
            <SprintChip
              label="No sprint"
              active={sprintFilter === NO_SPRINT}
              onClick={() => setSprintFilter(NO_SPRINT)}
            />
            <button
              type="button"
              onClick={() => setGroupBySprint((v) => !v)}
              className={cn(
                "ml-auto inline-flex items-center px-2 py-0.5 rounded-sm border border-border",
                groupBySprint ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              Group by sprint
            </button>
          </div>

          {visibleIssues.length === 0 ? (
            <p className="text-sm text-muted-foreground">No issues in this sprint.</p>
          ) : groupBySprint ? (
            sprintBuckets.map(({ key, items }) => {
              const doneInBucket = items.filter((i) => i.status === "done").length;
              const open = items.filter((i) => i.status !== "cancelled").length;
              return (
                <div key={key} className="border border-border">
                  <div className="flex items-center justify-between px-3 py-1.5 bg-muted/40 border-b border-border">
                    <span className="text-xs font-medium tabular-nums">
                      {key === NO_SPRINT ? "No sprint" : key}
                    </span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {doneInBucket}/{open} done
                    </span>
                  </div>
                  <IssueTableHeader />
                  {items.map((issue) => renderRow(issue))}
                </div>
              );
            })
          ) : (
            <div className="border border-border">
              <IssueTableHeader />
              {[...visibleIssues]
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .map((issue) => renderRow(issue))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const GRID = "grid grid-cols-[80px_1fr_120px_110px_90px_90px_100px] gap-2";

function IssueTableHeader() {
  return (
    <div className={cn(GRID, "px-3 py-2 text-[11px] uppercase text-muted-foreground border-b border-border")}>
      <span>ID</span>
      <span>Title</span>
      <span>Assignee</span>
      <span>Sprint</span>
      <span>Created</span>
      <span>Completed</span>
      <span>Status</span>
    </div>
  );
}

function SprintChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-sm border border-border tabular-nums",
        active ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      {label}
    </button>
  );
}
