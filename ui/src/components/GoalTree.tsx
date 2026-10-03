import type { Goal } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { StatusBadge } from "./StatusBadge";
import { ChevronRight, Trash2 } from "lucide-react";
import { cn } from "../lib/utils";
import { useState } from "react";

interface GoalTreeProps {
  goals: Goal[];
  goalLink?: (goal: Goal) => string;
  onSelect?: (goal: Goal) => void;
  onDelete?: (goal: Goal) => void;
}

interface GoalNodeProps {
  goal: Goal;
  children: Goal[];
  allGoals: Goal[];
  depth: number;
  goalLink?: (goal: Goal) => string;
  onSelect?: (goal: Goal) => void;
  onDelete?: (goal: Goal) => void;
}

function GoalNode({ goal, children, allGoals, depth, goalLink, onSelect, onDelete }: GoalNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = children.length > 0;
  const link = goalLink?.(goal);

  const inner = (
    <>
      {hasChildren ? (
        <button
          type="button"
          className="p-0.5"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          aria-label={`${goal.title} subtree`}
          aria-expanded={expanded}
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
          />
        </button>
      ) : (
        <span className="w-4" />
      )}
      <span className="text-xs text-muted-foreground capitalize">{goal.level}</span>
      <span className="flex-1 truncate">{goal.title}</span>
      <StatusBadge status={goal.status} />
    </>
  );

  const innerClasses = "flex items-center gap-2 min-w-0 flex-1";

  const classes = cn(
    "group flex items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent/50",
  );

  return (
    <div>
      <div className={classes} style={{ paddingLeft: `${depth * 16 + 12}px` }}>
        {link ? (
          <Link to={link} className={cn(innerClasses, "no-underline text-inherit cursor-pointer")}>
            {inner}
          </Link>
        ) : (
          <div className={cn(innerClasses, "cursor-pointer")} onClick={() => onSelect?.(goal)}>
            {inner}
          </div>
        )}
        {onDelete && (
          <button
            type="button"
            className="p-1 text-muted-foreground hover:text-destructive opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete(goal);
            }}
            title="Delete goal"
            aria-label={`Delete goal "${goal.title}"`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
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
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function GoalTree({ goals, goalLink, onSelect, onDelete }: GoalTreeProps) {
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
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

