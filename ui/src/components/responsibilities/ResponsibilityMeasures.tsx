import type { ReactNode } from "react";
import type { ResponsibilityHealth } from "@paperclipai/shared";
import { Bot } from "lucide-react";
import { Card } from "@/components/ui/card";
import { agentPoweredShare, RESPONSIBILITY_HEALTH_LABEL, RESPONSIBILITY_HEALTH_ORDER } from "@/lib/responsibilities";
import { cn } from "@/lib/utils";
import { healthStatusStyle } from "./ResponsibilityHealthBadge";

/** One proportional bar; each status takes its share of the responsibilities. */
function HealthBar({ counts }: { counts: Record<ResponsibilityHealth, number> }) {
  const total = RESPONSIBILITY_HEALTH_ORDER.reduce((sum, health) => sum + counts[health], 0);
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
      {total > 0
        ? RESPONSIBILITY_HEALTH_ORDER.map((health) =>
            counts[health] > 0 ? (
              <div
                key={health}
                data-health={health}
                className="status-fill h-full"
                style={{ ...healthStatusStyle(health), flexGrow: counts[health], flexBasis: 0 }}
              />
            ) : null,
          )
        : null}
    </div>
  );
}

/**
 * "Where things stand": how many responsibilities are behind, at risk, on
 * track or not measured, over one segmented bar. With `onSelect`, each count
 * filters the list below; `selected` marks the active filter. `children`
 * (a written summary) goes under the counts.
 */
export function ResponsibilityStandingSummary({
  counts,
  selected,
  onSelect,
  children,
}: {
  counts: Record<ResponsibilityHealth, number>;
  selected?: ResponsibilityHealth | null;
  onSelect?: (health: ResponsibilityHealth | null) => void;
  children?: ReactNode;
}) {
  const total = RESPONSIBILITY_HEALTH_ORDER.reduce((sum, health) => sum + counts[health], 0);
  return (
    <Card elevation="low" className="gap-4 px-5 py-4" aria-labelledby="responsibility-standing-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="responsibility-standing-heading" className="text-sm font-semibold text-foreground">
          Where things stand
        </h3>
        <p className="text-xs text-muted-foreground tabular-nums">
          {total === 1 ? "1 responsibility" : `${total} responsibilities`}
        </p>
      </div>
      <HealthBar counts={counts} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role={onSelect ? "group" : undefined} aria-label={onSelect ? "Filter by status" : undefined}>
        {RESPONSIBILITY_HEALTH_ORDER.map((health) => {
          const content = (
            <>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="status-fill size-2 shrink-0 rounded-full" style={healthStatusStyle(health)} aria-hidden="true" />
                <span className="truncate">{RESPONSIBILITY_HEALTH_LABEL[health]}</span>
              </span>
              <span className="text-2xl font-semibold tabular-nums text-foreground">{counts[health]}</span>
            </>
          );
          if (!onSelect) {
            return <div key={health} className="flex min-w-0 flex-col gap-1">{content}</div>;
          }
          const active = selected === health;
          return (
            <button
              key={health}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(active ? null : health)}
              className={cn(
                "flex min-w-0 flex-col items-start gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active && "bg-accent",
              )}
            >
              {content}
            </button>
          );
        })}
      </div>
      {children}
    </Card>
  );
}

/**
 * "Agent-powered": the share of open tasks an agent is running rather than
 * you alone (open tasks assigned to an agent, of all open tasks).
 */
export function AgentPoweredSummary({
  agentTasks,
  userTasks,
  openTasks,
}: {
  agentTasks: number;
  userTasks: number;
  openTasks: number;
}) {
  const share = agentPoweredShare(agentTasks, openTasks);
  return (
    <Card elevation="low" className="gap-4 px-5 py-4" aria-labelledby="responsibility-agent-powered-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="responsibility-agent-powered-heading" className="text-sm font-semibold text-foreground">
          Agent-powered
        </h3>
        <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
      </div>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label="Open tasks run by an agent"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={share.percent}
        aria-valuetext={openTasks > 0 ? `${share.label} open tasks` : share.label}
      >
        {/* Width is the measured share (data), not a visual value. */}
        <div className="h-full rounded-full bg-primary" style={{ width: `${share.percent}%` }} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Run by an agent</span>
          <span className="text-2xl font-semibold tabular-nums text-foreground">{agentTasks}</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">On you alone</span>
          <span className="text-2xl font-semibold tabular-nums text-foreground">{userTasks}</span>
        </div>
      </div>
    </Card>
  );
}
