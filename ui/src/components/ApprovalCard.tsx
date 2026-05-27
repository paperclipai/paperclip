import { CheckCircle2, XCircle, Clock } from "lucide-react";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Identity } from "./Identity";
import {
  approvalSubject,
  typeIcon,
  defaultTypeIcon,
  ApprovalPayloadRenderer,
  typeLabel,
} from "./ApprovalPayload";
import { timeAgo } from "../lib/timeAgo";
import type { Approval, Agent } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { useCurrentLocale, useLocalizedCopy } from "@/i18n/ui-copy";

function statusIcon(status: string) {
  if (status === "approved") return <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />;
  if (status === "rejected") return <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />;
  if (status === "revision_requested") return <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />;
  if (status === "pending") return <Clock className="h-3.5 w-3.5 text-yellow-600 dark:text-yellow-400" />;
  return null;
}

function approvalTypeLabel(type: string, copy: ReturnType<typeof useLocalizedCopy>) {
  const labels: Record<string, string> = {
    hire_agent: copy("approval.type.hireAgent", "Hire Agent", "직원 채용"),
    approve_ceo_strategy: copy("approval.type.ceoStrategy", "CEO Strategy", "CEO 전략"),
    budget_override_required: copy("approval.type.budgetOverride", "Budget Override", "예산 초과 승인"),
    request_board_approval: copy("approval.type.boardApproval", "Board Approval", "보드 승인"),
  };
  return labels[type] ?? typeLabel[type] ?? type;
}

function approvalStatusLabel(status: string, copy: ReturnType<typeof useLocalizedCopy>) {
  const labels: Record<string, string> = {
    pending: copy("approval.status.pending", "Pending", "대기"),
    approved: copy("approval.status.approved", "Approved", "승인됨"),
    rejected: copy("approval.status.rejected", "Rejected", "거절됨"),
    revision_requested: copy("approval.status.revisionRequested", "Revision requested", "수정 요청"),
  };
  return labels[status] ?? status.replace(/_/g, " ");
}

export function ApprovalCard({
  approval,
  requesterAgent,
  onApprove,
  onReject,
  onOpen,
  detailLink,
  isPending = false,
  pendingAction = null,
}: {
  approval: Approval;
  requesterAgent: Agent | null;
  onApprove?: () => void;
  onReject?: () => void;
  onOpen?: () => void;
  detailLink?: string;
  isPending?: boolean;
  pendingAction?: "approve" | "reject" | null;
}) {
  const copy = useLocalizedCopy();
  const locale = useCurrentLocale();
  const payload = approval.payload as Record<string, unknown> | null;
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const kindLabel = approvalTypeLabel(approval.type, copy);
  const subject = approvalSubject(payload);
  const showResolutionButtons =
    Boolean(onApprove && onReject) &&
    approval.type !== "budget_override_required" &&
    (approval.status === "pending" || approval.status === "revision_requested");
  const hasFooter = showResolutionButtons || Boolean(detailLink || onOpen);

  return (
    <div className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/80">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-border/70 bg-background/70 px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
                >
                  {kindLabel}
                </Badge>
                {requesterAgent && (
                  <div className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{copy("approval.requestedBy", "Requested by", "요청자")}</span>
                    <Identity name={requesterAgent.name} size="sm" className="inline-flex" />
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-semibold leading-6 text-foreground">
                  {subject ?? kindLabel}
                </h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  {copy("approval.created", "Approval request created {{time}}", "{{time}} 승인 요청 생성", { time: timeAgo(approval.createdAt, locale) })}
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className="shrink-0">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-2.5 py-1 text-xs text-muted-foreground">
            {statusIcon(approval.status)}
            <span>{approvalStatusLabel(approval.status, copy)}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-border/60 pt-4">
        <ApprovalPayloadRenderer
          type={approval.type}
          payload={approval.payload}
          hidePrimaryTitle={Boolean(subject)}
        />
      </div>

      {approval.decisionNote && (
        <div className="mt-4 rounded-lg border border-border/60 bg-muted/30 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">{copy("approval.decisionNote", "Decision note.", "결정 메모.")}</span> {approval.decisionNote}
        </div>
      )}

      {hasFooter ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {showResolutionButtons && (
              <>
                <Button
                  size="sm"
                  className="bg-green-700 hover:bg-green-600 text-white"
                  onClick={onApprove}
                  disabled={isPending}
                >
                  {pendingAction === "approve" ? copy("approval.approving", "Approving...", "승인 중...") : copy("approval.approve", "Approve", "승인")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={onReject}
                  disabled={isPending}
                >
                  {pendingAction === "reject" ? copy("approval.rejecting", "Rejecting...", "거절 중...") : copy("approval.reject", "Reject", "거절")}
                </Button>
              </>
            )}
          </div>
          {(detailLink || onOpen) ? (
            detailLink ? (
              <Link
                to={detailLink}
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-auto px-2 text-xs text-muted-foreground")}
              >
                {copy("common.viewDetails", "View details", "상세 보기")}
              </Link>
            ) : (
              <Button variant="ghost" size="sm" className="h-auto px-2 text-xs text-muted-foreground" onClick={onOpen}>
                {copy("common.viewDetails", "View details", "상세 보기")}
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
