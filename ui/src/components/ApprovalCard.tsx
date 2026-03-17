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
  const showResolutionButtons =
    approval.type !== "budget_override_required" &&
    (approval.status === "pending" || approval.status === "revision_requested");

  return (
    <div className="border border-border rounded-lg p-4 space-y-0">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{label}</span>
            {requesterAgent && (
              <span className="text-xs text-muted-foreground">
                requested by <Identity name={requesterAgent.name} size="sm" className="inline-flex" />
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {statusIcon(approval.status)}
          <span className="text-xs text-muted-foreground capitalize">{approval.status}</span>
          <span className="text-xs text-muted-foreground">· {timeAgo(approval.createdAt)}</span>
        </div>
      </div>

      {/* Payload */}
      <ApprovalPayloadRenderer type={approval.type} payload={approval.payload} />

      {/* Decision note */}
      {approval.decisionNote && (
        <div className="mt-3 text-xs text-muted-foreground italic border-t border-border pt-2">
          Note: {approval.decisionNote}
        </div>
      )}

      {/* Actions */}
      {showResolutionButtons && (
        <div className="flex gap-2 mt-4 pt-3 border-t border-border">
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
      <div className="mt-3">
        {detailLink ? (
          <Button variant="ghost" size="sm" className="text-xs px-0" asChild>
            <Link to={detailLink}>View details</Link>
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="text-xs px-0" onClick={onOpen}>
            View details
          </Button>
        )}
      </div>
    </div>
  );
}
