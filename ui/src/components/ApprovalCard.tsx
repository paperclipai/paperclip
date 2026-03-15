import { CheckCircle2, XCircle, Clock } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Identity } from "./Identity";
import { typeLabel, typeIcon, defaultTypeIcon, ApprovalPayloadRenderer } from "./ApprovalPayload";
import { timeAgo } from "../lib/timeAgo";
import type { Approval, Agent } from "@paperclipai/shared";

function statusIcon(status: string) {
  if (status === "approved") return <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />;
  if (status === "rejected") return <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />;
  if (status === "revision_requested") return <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />;
  if (status === "pending") return <Clock className="h-3.5 w-3.5 text-yellow-600 dark:text-yellow-400" />;
  return null;
}

export function ApprovalCard({
  approval,
  requesterAgent,
  onApprove,
  onReject,
  onOpen,
  detailLink,
  isPending,
}: {
  approval: Approval;
  requesterAgent: Agent | null;
  onApprove: () => void;
  onReject: () => void;
  onOpen?: () => void;
  detailLink?: string;
  isPending: boolean;
}) {
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const label = typeLabel[approval.type] ?? approval.type;

  return (
    <div className="paperclip-monitor-card space-y-4 p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="paperclip-chip flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <div className="space-y-1">
            <p className="paperclip-monitor-title">{label}</p>
            <span className="text-sm font-medium text-foreground">Approval request</span>
            {requesterAgent && (
              <span className="text-xs text-muted-foreground">
                requested by <Identity name={requesterAgent.name} size="sm" className="inline-flex" />
              </span>
            )}
          </div>
        </div>
        <div className="paperclip-chip flex items-center gap-1.5 rounded-full px-3 py-1.5 shrink-0">
          {statusIcon(approval.status)}
          <span className="paperclip-nav-meta text-[0.62rem] text-muted-foreground capitalize">
            {approval.status}
          </span>
          <span className="text-xs text-muted-foreground">· {timeAgo(approval.createdAt)}</span>
        </div>
      </div>

      {/* Payload */}
      <ApprovalPayloadRenderer type={approval.type} payload={approval.payload} />

      {/* Decision note */}
      {approval.decisionNote && (
        <div className="rounded-xl border border-border/70 bg-background/35 px-3 py-2 text-xs text-muted-foreground italic">
          Note: {approval.decisionNote}
        </div>
      )}

      {/* Actions */}
      {(approval.status === "pending" || approval.status === "revision_requested") && (
        <div className="flex gap-2 border-t border-border/70 pt-3">
          <Button
            size="sm"
            className="bg-green-700 hover:bg-green-600 text-white"
            onClick={onApprove}
            disabled={isPending}
          >
            Approve
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onReject}
            disabled={isPending}
          >
            Reject
          </Button>
        </div>
      )}

      <div>
        {detailLink ? (
          <Button variant="ghost" size="sm" className="text-xs px-0 text-primary hover:text-primary" asChild>
            <Link to={detailLink}>View details</Link>
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs px-0 text-primary hover:text-primary"
            onClick={onOpen}
          >
            View details
          </Button>
        )}
      </div>
    </div>
  );
}
