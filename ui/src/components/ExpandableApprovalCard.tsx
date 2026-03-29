import { useMemo } from "react";
import type { Agent, Approval } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Identity } from "./Identity";
import { CeoStrategyPayload, approvalLabel } from "./ApprovalPayload";
import { cn } from "../lib/utils";

interface ExpandableApprovalCardProps {
  approval: Approval;
  requesterAgent: Agent | null;
  expanded: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRequestRevision: (note?: string) => void;
  isPending: boolean;
  needsReminder?: boolean;
  ageHours?: number | null;
  muted?: boolean;
  dismissing?: boolean;
  detailLink: string;
}

function statusDot(approval: Approval, needsReminder: boolean) {
  if (approval.status === "pending" || approval.status === "revision_requested") {
    return needsReminder ? "bg-rose-500" : "bg-yellow-500";
  }
  return "bg-muted-foreground/40";
}

function channelLabel(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return "—";
  const channel = typeof payload.channel === "string" ? payload.channel : null;
  const category = typeof payload.category === "string" ? payload.category : null;
  return channel ?? category ?? "—";
}

export function ExpandableApprovalCard({
  approval,
  requesterAgent,
  expanded,
  onToggle,
  onApprove,
  onReject,
  onRequestRevision,
  isPending,
  needsReminder = false,
  ageHours = null,
  muted = false,
  dismissing = false,
  detailLink,
}: ExpandableApprovalCardProps) {
  const payload = (approval.payload ?? null) as Record<string, unknown> | null;

  const label = useMemo(() => approvalLabel(approval.type, payload), [approval.type, payload]);
  const title = useMemo(() => {
    const payloadTitle = payload && typeof payload.title === "string" ? payload.title.trim() : "";
    return payloadTitle.length > 0 ? payloadTitle : label;
  }, [payload, label]);
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-card transition-all duration-200",
        muted && "opacity-60",
        dismissing && "opacity-0 translate-y-1",
        needsReminder && isActionable && "border-rose-300/60",
      )}
    >
      {needsReminder && isActionable && (
        <div className="border-b border-rose-300/50 bg-rose-500/10 px-3 py-1 text-[11px] text-rose-700 dark:text-rose-300">
          Pending {ageHours ?? 0}h
        </div>
      )}

      <button type="button" onClick={onToggle} className="w-full text-left px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn("inline-flex h-2 w-2 rounded-full", statusDot(approval, needsReminder))} />
              <p className="text-sm font-medium truncate">{title}</p>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">{channelLabel(payload)}</span>
              <span>·</span>
              <span>{typeof ageHours === "number" ? `${ageHours}h` : "—"}</span>
              {requesterAgent && (
                <>
                  <span>·</span>
                  <Identity name={requesterAgent.name} size="sm" className="inline-flex" />
                </>
              )}
            </div>
          </div>
          <span className="text-muted-foreground text-xs shrink-0">{expanded ? "▴" : "▾"}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-3 space-y-3">
          <CeoStrategyPayload payload={payload ?? {}} />

          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex gap-2">
              <Button
                size="sm"
                className="bg-green-700 hover:bg-green-600 text-white"
                onClick={onApprove}
                disabled={isPending || !isActionable}
              >
                Approve
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={onReject}
                disabled={isPending || !isActionable}
              >
                Reject
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRequestRevision()}
                disabled={isPending || !isActionable}
              >
                Request edits
              </Button>
            </div>

            <Link to={detailLink} className="text-xs text-muted-foreground hover:text-foreground no-underline">
              Full draft ↗️
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
