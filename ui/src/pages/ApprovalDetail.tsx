import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { recordsApi } from "../api/records";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import { typeLabel, typeIcon, defaultTypeIcon, ApprovalPayloadRenderer } from "../components/ApprovalPayload";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, ChevronRight, Sparkles } from "lucide-react";
import type { ApprovalComment } from "@paperclipai/shared";
import { MarkdownBody } from "../components/MarkdownBody";

export function ApprovalDetail() {
  const { approvalId } = useParams<{ approvalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
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
      { label: "Approvals", href: "/approvals" },
      { label: approval?.id?.slice(0, 8) ?? approvalId ?? "Approval" },
    ]);
  }, [setBreadcrumbs, approval, approvalId]);

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
    onError: (err) => setError(err instanceof Error ? err.message : "Approve failed"),
  });

  const rejectMutation = useMutation({
    mutationFn: () => approvalsApi.reject(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Reject failed"),
  });

  const revisionMutation = useMutation({
    mutationFn: () => approvalsApi.requestRevision(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Revision request failed"),
  });

  const resubmitMutation = useMutation({
    mutationFn: () => approvalsApi.resubmit(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Resubmit failed"),
  });

  const addCommentMutation = useMutation({
    mutationFn: () => approvalsApi.addComment(approvalId!, commentBody.trim()),
    onSuccess: () => {
      setCommentBody("");
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Comment failed"),
  });

  const promoteToResultMutation = useMutation({
    mutationFn: () => {
      const companyId = approval?.companyId ?? resolvedCompanyId;
      if (!companyId || !approvalId) throw new Error("Approval context is not loaded");
      return recordsApi.promoteToResult(companyId, {
        sourceType: "approval",
        sourceId: approvalId,
        kind: "decision_outcome",
      });
    },
    onSuccess: async (record) => {
      if (approval?.companyId) {
        await queryClient.invalidateQueries({ queryKey: ["records", approval.companyId] });
      }
      navigate(`/briefings/records/${record.id}`);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Promotion failed"),
  });

  const deleteAgentMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.remove(agentId),
    onSuccess: () => {
      setError(null);
      refresh();
      navigate("/approvals");
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Delete failed"),
  });

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!approval) return <p className="text-sm text-muted-foreground">Approval not found.</p>;

  const payload = approval.payload as Record<string, unknown>;
  const linkedAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const TypeIcon = typeIcon[approval.type] ?? defaultTypeIcon;
  const showApprovedBanner = searchParams.get("resolved") === "approved" && approval.status === "approved";
  const primaryLinkedIssue = linkedIssues?.[0] ?? null;
  const resolvedCta =
    primaryLinkedIssue
      ? {
          label:
            (linkedIssues?.length ?? 0) > 1
              ? "Review linked issues"
              : "Review linked issue",
          to: `/issues/${primaryLinkedIssue.identifier ?? primaryLinkedIssue.id}`,
        }
      : linkedAgentId
        ? {
            label: "Open hired agent",
            to: `/agents/${linkedAgentId}`,
          }
      : {
          label: "Back to approvals",
          to: "/approvals",
        };
  const commentCount = comments?.length ?? 0;
  const linkedIssueCount = linkedIssues?.length ?? 0;

  return (
    <div className="max-w-4xl space-y-6">
      <section className="paperclip-gov-hero px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="space-y-3">
            <p className="paperclip-gov-kicker">Decision Surface</p>
            <div className="space-y-2">
              <h1 className="paperclip-gov-title">{typeLabel[approval.type] ?? approval.type.replace(/_/g, " ")}</h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Review the payload, linked issues, and discussion history before making a governance decision.
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="paperclip-gov-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-gov-label">Status</p>
              <p className="mt-2 text-sm font-semibold capitalize">{approval.status.replace(/_/g, " ")}</p>
            </div>
            <div className="paperclip-gov-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-gov-label">Linked</p>
              <p className="mt-2 text-2xl font-semibold">{linkedIssueCount}</p>
            </div>
            <div className="paperclip-gov-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-gov-label">Comments</p>
              <p className="mt-2 text-2xl font-semibold">{commentCount}</p>
            </div>
          </div>
        </div>
      </section>

      {showApprovedBanner && (
        <div className="paperclip-gov-card border-green-300 bg-green-50 px-4 py-3 animate-in fade-in zoom-in-95 duration-300 dark:border-green-700/40 dark:bg-green-900/20">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <div className="relative mt-0.5">
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-300" />
                <Sparkles className="h-3 w-3 text-green-500 dark:text-green-200 absolute -right-2 -top-1 animate-pulse" />
              </div>
              <div>
                <p className="text-sm text-green-800 dark:text-green-100 font-medium">Approval confirmed</p>
                <p className="text-xs text-green-700 dark:text-green-200/90">
                  Requesting agent was notified to review this approval and linked issues.
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
      <div className="paperclip-gov-card-strong p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="paperclip-gov-pill flex h-10 w-10 items-center justify-center">
              <TypeIcon className="h-5 w-5 text-primary shrink-0" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{typeLabel[approval.type] ?? approval.type.replace(/_/g, " ")}</h2>
              <p className="paperclip-gov-label mt-1">{approval.id}</p>
            </div>
          </div>
          <StatusBadge status={approval.status} />
        </div>
        <div className="text-sm space-y-1">
          {approval.requestedByAgentId && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Requested by</span>
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
            See full request
          </button>
          {showRawPayload && (
            <pre className="text-xs bg-muted/40 rounded-md p-3 overflow-x-auto">
              {JSON.stringify(payload, null, 2)}
            </pre>
          )}
          {approval.decisionNote && (
            <p className="text-xs text-muted-foreground">Decision note: {approval.decisionNote}</p>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {linkedIssues && linkedIssues.length > 0 && (
          <div className="pt-2 border-t border-border/60">
            <p className="paperclip-gov-label mb-2">Linked Issues</p>
            <div className="paperclip-gov-list">
              {linkedIssues.map((issue) => (
                <Link
                  key={issue.id}
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  className="paperclip-gov-row block border-b border-border/60 px-3 py-2 text-xs last:border-b-0 hover:bg-accent/20"
                >
                  <span className="font-mono text-muted-foreground mr-2">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                  <span>{issue.title}</span>
                </Link>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              Linked issues remain open until the requesting agent follows up and closes them.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => promoteToResultMutation.mutate()}
            disabled={promoteToResultMutation.isPending}
          >
            {promoteToResultMutation.isPending ? "Promoting..." : "Promote to result"}
          </Button>
          {isActionable && (
            <>
              <Button
                size="sm"
                className="bg-green-700 hover:bg-green-600 text-white"
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending}
              >
                Approve
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => rejectMutation.mutate()}
                disabled={rejectMutation.isPending}
              >
                Reject
              </Button>
            </>
          )}
          {approval.status === "pending" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => revisionMutation.mutate()}
              disabled={revisionMutation.isPending}
            >
              Request revision
            </Button>
          )}
          {approval.status === "revision_requested" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => resubmitMutation.mutate()}
              disabled={resubmitMutation.isPending}
            >
              Mark resubmitted
            </Button>
          )}
          {approval.status === "rejected" && approval.type === "hire_agent" && linkedAgentId && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive border-destructive/40"
              onClick={() => {
                if (!window.confirm("Delete this disapproved agent? This cannot be undone.")) return;
                deleteAgentMutation.mutate(linkedAgentId);
              }}
              disabled={deleteAgentMutation.isPending}
            >
              Delete disapproved agent
            </Button>
          )}
        </div>
      </div>

      <div className="paperclip-gov-card p-5 space-y-3">
        <h3 className="text-sm font-medium">Comments ({commentCount})</h3>
        <div className="space-y-2">
          {(comments ?? []).map((comment: ApprovalComment) => (
            <div key={comment.id} className="paperclip-gov-card p-3">
              <div className="flex items-center justify-between mb-1">
                {comment.authorAgentId ? (
                  <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
                    <Identity
                      name={agentNameById.get(comment.authorAgentId) ?? comment.authorAgentId.slice(0, 8)}
                      size="sm"
                    />
                  </Link>
                ) : (
                  <Identity name="Board" size="sm" />
                )}
                <span className="text-xs text-muted-foreground">
                  {new Date(comment.createdAt).toLocaleString()}
                </span>
              </div>
              <MarkdownBody className="text-sm">{comment.body}</MarkdownBody>
            </div>
          ))}
        </div>
        <Textarea
          value={commentBody}
          onChange={(e) => setCommentBody(e.target.value)}
          placeholder="Add a comment..."
          rows={3}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => addCommentMutation.mutate()}
            disabled={!commentBody.trim() || addCommentMutation.isPending}
          >
            {addCommentMutation.isPending ? "Posting…" : "Post comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}
