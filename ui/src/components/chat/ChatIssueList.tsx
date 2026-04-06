interface IssueInfo {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
}

interface ChatIssueListProps {
  issues: IssueInfo[];
  onNavigate: (path: string) => void;
}

const MAX_VISIBLE = 5;

const priorityDot: Record<string, string> = {
  urgent: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-gray-400",
  none: "bg-gray-300",
};

export function ChatIssueList({ issues, onNavigate }: ChatIssueListProps) {
  const visible = issues.slice(0, MAX_VISIBLE);
  const remaining = issues.length - visible.length;

  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm space-y-1">
      <p className="text-xs font-semibold">{issues.length} Issue{issues.length !== 1 ? "s" : ""}</p>

      <div>
        {visible.map((issue) => (
          <button
            key={issue.id}
            className="w-full text-left py-1.5 border-b border-border/30 last:border-0 hover:bg-accent/30 transition-colors rounded-sm px-1"
            onClick={() => onNavigate(`issues/${issue.identifier ?? issue.id}`)}
          >
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full shrink-0 ${priorityDot[issue.priority] ?? "bg-gray-300"}`} />
              <span className="text-xs font-mono text-muted-foreground shrink-0">{issue.identifier}</span>
              <span className="text-xs font-medium truncate">{issue.title}</span>
            </div>
            <p className="text-[10px] text-muted-foreground ml-3.5 mt-0.5">
              {issue.priority} &middot; {issue.status.replace(/_/g, " ")}
            </p>
          </button>
        ))}
      </div>

      {remaining > 0 && (
        <p className="text-[10px] text-muted-foreground">... and {remaining} more</p>
      )}

      <button
        className="text-xs text-primary hover:underline cursor-pointer"
        onClick={() => onNavigate("issues")}
      >
        View all issues &rarr;
      </button>
    </div>
  );
}
