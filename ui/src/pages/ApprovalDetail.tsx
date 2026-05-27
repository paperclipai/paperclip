import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import { approvalSubject, typeIcon, defaultTypeIcon, ApprovalPayloadRenderer } from "../components/ApprovalPayload";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, ChevronRight, Sparkles } from "lucide-react";
import type { ApprovalComment } from "@paperclipai/shared";
import { MarkdownBody } from "../components/MarkdownBody";
import { useCurrentLocale, useLocalizedCopy } from "../i18n/ui-copy";

export function ApprovalDetail() {
  const { approvalId } = useParams<{ approvalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const copy = useLocalizedCopy();
  const locale = useCurrentLocale();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [commentBody, setCommentBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showRawPayload, setShowRawPayload] = useState(false);

  const { data: approval, isLoading } = useQuery({
    queryKey: queryKeys.approvals.detail(approvalId!),
    queryFn: () => approvalsApi.get(approvalId!),
    enabled: !!approvalId,
  });
  const resolvedCompanyId = approval?.companyId ?? selectedCompanyId;

  const { data: comments } = useQuery({
    queryKey: queryKeys.approvals.comments(approvalId!),
    queryFn: () => approvalsApi.listComments(approvalId!),
    enabled: !!approvalId,
  });

  const { data: linkedIssues } = useQuery({
    queryKey: queryKeys.approvals.issues(approvalId!),
    queryFn: () => approvalsApi.listIssues(approvalId!),
    enabled: !!approvalId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId ?? ""),
    queryFn: () => agentsApi.list(resolvedCompanyId ?? ""),
    enabled: !!resolvedCompanyId,
  });

  useEffect(() => {
    if (!approval?.companyId || approval.companyId === selectedCompanyId) return;
    setSelectedCompanyId(approval.companyId, { source: "route_sync" });
  }, [approval?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([
      { label: copy("approvals.breadcrumb", "Approvals", "승인"), href: "/approvals" },
      { label: approval?.id?.slice(0, 8) ?? approvalId ?? copy("approvalDetail.breadcrumb", "Approval", "승인 상세") },
    ]);
  }, [copy, setBreadcrumbs, approval, approvalId]);

  const refresh = () => {
    if (!approvalId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.comments(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.issues(approvalId) });
    if (approval?.companyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(approval.companyId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(approval.companyId, "pending"),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(approval.companyId) });
    }
  };

  const approveMutation = useMutation({
    mutationFn: () => approvalsApi.approve(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
      navigate(`/approvals/${approvalId}?resolved=approved`, { replace: true });
    },
    onError: (err) => setError(err instanceof Error ? err.message : copy("approvalDetail.error.approve", "Approve failed", "승인에 실패했습니다.")),
  });

  const rejectMutation = useMutation({
    mutationFn: () => approvalsApi.reject(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : copy("approvalDetail.error.reject", "Reject failed", "반려에 실패했습니다.")),
  });

  const revisionMutation = useMutation({
    mutationFn: () => approvalsApi.requestRevision(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : copy("approvalDetail.error.revision", "Revision request failed", "수정 요청에 실패했습니다.")),
  });

  const resubmitMutation = useMutation({
    mutationFn: () => approvalsApi.resubmit(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : copy("approvalDetail.error.resubmit", "Resubmit failed", "재제출 표시를 실패했습니다.")),
  });

  const addCommentMutation = useMutation({
    mutationFn: () => approvalsApi.addComment(approvalId!, commentBody.trim()),
    onSuccess: () => {
      setCommentBody("");
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : copy("approvalDetail.error.comment", "Comment failed", "댓글 작성에 실패했습니다.")),
  });

  const deleteAgentMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.remove(agentId),
    onSuccess: () => {
      setError(null);
      refresh();
      navigate("/approvals");
    },
    onError: (err) => setError(err instanceof Error ? err.message : copy("approvalDetail.error.delete", "Delete failed", "삭제에 실패했습니다.")),
  });

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!approval) return <p className="text-sm text-muted-foreground">{copy("approvalDetail.notFound", "Approval not found.", "승인 요청을 찾을 수 없습니다.")}</p>;

  const payload = approval.payload as Record<string, unknown>;
  const linkedAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const isBudgetApproval = approval.type === "budget_override_required";
  const TypeIcon = typeIcon[approval.type] ?? defaultTypeIcon;
  const approvalTypeLabels: Record<string, string> = {
    hire_agent: copy("approval.type.hireAgent", "Hire Agent", "직원 고용"),
    approve_ceo_strategy: copy("approval.type.ceoStrategy", "CEO Strategy", "CEO 전략"),
    budget_override_required: copy("approval.type.budgetOverride", "Budget Override", "예산 초과 승인"),
    request_board_approval: copy("approval.type.boardApproval", "Board Approval", "보드 승인"),
  };
  const approvalTitleBase = approvalTypeLabels[approval.type] ?? approval.type;
  const approvalTitleSubject = approvalSubject(payload);
  const approvalTitle = approvalTitleSubject ? `${approvalTitleBase}: ${approvalTitleSubject}` : approvalTitleBase;
  const showApprovedBanner = searchParams.get("resolved") === "approved" && approval.status === "approved";
  const primaryLinkedIssue = linkedIssues?.[0] ?? null;
  const resolvedCta =
    primaryLinkedIssue
      ? {
          label:
            (linkedIssues?.length ?? 0) > 1
              ? copy("approvalDetail.cta.reviewLinkedIssues", "Review linked issues", "연결 작업 검토")
              : copy("approvalDetail.cta.reviewLinkedIssue", "Review linked issue", "연결 작업 검토"),
          to: `/issues/${primaryLinkedIssue.identifier ?? primaryLinkedIssue.id}`,
        }
      : linkedAgentId
        ? {
            label: copy("approvalDetail.cta.openHiredAgent", "Open hired agent", "고용된 직원 열기"),
            to: `/agents/${linkedAgentId}`,
          }
        : {
            label: copy("approvalDetail.cta.back", "Back to approvals", "승인 목록으로"),
            to: "/approvals",
          };

  return (
    <div className="space-y-6 max-w-3xl">
      {showApprovedBanner && (
        <div className="border border-green-300 dark:border-green-700/40 bg-green-50 dark:bg-green-900/20 rounded-lg px-4 py-3 animate-in fade-in zoom-in-95 duration-300">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <div className="relative mt-0.5">
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-300" />
                <Sparkles className="h-3 w-3 text-green-500 dark:text-green-200 absolute -right-2 -top-1 animate-pulse" />
              </div>
              <div>
                <p className="text-sm text-green-800 dark:text-green-100 font-medium">
                  {copy("approvalDetail.approvedBanner.title", "Approval confirmed", "승인이 완료되었습니다.")}
                </p>
                <p className="text-xs text-green-700 dark:text-green-200/90">
                  {copy(
                    "approvalDetail.approvedBanner.body",
                    "Requesting agent was notified to review this approval and linked issues.",
                    "요청한 직원에게 이 승인과 연결 작업을 확인하라고 알렸습니다.",
                  )}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="border-green-400 dark:border-green-600/50 text-green-800 dark:text-green-100 hover:bg-green-100 dark:hover:bg-green-900/30"
              onClick={() => navigate(resolvedCta.to)}
            >
              {resolvedCta.label}
            </Button>
          </div>
        </div>
      )}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TypeIcon className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <h2 className="text-lg font-semibold">{approvalTitle}</h2>
              <p className="text-xs text-muted-foreground font-mono">{approval.id}</p>
            </div>
          </div>
          <StatusBadge status={approval.status} />
        </div>
        <div className="text-sm space-y-1">
          {approval.requestedByAgentId && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">{copy("approvalDetail.requestedBy", "Requested by", "요청자")}</span>
              <Identity
                name={agentNameById.get(approval.requestedByAgentId) ?? approval.requestedByAgentId.slice(0, 8)}
                size="sm"
              />
            </div>
          )}
          <ApprovalPayloadRenderer type={approval.type} payload={payload} />
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-2"
            onClick={() => setShowRawPayload((v) => !v)}
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${showRawPayload ? "rotate-90" : ""}`} />
            {copy("approvalDetail.rawRequest", "See full request", "전체 요청 보기")}
          </button>
          {showRawPayload && (
            <pre className="text-xs bg-muted/40 rounded-md p-3 overflow-x-auto">
              {JSON.stringify(payload, null, 2)}
            </pre>
          )}
          {approval.decisionNote && (
            <p className="text-xs text-muted-foreground">
              {copy("approvalDetail.decisionNote", "Decision note: {{note}}", "결정 메모: {{note}}", { note: approval.decisionNote })}
            </p>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {linkedIssues && linkedIssues.length > 0 && (
          <div className="pt-2 border-t border-border/60">
            <p className="text-xs text-muted-foreground mb-1.5">{copy("approvalDetail.linkedIssues", "Linked Issues", "연결 작업")}</p>
            <div className="space-y-1.5">
              {linkedIssues.map((issue) => (
                <Link
                  key={issue.id}
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  className="block text-xs rounded border border-border/70 px-2 py-1.5 hover:bg-accent/20"
                >
                  <span className="font-mono text-muted-foreground mr-2">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                  <span>{issue.title}</span>
                </Link>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              {copy(
                "approvalDetail.linkedIssues.note",
                "Linked issues remain open until the requesting agent follows up and closes them.",
                "연결 작업은 요청한 직원이 후속 처리하고 닫을 때까지 열린 상태로 남습니다.",
              )}
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {isActionable && !isBudgetApproval && (
            <>
              <Button
                size="sm"
                className="bg-green-700 hover:bg-green-600 text-white"
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending}
              >
                {copy("approvalDetail.action.approve", "Approve", "승인")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => rejectMutation.mutate()}
                disabled={rejectMutation.isPending}
              >
                {copy("approvalDetail.action.reject", "Reject", "반려")}
              </Button>
            </>
          )}
          {isBudgetApproval && approval.status === "pending" && (
            <p className="text-sm text-muted-foreground">
              {copy("approvalDetail.budgetStop.prefix", "Resolve this budget stop from the budget controls on", "이 예산 중지는")}
              {" "}
              <Link to="/costs" className="underline underline-offset-2">/costs</Link>
              {" "}
              {copy("approvalDetail.budgetStop.suffix", ".", "예산 관리에서 해제하세요.")}
            </p>
          )}
          {approval.status === "pending" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => revisionMutation.mutate()}
              disabled={revisionMutation.isPending}
            >
              {copy("approvalDetail.action.requestRevision", "Request revision", "수정 요청")}
            </Button>
          )}
          {approval.status === "revision_requested" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => resubmitMutation.mutate()}
              disabled={resubmitMutation.isPending}
            >
              {copy("approvalDetail.action.markResubmitted", "Mark resubmitted", "재제출 표시")}
            </Button>
          )}
          {approval.status === "rejected" && approval.type === "hire_agent" && linkedAgentId && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive border-destructive/40"
              onClick={() => {
                if (!window.confirm(copy(
                  "approvalDetail.confirmDeleteAgent",
                  "Delete this disapproved agent? This cannot be undone.",
                  "반려된 이 직원을 삭제할까요? 이 작업은 되돌릴 수 없습니다.",
                ))) return;
                deleteAgentMutation.mutate(linkedAgentId);
              }}
              disabled={deleteAgentMutation.isPending}
            >
              {copy("approvalDetail.action.deleteAgent", "Delete disapproved agent", "반려된 직원 삭제")}
            </Button>
          )}
        </div>
      </div>

      <div className="border border-border rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-medium">
          {copy("approvalDetail.comments.title", "Comments ({{count}})", "댓글 {{count}}개", { count: comments?.length ?? 0 })}
        </h3>
        <div className="space-y-2">
          {(comments ?? []).map((comment: ApprovalComment) => (
            <div key={comment.id} className="border border-border/60 rounded-md p-3">
              <div className="flex items-center justify-between mb-1">
                {comment.authorAgentId ? (
                  <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
                    <Identity
                      name={agentNameById.get(comment.authorAgentId) ?? comment.authorAgentId.slice(0, 8)}
                      size="sm"
                    />
                  </Link>
                ) : (
                  <Identity name={copy("approvalDetail.board", "Board", "보드")} size="sm" />
                )}
                <span className="text-xs text-muted-foreground">
                  {new Date(comment.createdAt).toLocaleString(locale)}
                </span>
              </div>
              <MarkdownBody className="text-sm">{comment.body}</MarkdownBody>
            </div>
          ))}
        </div>
        <Textarea
          value={commentBody}
          onChange={(e) => setCommentBody(e.target.value)}
          placeholder={copy("approvalDetail.comment.placeholder", "Add a comment...", "댓글 추가...")}
          rows={3}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => addCommentMutation.mutate()}
            disabled={!commentBody.trim() || addCommentMutation.isPending}
          >
            {addCommentMutation.isPending
              ? copy("approvalDetail.comment.posting", "Posting…", "게시 중...")
              : copy("approvalDetail.comment.post", "Post comment", "댓글 게시")}
          </Button>
        </div>
      </div>
    </div>
  );
}
