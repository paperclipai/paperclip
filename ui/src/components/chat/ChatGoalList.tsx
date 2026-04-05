interface GoalInfo {
  id: string;
  title: string;
  status: string;
  level: string;
  description: string | null;
  parentId: string | null;
  ownerAgentId: string | null;
}

interface ChatGoalListProps {
  goals: GoalInfo[];
  onNavigate: (path: string) => void;
}

const MAX_VISIBLE = 6;

const statusStyle: Record<string, { dot: string; label: string }> = {
  planned: { dot: "bg-blue-400", label: "Planned" },
  active: { dot: "bg-emerald-500", label: "Active" },
  completed: { dot: "bg-gray-400", label: "Completed" },
  cancelled: { dot: "bg-red-400", label: "Cancelled" },
};

const levelBadge: Record<string, string> = {
  company: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  team: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  individual: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  task: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export function ChatGoalList({ goals, onNavigate }: ChatGoalListProps) {
  const visible = goals.slice(0, MAX_VISIBLE);
  const remaining = goals.length - visible.length;

  const byStatus = goals.reduce<Record<string, number>>((acc, g) => {
    acc[g.status] = (acc[g.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold">
          {goals.length} Goal{goals.length !== 1 ? "s" : ""}
        </p>
        <div className="flex items-center gap-2">
          {Object.entries(byStatus).map(([status, count]) => (
            <span key={status} className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusStyle[status]?.dot ?? "bg-gray-300"}`} />
              {count} {statusStyle[status]?.label ?? status}
            </span>
          ))}
        </div>
      </div>

      <div>
        {visible.map((goal) => (
          <button
            key={goal.id}
            className="w-full text-left py-1.5 border-b border-border/30 last:border-0 hover:bg-accent/30 transition-colors rounded-sm px-1"
            onClick={() => onNavigate(`goals/${goal.id}`)}
          >
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full shrink-0 ${statusStyle[goal.status]?.dot ?? "bg-gray-300"}`} />
              <span className="text-xs font-medium truncate flex-1">{goal.title}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${levelBadge[goal.level] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}>
                {goal.level}
              </span>
            </div>
            {goal.description && (
              <p className="text-[10px] text-muted-foreground ml-3.5 mt-0.5 truncate">
                {goal.description}
              </p>
            )}
          </button>
        ))}
      </div>

      {remaining > 0 && (
        <p className="text-[10px] text-muted-foreground">... and {remaining} more</p>
      )}

      <button
        className="text-xs text-primary hover:underline cursor-pointer"
        onClick={() => onNavigate("goals")}
      >
        View all goals &rarr;
      </button>
    </div>
  );
}
