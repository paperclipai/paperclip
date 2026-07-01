import type { Goal } from "@paperclipai/shared";
import { Target } from "lucide-react";
import { GoalTree } from "./GoalTree";

interface CeoGoalsPanelProps {
  goals: Goal[] | undefined;
  isLoading?: boolean;
}

/**
 * Goals context rail beside the CEO conversation — the living context the
 * chat steers (PAP CEO screen). Renders the company's goal tree; each row
 * links to the goal detail. Reused on desktop (right rail) and inside the
 * mobile bottom Sheet, so it owns only its own header + body, never the
 * surrounding chrome.
 */
export function CeoGoalsPanel({ goals, isLoading = false }: CeoGoalsPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 py-3">
        <Target className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold">Goals</h3>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-auto-hide px-4 pb-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading goals…</p>
        ) : goals && goals.length > 0 ? (
          <GoalTree goals={goals} goalLink={(goal) => `/goals/${goal.id}`} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No goals yet. Tell your CEO what you want to achieve and they'll
            help you put the first one on paper.
          </p>
        )}
      </div>
    </div>
  );
}
