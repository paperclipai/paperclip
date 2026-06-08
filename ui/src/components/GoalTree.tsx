import type { Goal } from "@valadrien-os/shared";
import { Link } from "@/lib/router";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { useState } from "react";

// Goal-specific status badge: "active" = in-progress (teal), distinct from
// "achieved" = done (green) — the shared StatusBadge renders both green.
const GOAL_BADGE: Record<string, string> = {
  planned: "border border-border text-muted-foreground",
  active: "border border-status-running/30 bg-status-running/12 text-status-running",
  achieved: "border border-status-success/30 bg-status-success/12 text-status-success",
  cancelled: "bg-muted text-muted-foreground",
};
const GOAL_LABEL: Record<string, string> = {
  planned: "Planned",
  active: "In progress",
  achieved: "Achieved",
  cancelled: "Cancelled",
};

function GoalBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        GOAL_BADGE[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {GOAL_LABEL[status] ?? status.replace(/_/g, " ")}
    </span>
  );
}

interface GoalTreeProps {
  goals: Goal[];
  goalLink?: (goal: Goal) => string;
  onSelect?: (goal: Goal) => void;
}

interface GoalNodeProps {
  goal: Goal;
  children: Goal[];
  allGoals: Goal[];
  depth: number;
  goalLink?: (goal: Goal) => string;
  onSelect?: (goal: Goal) => void;
}

function GoalNode({ goal, children, allGoals, depth, goalLink, onSelect }: GoalNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = children.length > 0;
  const link = goalLink?.(goal);

  const inner = (
    <>
      {/* tree guides: a hairline per ancestor depth, so the hierarchy reads */}
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-border/70"
          style={{ left: `${i * 16 + 18}px` }}
        />
      ))}
      {hasChildren ? (
        <button
          className="p-0.5"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          <ChevronRight
            className={cn("h-3 w-3 text-muted-foreground transition-transform", expanded && "rotate-90")}
          />
        </button>
      ) : (
        <span className="w-4" />
      )}
      <span className="shrink-0 rounded-[3px] border border-border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground">
        {goal.level}
      </span>
      <span className="flex-1 truncate">{goal.title}</span>
      <GoalBadge status={goal.status} />
    </>
  );

  const classes = cn(
    "relative flex items-center gap-2 px-3 py-1.5 text-sm transition-colors cursor-pointer hover:bg-accent/50",
  );

  return (
    <div>
      {link ? (
        <Link
          to={link}
          className={cn(classes, "no-underline text-inherit")}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
        >
          {inner}
        </Link>
      ) : (
        <div
          className={classes}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
          onClick={() => onSelect?.(goal)}
        >
          {inner}
        </div>
      )}
      {hasChildren && expanded && (
        <div>
          {children.map((child) => (
            <GoalNode
              key={child.id}
              goal={child}
              children={allGoals.filter((g) => g.parentId === child.id)}
              allGoals={allGoals}
              depth={depth + 1}
              goalLink={goalLink}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function GoalTree({ goals, goalLink, onSelect }: GoalTreeProps) {
  const goalIds = new Set(goals.map((g) => g.id));
  const roots = goals.filter((g) => !g.parentId || !goalIds.has(g.parentId));

  if (goals.length === 0) {
    return <p className="text-sm text-muted-foreground">No goals.</p>;
  }

  return (
    <div className="border border-border py-1">
      {roots.map((goal) => (
        <GoalNode
          key={goal.id}
          goal={goal}
          children={goals.filter((g) => g.parentId === goal.id)}
          allGoals={goals}
          depth={0}
          goalLink={goalLink}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
