import { useState } from "react";
import { useParams, useNavigate } from "react-router";
import { ArrowLeft, MessageSquare, Activity, FileText, ThumbsUp, ThumbsDown } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { issuesApi } from "@/api/issues";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { feedbackApi } from "@/api/feedback";
import { tauriInvoke } from "@/api/tauri-client";

const STATUS_STYLES: Record<string, { bg: string; fg: string; label: string }> = {
  in_progress: { bg: "var(--accent-subtle)", fg: "var(--accent)", label: "In Progress" },
  todo: { bg: "var(--bg-muted)", fg: "var(--fg-secondary)", label: "Todo" },
  done: { bg: "var(--success-subtle)", fg: "var(--success)", label: "Done" },
  in_review: { bg: "var(--warning-subtle)", fg: "var(--warning)", label: "In Review" },
  blocked: { bg: "var(--destructive-subtle)", fg: "var(--destructive)", label: "Blocked" },
  backlog: { bg: "var(--bg-muted)", fg: "var(--fg-muted)", label: "Backlog" },
  cancelled: { bg: "var(--bg-muted)", fg: "var(--fg-muted)", label: "Cancelled" },
};

const PRIORITY_STYLES: Record<string, { bg: string; fg: string; label: string }> = {
  critical: { bg: "var(--destructive-subtle)", fg: "var(--destructive)", label: "Critical" },
  high: { bg: "var(--warning-subtle)", fg: "var(--warning)", label: "High" },
  medium: { bg: "var(--accent-subtle)", fg: "var(--accent)", label: "Medium" },
  low: { bg: "var(--bg-muted)", fg: "var(--fg-muted)", label: "Low" },
  none: { bg: "var(--bg-muted)", fg: "var(--fg-muted)", label: "None" },
};

type Tab = "comments" | "activity" | "documents";

export function IssueDetail() {
  const { issueId } = useParams<{ issueId: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>("comments");
  const [newComment, setNewComment] = useState("");
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const { data: issue, isLoading } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId,
  });

  const { data: comments = [] } = useQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: () => issuesApi.listComments(issueId!),
    enabled: !!issueId,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects = [] } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const projectMap = new Map(projects.map((p) => [p.id, p]));

  const commentMutation = useMutation({
    mutationFn: (body: string) => issuesApi.createComment(issue!.company_id, issueId!, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
      setNewComment("");
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: { assignee_agent_id?: string; status?: string }) =>
      issuesApi.update(issueId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
  });

  const startWorkMutation = useMutation({
    mutationFn: () => tauriInvoke<string>("wake_agent", {
      id: issue!.assignee_agent_id,
      source: "issue_detail",
      reason: `Work on ${issue!.identifier}: ${issue!.title}`,
      payload: JSON.stringify({ issueId: issue!.id }),
    }),
    onSuccess: () => {
      if (issue!.status === "todo" || issue!.status === "backlog") {
        updateMutation.mutate({ status: "in_progress" });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
    },
  });

  if (isLoading || !issue) return <div className="p-8 text-center" style={{ color: "var(--fg-muted)" }}>Loading...</div>;

  const statusStyle = STATUS_STYLES[issue.status];
  const priorityStyle = PRIORITY_STYLES[issue.priority];
  const assignee = issue.assignee_agent_id ? agentMap.get(issue.assignee_agent_id) : null;
  const project = issue.project_id ? projectMap.get(issue.project_id) : null;

  return (
    <div className="max-w-3xl">
      <button onClick={() => navigate("/issues")} className="mb-4 flex items-center gap-1.5 text-[13px]" style={{ color: "var(--fg-muted)" }}>
        <ArrowLeft size={14} /> Back to Issues
      </button>

      {/* Header */}
      <div className="mb-6">
        <div className="mb-1 flex items-center gap-3">
          <span className="text-xs" style={{ fontFamily: "var(--font-mono)", color: "var(--fg-muted)" }}>{issue.identifier}</span>
          <span className="h-1 w-1 rounded-full" style={{ background: "var(--border)" }} />
          {statusStyle && (
            <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: statusStyle.bg, color: statusStyle.fg }}>
              {statusStyle.label}
            </span>
          )}
          {priorityStyle && (
            <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: priorityStyle.bg, color: priorityStyle.fg }}>
              {priorityStyle.label}
            </span>
          )}
        </div>
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>{issue.title}</h1>
        {issue.description && (
          <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--fg-secondary)" }}>{issue.description}</p>
        )}

        {issue.assignee_agent_id && !["done", "cancelled"].includes(issue.status) ? (
          <button
            onClick={() => startWorkMutation.mutate()}
            disabled={startWorkMutation.isPending}
            className="mt-3 rounded-md px-4 py-2 text-[13px] font-medium disabled:opacity-50"
            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
          >
            {startWorkMutation.isPending ? "Starting..." : startWorkMutation.isSuccess ? "\u2713 Work Queued" : "\u25B6 Start Work"}
          </button>
        ) : !issue.assignee_agent_id ? (
          <p className="mt-3 text-[12px]" style={{ color: "var(--fg-muted)" }}>Assign an agent to start work on this issue</p>
        ) : null}
      </div>

      {/* Properties */}
      <div className="mb-6 grid grid-cols-4 gap-4 rounded-lg border p-4" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--fg-muted)" }}>Assignee</div>
          <select
            value={issue.assignee_agent_id || ""}
            onChange={(e) => updateMutation.mutate({ assignee_agent_id: e.target.value || undefined })}
            className="mt-1 w-full rounded-md border px-2 py-1 text-[13px] outline-none"
            style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
          >
            <option value="">Unassigned</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--fg-muted)" }}>Status</div>
          <select
            value={issue.status}
            onChange={(e) => updateMutation.mutate({ status: e.target.value })}
            className="mt-1 w-full rounded-md border px-2 py-1 text-[13px] outline-none"
            style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
          >
            <option value="backlog">Backlog</option>
            <option value="todo">Todo</option>
            <option value="in_progress">In Progress</option>
            <option value="in_review">In Review</option>
            <option value="done">Done</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--fg-muted)" }}>Created</div>
          <div className="mt-1 text-[13px]" style={{ color: "var(--fg-secondary)" }}>{new Date(issue.created_at).toLocaleDateString()}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--fg-muted)" }}>Project</div>
          <div className="mt-1 text-[13px]" style={{ color: "var(--fg-secondary)" }}>{project?.name ?? "\u2014"}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-0 border-b" style={{ borderColor: "var(--border)" }}>
        {([
          { key: "comments" as const, label: "Comments", icon: MessageSquare, count: comments.length },
          { key: "activity" as const, label: "Activity", icon: Activity },
          { key: "documents" as const, label: "Documents", icon: FileText },
        ]).map(({ key, label, icon: Icon, count }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className="relative flex items-center gap-2 px-4 py-2 pb-3 text-[13px]"
            style={{ color: activeTab === key ? "var(--fg)" : "var(--fg-muted)", fontWeight: activeTab === key ? 500 : 400, background: "none", border: "none", fontFamily: "var(--font-body)" }}
          >
            <Icon size={14} />
            {label}
            {count !== undefined && <span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>{count}</span>}
            {activeTab === key && <span className="absolute bottom-[-1px] left-0 right-0 h-[2px] rounded-t" style={{ background: "var(--accent)" }} />}
          </button>
        ))}
      </div>

      {/* Comments tab */}
      {activeTab === "comments" && (
        <div>
          <div className="flex flex-col gap-4">
            {comments.map((comment) => {
              const commentAgent = comment.author_agent_id ? agentMap.get(comment.author_agent_id) : null;
              const authorName = commentAgent?.name ?? "You";
              const isAgent = !!comment.author_agent_id;
              return (
                <div key={comment.id} className="rounded-lg border p-4" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
                  <div className="mb-2 flex items-center gap-2">
                    <div
                      className={cn("flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold")}
                      style={{
                        background: isAgent ? "var(--accent-subtle)" : "var(--bg-muted)",
                        color: isAgent ? "var(--accent)" : "var(--fg-muted)",
                      }}
                    >
                      {authorName[0]}
                    </div>
                    <span className="text-[13px] font-medium">{authorName}</span>
                    {isAgent && <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "var(--accent-subtle)", color: "var(--accent)" }}>Agent</span>}
                    <span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>{new Date(comment.created_at).toLocaleString()}</span>
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: "var(--fg-secondary)" }}>{comment.body}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => feedbackApi.vote(issue!.company_id, "issue_comment", comment.id, "up")}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-[var(--bg-muted)]"
                      style={{ color: "var(--fg-muted)" }}
                      title="Helpful"
                    >
                      <ThumbsUp size={12} />
                    </button>
                    <button
                      onClick={() => feedbackApi.vote(issue!.company_id, "issue_comment", comment.id, "down")}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-[var(--bg-muted)]"
                      style={{ color: "var(--fg-muted)" }}
                      title="Not helpful"
                    >
                      <ThumbsDown size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
            {comments.length === 0 && (
              <div className="py-8 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>No comments yet.</div>
            )}
          </div>

          {/* Comment input */}
          <div className="mt-4 rounded-lg border p-3" style={{ background: "var(--input-bg)", borderColor: "var(--input-border)" }}>
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Add a comment..."
              rows={3}
              className="w-full resize-none border-none bg-transparent text-sm outline-none"
              style={{ color: "var(--fg)", fontFamily: "var(--font-body)" }}
            />
            <div className="flex justify-end pt-2">
              <button
                onClick={() => commentMutation.mutate(newComment)}
                disabled={!newComment.trim() || commentMutation.isPending}
                className="rounded-md px-4 py-1.5 text-[13px] font-medium disabled:opacity-40"
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
              >
                Comment
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === "activity" && (
        <div className="py-12 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>Activity timeline coming soon.</div>
      )}
      {activeTab === "documents" && (
        <div className="py-12 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>No documents attached.</div>
      )}
    </div>
  );
}
