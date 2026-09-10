import { useState, type ReactNode } from "react";
import { Link } from "@/lib/router";
import { ChevronDown, DollarSign } from "lucide-react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import type { DecisionListItem } from "../../api/decisions";
import { AttentionQueueRow } from "../AttentionQueueRow";
import { StatusGlyph } from "../StatusGlyph";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { useInboxDismissals } from "../../hooks/useInboxBadge";
import {
  OPERATOR_LIST_PREVIEW_LIMIT,
  OPERATOR_TIME_WINDOW_OPTIONS,
  loadOperatorEngineeringOpen,
  saveOperatorEngineeringOpen,
  type DeliveredOutcome,
  type NextCandidate,
  type OperatorInventoryNote,
  type OperatorTimeWindowId,
  type OperatorWindowResolution,
  type ProjectRollup,
  type StuckTask,
} from "../../lib/operator-dashboard";
import { cn, relativeTime } from "../../lib/utils";
import { createIssueDetailPath } from "../../lib/issueDetailBreadcrumb";

// ---------------------------------------------------------------------------
// Section shell — plain heading + action, no card chrome (craft floor: cards
// are the lazy container; hierarchy comes from position and weight).
// ---------------------------------------------------------------------------

export function OperatorSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function OperatorEmpty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-sm text-muted-foreground">{children}</p>;
}

function OperatorRows({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-border border-y border-border">{children}</ul>;
}

// ---------------------------------------------------------------------------
// Time-window picker
// ---------------------------------------------------------------------------

export function OperatorWindowPicker({
  windowId,
  resolution,
  inventory,
  onChange,
}: {
  windowId: OperatorTimeWindowId;
  resolution: OperatorWindowResolution;
  inventory: OperatorInventoryNote;
  onChange: (next: OperatorTimeWindowId) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <label htmlFor="operator-window" className="text-sm text-muted-foreground">
        Showing work from
      </label>
      <select
        id="operator-window"
        value={windowId}
        onChange={(event) => onChange(event.target.value as OperatorTimeWindowId)}
        className="rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground focus-visible:ring-ring focus-visible:ring-(length:--rad-3) focus-visible:outline-none"
      >
        {OPERATOR_TIME_WINDOW_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="text-xs text-muted-foreground">
        {resolution.label} · {inventory.note}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Completed work — root outcomes first, capped so decisions stay on screen
// ---------------------------------------------------------------------------

const COMPLETED_VISIBLE_LIMIT = 6;

function OutcomeRow({ outcome }: { outcome: DeliveredOutcome }) {
  return (
    <li className="flex items-start gap-2.5 py-2.5">
      <StatusGlyph status="done" size="md" className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <Link
          to={createIssueDetailPath({ id: outcome.issueId, identifier: outcome.identifier })}
          className="line-clamp-2 text-sm font-medium text-foreground no-underline hover:underline"
        >
          {outcome.title || "Title not recorded"}
        </Link>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {outcome.identifier && (
            <span className="font-mono text-(length:--text-nano)">{outcome.identifier}</span>
          )}
          <span>{outcome.verificationLabel}</span>
          <span>{outcome.areaLabel}</span>
          {outcome.projectName && <span>{outcome.projectName}</span>}
          <span>{relativeTime(new Date(outcome.completedAtMs))}</span>
        </p>
      </div>
      {outcome.evidenceHref && (
        <a
          href={outcome.evidenceHref}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {outcome.evidenceLabel ?? "Evidence"}
        </a>
      )}
    </li>
  );
}

export function CompletedWorkSection({ outcomes }: { outcomes: DeliveredOutcome[] }) {
  const [expanded, setExpanded] = useState(false);
  const [includeSubtasks, setIncludeSubtasks] = useState(false);
  const roots = outcomes.filter((outcome) => !outcome.isChild && !outcome.isSystemTask);
  const rest = outcomes.filter((outcome) => outcome.isChild || outcome.isSystemTask);
  const visibleRoots = expanded ? roots : roots.slice(0, COMPLETED_VISIBLE_LIMIT);

  if (outcomes.length === 0) {
    return (
      <OperatorSection title="Completed work">
        <OperatorEmpty>
          Nothing completed in this window. Tasks without a recorded completion time are not counted.
        </OperatorEmpty>
      </OperatorSection>
    );
  }
  return (
    <OperatorSection
      title="Completed work"
      action={<span className="text-xs tabular-nums text-muted-foreground">{roots.length}</span>}
    >
      <OperatorRows>
        {visibleRoots.map((outcome) => (
          <OutcomeRow key={outcome.issueId} outcome={outcome} />
        ))}
        {includeSubtasks &&
          rest.map((outcome) => <OutcomeRow key={outcome.issueId} outcome={outcome} />)}
      </OperatorRows>
      <div className="flex flex-wrap gap-2 pt-1">
        {roots.length > COMPLETED_VISIBLE_LIMIT && (
          <Button type="button" variant="ghost" size="xs" onClick={() => setExpanded((prev) => !prev)}>
            {expanded ? "Show less" : `Show ${roots.length - COMPLETED_VISIBLE_LIMIT} more`}
          </Button>
        )}
        {rest.length > 0 && (
          <Button type="button" variant="ghost" size="xs" onClick={() => setIncludeSubtasks((prev) => !prev)}>
            {includeSubtasks
              ? "Hide subtasks and system tasks"
              : `Show ${rest.length} subtask${rest.length === 1 ? "" : "s"} and system tasks`}
          </Button>
        )}
      </div>
      <p className="text-(length:--text-nano) text-muted-foreground">
        Counts independent product deliveries only — subtasks and system tasks list separately. Only a
        recorded merge for the current outcome counts as verified; anything else is recorded done, not
        verified. Tasks without a recorded completion time are not counted.
      </p>
    </OperatorSection>
  );
}

/** Pre-rename alias kept for existing callers. */
export const DeliveredOutcomesSection = CompletedWorkSection;
// ---------------------------------------------------------------------------
// Needs your decision — the viewer's own gates, bounded preview with a way out
// ---------------------------------------------------------------------------

export function NeedsDecisionSection({
  companyId,
  items,
  totalOpenCount,
  agentMap,
  agents,
  currentUserId,
}: {
  companyId: string;
  /** Items already narrowed to the viewer's decision view by the caller. */
  items: AttentionItem[];
  /** Company-wide open decision count from the feed, for the bounded disclosure. */
  totalOpenCount: number;
  agentMap: Map<string, Agent>;
  agents: Agent[] | undefined;
  currentUserId: string | null;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { dismiss, snooze } = useInboxDismissals(companyId);

  if (items.length === 0) {
    return (
      <OperatorSection
        title="Needs your decision"
        action={
          <Link to="/decisions?view=mine" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
            Open decisions
          </Link>
        }
      >
        <OperatorEmpty>No decisions need you right now. New gates land here the moment they surface.</OperatorEmpty>
      </OperatorSection>
    );
  }
  return (
    <OperatorSection
      title="Needs your decision"
      action={
        <Link to="/decisions?view=mine" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          Open your decisions
        </Link>
      }
    >
      <div className="space-y-3">
        {items.map((item) => (
          <AttentionQueueRow
            key={item.id}
            item={item}
            companyId={companyId}
            expanded={expandedId === item.id}
            onToggleExpand={(next) => setExpandedId((prev) => (prev === next.id ? null : next.id))}
            onDismiss={(next) => dismiss(next.dismissalKey)}
            onSnooze={(next, until) => snooze(next.dismissalKey, until)}
            agentMap={agentMap}
            agents={agents}
            showTriage
            currentUserId={currentUserId}
          />
        ))}
      </div>
      <p className="text-(length:--text-nano) text-muted-foreground">
        Showing {items.length} of {totalOpenCount} open decision{totalOpenCount === 1 ? "" : "s"} — your
        gates first, the rest under All.
      </p>
    </OperatorSection>
  );
}

// ---------------------------------------------------------------------------
// Recently decided — the actual verdict, its effect state, affected work
// ---------------------------------------------------------------------------

function decidedExecutionLabel(decision: DecisionListItem): string {
  const executions = decision.executions ?? [];
  if (executions.length === 0) return "No effects recorded";
  if (executions.some((execution) => execution.status === "failed")) return "Apply failed";
  if (executions.some((execution) => execution.status === "claimed")) return "Applying…";
  if (executions.every((execution) => execution.status === "executed")) return "Applied";
  if (executions.every((execution) => execution.status === "skipped")) return "Skipped";
  return "Partially applied";
}

export function RecentlyDecidedSection({
  decisions,
  decidedByLabel,
}: {
  decisions: DecisionListItem[];
  decidedByLabel: (userId: string | null) => string | null;
}) {
  if (decisions.length === 0) {
    return (
      <OperatorSection title="Recently decided">
        <OperatorEmpty>No decisions recorded yet.</OperatorEmpty>
      </OperatorSection>
    );
  }
  return (
    <OperatorSection
      title="Recently decided"
      action={
        <Link to="/decisions?view=all" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          Decision history
        </Link>
      }
    >
      <OperatorRows>
        {decisions.map((decision) => {
          const chosen = decision.options.find((option) => option.id === decision.chosenOptionId) ?? null;
          const affectedCount = Object.keys(decision.targetSnapshots ?? {}).length;
          const byLabel = decidedByLabel(decision.decidedByUserId);
          return (
            <li key={decision.id} className="flex items-start gap-2.5 py-2.5">
              <StatusGlyph status="done" size="md" className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <Link
                  to={`/decisions?decisionId=${decision.id}`}
                  className="line-clamp-2 text-sm font-medium text-foreground no-underline hover:underline"
                >
                  {decision.title || "Title not recorded"}
                </Link>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">
                    Chose: {chosen?.label ?? (decision.chosenOptionId ? "Option not recorded" : "No option recorded")}
                  </span>
                  <span>{decidedExecutionLabel(decision)}</span>
                  {affectedCount > 0 && (
                    <span>
                      Affects {affectedCount} task{affectedCount === 1 ? "" : "s"}
                    </span>
                  )}
                  {decision.decidedAt && <span>{relativeTime(decision.decidedAt)}</span>}
                  {byLabel && <span>by {byLabel}</span>}
                </p>
                {chosen?.description && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{chosen.description}</p>
                )}
              </div>
            </li>
          );
        })}
      </OperatorRows>
    </OperatorSection>
  );
}

// ---------------------------------------------------------------------------
// Stuck tasks — cause, owner, impact
// ---------------------------------------------------------------------------

export function StuckTasksSection({ stuck }: { stuck: StuckTask[] }) {
  const visible = stuck.slice(0, OPERATOR_LIST_PREVIEW_LIMIT);
  if (stuck.length === 0) {
    return (
      <OperatorSection title="Stuck">
        <OperatorEmpty>Nothing blocked. Stuck tasks land here with their cause and owner.</OperatorEmpty>
      </OperatorSection>
    );
  }
  return (
    <OperatorSection
      title="Stuck"
      action={
        <span className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">{stuck.length}</span>
          <Link to="/issues" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
            Open task list
          </Link>
        </span>
      }
    >
      <OperatorRows>
        {visible.map((task) => (
          <li key={task.issueId} className="flex items-start gap-2.5 py-2.5">
            <StatusGlyph status="blocked" size="md" className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <Link
                to={createIssueDetailPath({ id: task.issueId, identifier: task.identifier })}
                className="line-clamp-2 text-sm font-medium text-foreground no-underline hover:underline"
              >
                {task.title || "Title not recorded"}
              </Link>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {task.cause ? (
                  <span className="line-clamp-2">{task.cause}</span>
                ) : (
                  <span>Cause not recorded — open the task for details.</span>
                )}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {task.identifier && (
                  <span className="font-mono text-(length:--text-nano)">{task.identifier}</span>
                )}
                <span>Owner: {task.ownerLabel ?? "not recorded"}</span>
                {task.projected && <span>Delivery-blocked — status not yet blocked</span>}
                {task.impactLabel && <span>{task.impactLabel}</span>}
                {task.projectName && <span>{task.projectName}</span>}
                {task.blockedSinceMs !== null && <span>Blocked {relativeTime(new Date(task.blockedSinceMs))}</span>}
              </p>
            </div>
          </li>
        ))}
      </OperatorRows>
    </OperatorSection>
  );
}

// ---------------------------------------------------------------------------
// Next candidates — nearest completion first, never a promised date
// ---------------------------------------------------------------------------

export function NextCandidatesSection({ candidates }: { candidates: NextCandidate[] }) {
  if (candidates.length === 0) {
    return (
      <OperatorSection title="Next up">
        <OperatorEmpty>No active candidates. Queued and in-flight tasks appear here.</OperatorEmpty>
      </OperatorSection>
    );
  }
  return (
    <OperatorSection title="Next up">
      <OperatorRows>
        {candidates.map((candidate) => (
          <li key={candidate.issueId} className="flex items-start gap-2.5 py-2.5">
            <StatusGlyph status={candidate.status} size="md" className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <Link
                to={createIssueDetailPath({ id: candidate.issueId, identifier: candidate.identifier })}
                className="line-clamp-2 text-sm font-medium text-foreground no-underline hover:underline"
              >
                {candidate.title || "Title not recorded"}
              </Link>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {candidate.identifier && (
                  <span className="font-mono text-(length:--text-nano)">{candidate.identifier}</span>
                )}
                <span>{candidate.reason}</span>
                {candidate.projectName && <span>{candidate.projectName}</span>}
              </p>
            </div>
          </li>
        ))}
      </OperatorRows>
      <p className="text-(length:--text-nano) text-muted-foreground">
        Ordered by nearness to done. No dates here are promises.
      </p>
    </OperatorSection>
  );
}

// ---------------------------------------------------------------------------
// Project rollups
// ---------------------------------------------------------------------------

export function ProjectRollupsSection({ rollups }: { rollups: ProjectRollup[] }) {
  const visible = rollups.slice(0, OPERATOR_LIST_PREVIEW_LIMIT);
  if (rollups.length === 0) {
    return (
      <OperatorSection title="Projects">
        <OperatorEmpty>No projects with loaded tasks.</OperatorEmpty>
      </OperatorSection>
    );
  }
  return (
    <OperatorSection
      title="Projects"
      action={
        <Link to="/projects" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          All projects
        </Link>
      }
    >
      <OperatorRows>
        {visible.map((rollup) => {
          const inner = (
            <>
              {/* token-extraction: allowlisted — project accent dot mirrors the sanctioned IssueColumns pattern. */}
              <span
                aria-hidden
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: rollup.color ?? "#64748b" }}
              />
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{rollup.name}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {rollup.delivered} delivered · {rollup.blocked} blocked · {rollup.inReview} in review ·{" "}
                  {rollup.active} active
                </span>
              </div>
            </>
          );
          return (
            <li key={rollup.projectId ?? "unassigned"} className="flex items-start gap-2.5 py-2.5">
              {rollup.projectId ? (
                <Link
                  to={`/projects/${rollup.projectId}`}
                  className="flex min-w-0 flex-1 items-start gap-2.5 no-underline hover:underline"
                >
                  {inner}
                </Link>
              ) : (
                <div className="flex min-w-0 flex-1 items-start gap-2.5">{inner}</div>
              )}
            </li>
          );
        })}
      </OperatorRows>
    </OperatorSection>
  );
}

// ---------------------------------------------------------------------------
// Compact cost strip (retained outside the engineering disclosure)
// ---------------------------------------------------------------------------

export function OperatorCostStrip({
  monthSpendLabel,
  budgetLabel,
  coverageNote,
}: {
  monthSpendLabel: string;
  budgetLabel: string;
  coverageNote: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-border py-2.5">
      <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
        <DollarSign className="h-4 w-4 shrink-0 text-muted-foreground" />
        Month spend {monthSpendLabel}
      </span>
      <span className="text-xs text-muted-foreground">{budgetLabel}</span>
      {coverageNote && <span className="text-xs text-muted-foreground">{coverageNote}</span>}
      <Link to="/costs" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
        Review costs
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Engineering disclosure — the old agent/run stats live here, one click away
// ---------------------------------------------------------------------------

export function EngineeringDisclosure({
  companyId,
  summary,
  children,
}: {
  companyId: string;
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => loadOperatorEngineeringOpen(companyId));
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        saveOperatorEngineeringOpen(companyId, next);
      }}
    >
      <div className="border-y border-border py-2.5">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-between px-1 text-sm font-semibold"
            aria-expanded={open}
          >
            Engineering detail
            <span className="flex items-center gap-2 font-normal">
              <span className="hidden text-xs text-muted-foreground sm:inline">{summary}</span>
              <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4">
          <div className="space-y-6">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
