import type { Goal } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { StatusBadge } from "./StatusBadge";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { useState } from "react";

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
  const guidancePreview = goal.guidance
    ? goal.guidance.replace(/[#*_`>-]/g, " ").replace(/\s+/g, " ").trim()
    : "";

  const inner = (
    <>
      {hasChildren ? (
        <button
          className="paperclip-icon-button rounded-full p-0.5"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
          />
        </button>
      ) : (
        <span className="w-4" />
      )}
      <span className="paperclip-work-meta capitalize">{goal.level}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{goal.title}</div>
        {guidancePreview && (
          <div className="truncate text-xs text-muted-foreground">
            {guidancePreview}
          </div>
        )}
      </div>
      <StatusBadge status={goal.status} />
    </>
  );

  const classes = cn(
    "paperclip-work-row flex items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--primary)_10%,var(--border))] px-3 py-2 text-sm transition-colors cursor-pointer last:border-b-0",
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
    return <p className="text-sm text-muted-foreground">No roadmap items.</p>;
  }

  return (
    <div className="paperclip-work-list py-1">
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
