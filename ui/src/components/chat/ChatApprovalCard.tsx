interface ApprovalInfo {
  id: string;
  type: string;
  status: string;
  requestedByAgentId: string | null;
  decisionNote: string | null;
  createdAt: string;
  payload?: Record<string, unknown>;
}

interface ChatApprovalCardProps {
  approvals: ApprovalInfo[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onRequestRevision: (id: string) => void;
  onNavigate: (path: string) => void;
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ChatApprovalCard({ approvals, onApprove, onReject, onRequestRevision, onNavigate }: ChatApprovalCardProps) {
  const pending = approvals.filter((a) => a.status === "pending");

  if (pending.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-3 text-sm">
        <p className="text-xs text-muted-foreground">No pending approvals.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {pending.map((approval) => (
        <div
          key={approval.id}
          className="rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-3 text-sm space-y-2"
        >
          <p className="text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
            Pending Approval
          </p>
          <p className="text-xs font-medium">{formatType(approval.type)}</p>
          {approval.decisionNote && (
            <p className="text-xs text-muted-foreground">&ldquo;{approval.decisionNote}&rdquo;</p>
          )}
          <p className="text-[10px] text-muted-foreground">
            {approval.requestedByAgentId ? `Agent: ${approval.requestedByAgentId.slice(0, 8)}` : "System"}
            {" "}&middot; {relativeTime(approval.createdAt)}
          </p>
          <div className="flex gap-2">
            <button
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
              onClick={() => onApprove(approval.id)}
            >
              Approve
            </button>
            <button
              className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-white"
              onClick={() => onReject(approval.id)}
            >
              Reject
            </button>
            <button
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
              onClick={() => onRequestRevision(approval.id)}
            >
              Revise
            </button>
          </div>
        </div>
      ))}

      <button
        className="text-xs text-primary hover:underline cursor-pointer"
        onClick={() => onNavigate("approvals")}
      >
        View all approvals &rarr;
      </button>
    </div>
  );
}
