/**
 * RaavaTaskDetail — Raava-branded Task detail page (Figma Screen 16).
 *
 * Rendered when `isRaava` is true, wrapping the existing IssueDetail view
 * with a Raava-styled two-column layout: main content (left 65%) and a
 * properties sidebar card (right 35%) with assigned-to, priority, project,
 * timestamps, cost, and action links.
 *
 * This component is rendered as a wrapper *around* the existing IssueDetail
 * logic — it reuses all the same API hooks and mutations, just re-skins
 * the chrome.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { usePanel } from "../context/PanelContext";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import {
  createIssueDetailPath,
  readIssueDetailBreadcrumb,
} from "../lib/issueDetailBreadcrumb";
import {
  mergeIssueComments,
  createOptimisticIssueComment,
  applyOptimisticIssueCommentUpdate,
  upsertIssueComment,
  type OptimisticIssueComment,
} from "../lib/optimistic-issue-comments";
import { assigneeValueFromSelection, suggestedCommentAssigneeValue } from "../lib/assignees";
import { relativeTime, cn, formatTokens, visibleRunCostUsd } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { formatDate } from "../lib/utils";
import { InlineEditor } from "../components/InlineEditor";
import { CommentThread } from "../components/CommentThread";
import { Identity } from "../components/Identity";
import { StatusBadge } from "../components/StatusBadge";
import { PriorityIcon } from "../components/PriorityIcon";
import { MarkdownBody } from "../components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { ChevronRight, Send, ArrowLeft } from "lucide-react";
import type { Agent, Issue, IssueComment } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RaavaTaskDetail() {
  const { issueId } = useParams<{ issueId: string }>();
  const { selectedCompanyId } = useCompany();
  const { closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToast();
  const [optimisticComments, setOptimisticComments] = useState<OptimisticIssueComment[]>([]);
  const [commentDraft, setCommentDraft] = useState("");

  // Close the default side panel — we render our own sidebar
  useEffect(() => {
    closePanel();
  }, [closePanel]);

  const { data: issue, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId,
  });
  const resolvedCompanyId = issue?.companyId ?? selectedCompanyId;

  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: () => issuesApi.listComments(issueId!),
    enabled: !!issueId,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.issues.activity(issueId!),
    queryFn: () => activityApi.forIssue(issueId!),
    enabled: !!issueId,
  });

  const { data: linkedRuns } = useQuery({
    queryKey: queryKeys.issues.runs(issueId!),
    queryFn: () => activityApi.runsForIssue(issueId!),
    enabled: !!issueId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId!),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(resolvedCompanyId!),
    queryFn: () => projectsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const sourceBreadcrumb = useMemo(
    () => readIssueDetailBreadcrumb(location.state, location.search) ?? { label: "Tasks", href: "/issues" },
    [location.state, location.search],
  );

  const threadComments = useMemo(
    () => mergeIssueComments(comments ?? [], optimisticComments),
    [comments, optimisticComments],
  );

  // Cost summary
  const costUsd = useMemo(() => {
    let cost = 0;
    for (const run of linkedRuns ?? []) {
      const usage = asRecord(run.usageJson);
      const result = asRecord(run.resultJson);
      cost += visibleRunCostUsd(usage, result);
    }
    return cost;
  }, [linkedRuns]);

  useEffect(() => {
    const titleLabel = issue?.title ?? issueId ?? "Task";
    setBreadcrumbs([sourceBreadcrumb, { label: titleLabel }]);
  }, [setBreadcrumbs, sourceBreadcrumb, issue, issueId]);

  // Redirect to identifier-based URL
  useEffect(() => {
    if (issue?.identifier && issueId !== issue.identifier) {
      navigate(createIssueDetailPath(issue.identifier, location.state, location.search), {
        replace: true,
        state: location.state,
      });
    }
  }, [issue, issueId, navigate, location.state, location.search]);

  // Mark as read
  const markIssueRead = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
  });
  useEffect(() => {
    if (issue?.id) markIssueRead.mutate(issue.id);
  }, [issue?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidateIssue = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId!) });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
    }
  };

  const updateIssue = useMutation({
    mutationFn: (data: Record<string, unknown>) => issuesApi.update(issueId!, data),
    onSuccess: () => invalidateIssue(),
    onError: (err) => {
      pushToast({
        title: "Update failed",
        body: err instanceof Error ? err.message : "Could not update this task.",
        tone: "error",
      });
    },
  });

  const addComment = useMutation({
    mutationFn: ({ body }: { body: string }) => issuesApi.addComment(issueId!, body),
    onMutate: async ({ body }) => {
      const optimistic = issue
        ? createOptimisticIssueComment({
            companyId: issue.companyId,
            issueId: issue.id,
            body,
            authorUserId: currentUserId,
            clientStatus: "pending",
            queueTargetRunId: null,
          })
        : null;
      if (optimistic) setOptimisticComments((c) => [...c, optimistic]);
      return { optimisticId: optimistic?.clientId ?? null };
    },
    onSuccess: (comment, _vars, ctx) => {
      if (ctx?.optimisticId) {
        setOptimisticComments((c) => c.filter((e) => e.clientId !== ctx.optimisticId));
      }
      queryClient.setQueryData<IssueComment[]>(
        queryKeys.issues.comments(issueId!),
        (current) => upsertIssueComment(current, comment),
      );
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.optimisticId) {
        setOptimisticComments((c) => c.filter((e) => e.clientId !== ctx.optimisticId));
      }
      pushToast({ title: "Comment failed", tone: "error" });
    },
    onSettled: () => invalidateIssue(),
  });

  const handleSendComment = () => {
    const body = commentDraft.trim();
    if (!body) return;
    addComment.mutate({ body }, {
      onSuccess: () => setCommentDraft(""),
    });
  };

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }
  if (error) {
    return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  }
  if (!issue) return null;

  const assigneeName = issue.assigneeAgentId
    ? agentMap.get(issue.assigneeAgentId)?.name ?? null
    : null;
  const projectName = issue.projectId
    ? (projects ?? []).find((p) => p.id === issue.projectId)?.name ?? null
    : null;
  const identifier = issue.identifier ?? issue.id.slice(0, 8);

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link
          to={sourceBreadcrumb.href ?? "/issues"}
          className="hover:text-foreground transition-colors"
        >
          Tasks
        </Link>
        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        <span className="text-foreground font-medium truncate">
          {identifier}: {issue.title}
        </span>
      </nav>

      {/* Two-column layout */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Left column — 65% */}
        <div className="flex-1 lg:max-w-[65%] space-y-5">
          {/* Title */}
          <InlineEditor
            value={issue.title}
            onSave={(title) => updateIssue.mutateAsync({ title })}
            as="h1"
            className="font-display text-2xl text-foreground"
          />

          {/* Status badge */}
          <div className="flex items-center gap-2">
            <StatusBadge status={issue.status} />
            <PriorityIcon priority={issue.priority} showLabel />
          </div>

          {/* Description */}
          {issue.description ? (
            <div className="prose prose-sm max-w-none text-foreground/90">
              <MarkdownBody>{issue.description}</MarkdownBody>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">No description provided.</p>
          )}

          {/* Activity stream / Comments */}
          <div className="space-y-4">
            <h3 className="text-[15px] font-semibold text-foreground">Activity</h3>
            {threadComments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No comments yet.</p>
            ) : (
              <div className="space-y-3">
                {threadComments.map((comment) => {
                  const authorAgent = comment.authorAgentId
                    ? agentMap.get(comment.authorAgentId)
                    : null;
                  const isCurrentUser = !!(currentUserId && comment.authorUserId === currentUserId);
                  const authorName = authorAgent?.name ?? (isCurrentUser ? "You" : comment.authorUserId ? "User" : "System");
                  return (
                    <div key={comment.id} className="raava-card bg-white dark:bg-card px-4 py-3">
                      <div className="flex items-center gap-2 mb-1.5">
                        <Identity name={authorName} size="sm" />
                        <span className="text-xs text-muted-foreground">
                          {timeAgo(comment.createdAt)}
                        </span>
                      </div>
                      <div className="text-sm text-foreground/90 whitespace-pre-wrap">
                        {comment.body}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Comment input */}
            <div className="flex gap-2">
              <input
                type="text"
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSendComment();
                  }
                }}
                placeholder="Add a comment..."
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <Button
                variant="gradient"
                size="sm"
                onClick={handleSendComment}
                disabled={!commentDraft.trim() || addComment.isPending}
              >
                <Send className="h-4 w-4 mr-1" />
                Send
              </Button>
            </div>
          </div>
        </div>

        {/* Right column — 35% sidebar */}
        <div className="lg:w-[35%] shrink-0">
          <div className="raava-card bg-white dark:bg-card px-5 py-5 space-y-5 sticky top-4">
            {/* Assigned to */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Assigned To
              </p>
              {assigneeName ? (
                <Identity name={assigneeName} size="default" />
              ) : (
                <span className="text-sm text-muted-foreground">Unassigned</span>
              )}
            </div>

            {/* Priority */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Priority
              </p>
              <PriorityIcon
                priority={issue.priority}
                onChange={(priority) => updateIssue.mutate({ priority })}
                showLabel
              />
            </div>

            {/* Project */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Project
              </p>
              {projectName && issue.projectId ? (
                <Link
                  to={`/projects/${issue.projectId}`}
                  className="text-sm text-foreground hover:text-[#224ae8] transition-colors no-underline"
                >
                  {projectName}
                </Link>
              ) : (
                <span className="text-sm text-muted-foreground">None</span>
              )}
            </div>

            {/* Timestamps */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Created
              </p>
              <p className="text-sm text-foreground">{formatDate(issue.createdAt)}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Updated
              </p>
              <p className="text-sm text-foreground">{timeAgo(issue.updatedAt)}</p>
            </div>

            {/* Cost */}
            {costUsd > 0 && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Cost
                </p>
                <p className="text-sm font-medium text-foreground">${costUsd.toFixed(2)}</p>
              </div>
            )}

            {/* Action links */}
            <div className="border-t border-border pt-4 space-y-2">
              <button
                type="button"
                className="block w-full text-left text-sm text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => {
                  // TODO: Open reassign dialog
                  pushToast({ title: "Reassign", body: "Coming soon", tone: "info" });
                }}
              >
                Reassign
              </button>
              <button
                type="button"
                className="block w-full text-left text-sm text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => {
                  const nextStatus = issue.status === "done" ? "todo" : "done";
                  updateIssue.mutate({ status: nextStatus });
                }}
              >
                {issue.status === "done" ? "Reopen" : "Mark Complete"}
              </button>
              <button
                type="button"
                className="block w-full text-left text-sm text-destructive/70 hover:text-destructive transition-colors"
                onClick={async () => {
                  try {
                    await updateIssue.mutateAsync({ hiddenAt: new Date().toISOString() });
                    navigate("/issues");
                  } catch {
                    // Error already surfaced via onError handler
                  }
                }}
              >
                Archive
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
