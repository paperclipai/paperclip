import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import {
  GitBranch, MoreHorizontal, RefreshCw, Trash2, ExternalLink,
  Play, Eye, CheckCircle2, ArrowLeft, Clipboard, RotateCcw, Zap,
} from "lucide-react";
import type { GitWorktreeEntry } from "../api/execution-workspaces";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { useToast } from "../context/ToastContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

const STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

type WorktreeDisplayStatus =
  | "active" | "idle" | "stale" | "in_review" | "archived" | "cleanup_failed"
  | "untracked"
  | "issue_backlog" | "issue_todo" | "issue_in_progress" | "issue_in_review"
  | "issue_done" | "issue_blocked" | "issue_cancelled";

function timeAgo(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const ISSUE_STATUS_MAP: Record<string, WorktreeDisplayStatus> = {
  backlog: "issue_backlog",
  todo: "issue_todo",
  in_progress: "issue_in_progress",
  in_review: "issue_in_review",
  done: "issue_done",
  blocked: "issue_blocked",
  cancelled: "issue_cancelled",
};

function getDisplayStatus(entry: GitWorktreeEntry): WorktreeDisplayStatus {
  const ws = entry.executionWorkspace;
  if (ws) {
    if (ws.status === "idle") {
      const lastUsed = ws.lastUsedAt ? new Date(ws.lastUsedAt).getTime() : 0;
      if (Date.now() - lastUsed > STALE_THRESHOLD_MS) return "stale";
    }
    return ws.status as WorktreeDisplayStatus;
  }
  if (entry.issue?.status) {
    return ISSUE_STATUS_MAP[entry.issue.status] ?? "issue_backlog";
  }
  return "untracked";
}

const STATUS_CONFIG: Record<WorktreeDisplayStatus, { label: string; className: string }> = {
  active:              { label: "Active",         className: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800" },
  idle:                { label: "Idle",           className: "bg-secondary text-secondary-foreground" },
  stale:               { label: "Stale",          className: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800" },
  in_review:           { label: "In Review",      className: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800" },
  archived:            { label: "Archived",       className: "text-muted-foreground border-border" },
  cleanup_failed:      { label: "Cleanup Failed", className: "bg-destructive/10 text-destructive border-destructive/20" },
  issue_backlog:       { label: "Backlog",        className: "bg-secondary text-secondary-foreground" },
  issue_todo:          { label: "Todo",           className: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800" },
  issue_in_progress:   { label: "In Progress",    className: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800" },
  issue_in_review:     { label: "In Review",      className: "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800" },
  issue_done:          { label: "Done",           className: "text-muted-foreground border-border" },
  issue_blocked:       { label: "Blocked",        className: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800" },
  issue_cancelled:     { label: "Cancelled",      className: "text-muted-foreground border-border" },
  untracked:           { label: "Untracked",      className: "bg-secondary text-secondary-foreground" },
};

function StatusBadge({ entry }: { entry: GitWorktreeEntry }) {
  const display = getDisplayStatus(entry);
  const config = STATUS_CONFIG[display];
  const tooltip = display === "untracked"
    ? "No matching issue found in this project"
    : undefined;
  return (
    <Badge
      variant="outline"
      className={cn("text-[11px] font-medium", config.className)}
      title={tooltip}
    >
      {config.label}
    </Badge>
  );
}

type ConfirmAction =
  | { type: "archive"; entry: GitWorktreeEntry }
  | { type: "retry"; entry: GitWorktreeEntry }
  | { type: "remove"; entry: GitWorktreeEntry }
  | { type: "prune"; count: number; ids: string[] };

interface WorktreesContentProps {
  companyId: string;
  projectId: string;
}

export function WorktreesContent({ companyId, projectId }: WorktreesContentProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [pendingAction, setPendingAction] = useState<ConfirmAction | null>(null);

  const { data: worktrees = [], isLoading } = useQuery({
    queryKey: ["git-worktrees", companyId, projectId],
    queryFn: () => executionWorkspacesApi.listGitWorktrees(companyId, projectId),
    refetchInterval: 30_000,
  });

  // Exclude the main worktree (primary checkout) from the list
  const branchWorktrees = worktrees.filter((w) => !w.isMainWorktree);
  const staleEntries = branchWorktrees.filter((w) => getDisplayStatus(w) === "stale" && w.executionWorkspace);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["git-worktrees", companyId, projectId] });
  };

  const archiveMutation = useMutation({
    mutationFn: (id: string) => executionWorkspacesApi.update(id, { status: "archived" }),
    onSuccess: (result) => {
      invalidate();
      if (result.status === "cleanup_failed") {
        pushToast({ title: "Archived but cleanup failed — check the worktree manually.", tone: "error" });
      } else {
        pushToast({ title: "Worktree archived and cleaned up.", tone: "success" });
      }
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to archive worktree";
      pushToast({ title: msg, tone: "error" });
    },
  });

  const pruneAllMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await executionWorkspacesApi.update(id, { status: "archived" });
    },
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Stale worktrees pruned.", tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Some worktrees could not be pruned.", tone: "error" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (path: string) => executionWorkspacesApi.removeGitWorktree(companyId, projectId, path),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Worktree removed.", tone: "success" });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to remove worktree";
      pushToast({ title: msg, tone: "error" });
    },
  });

  const issueStatusMutation = useMutation({
    mutationFn: ({ issueId, status, comment }: { issueId: string; status: string; comment?: string }) =>
      issuesApi.update(issueId, { status, ...(comment ? { comment } : {}) }),
    onSuccess: (_result, vars) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      const label = STATUS_LABELS[vars.status] ?? vars.status;
      pushToast({ title: `Issue moved to ${label}.`, tone: "success" });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to update issue";
      pushToast({ title: msg, tone: "error" });
    },
  });

  const handleIssueAction = (issueId: string, status: string, comment?: string) => {
    issueStatusMutation.mutate({ issueId, status, comment });
  };

  const triggerReviewMutation = useMutation({
    mutationFn: async (issueId: string) => {
      // 1. Fetch comments to find last @mention
      const comments = await issuesApi.listComments(issueId);
      if (!comments.length) throw new Error("No comments on this issue");

      // Walk backwards through comments to find the last @mention
      const agents = await agentsApi.list(companyId);
      const agentByName = new Map(agents.map((a) => [a.name.toLowerCase(), a]));

      for (let i = comments.length - 1; i >= 0; i--) {
        const body = comments[i]!.body;
        // Match @Name patterns (multi-word: @Engineering Manager, @QA Lead, etc.)
        const mentions = [...body.matchAll(/@([\w][\w\s]*[\w])/g)].map((m) => m[1]!.trim().toLowerCase());
        for (const mention of mentions) {
          const agent = agentByName.get(mention);
          if (agent) {
            await agentsApi.invoke(agent.id, companyId);
            return { agentName: agent.name };
          }
        }
      }

      // Fallback: if no @mention matched, invoke the assigned agent if present
      const assignedAgent = agents.find((a) =>
        comments.some((c) => c.authorAgentId === a.id),
      );
      if (assignedAgent) {
        await agentsApi.invoke(assignedAgent.id, companyId);
        return { agentName: assignedAgent.name };
      }

      throw new Error("No @mentioned agent found in comments");
    },
    onSuccess: (result) => {
      pushToast({ title: `Triggered ${result.agentName}'s heartbeat.`, tone: "success" });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to trigger review";
      pushToast({ title: msg, tone: "error" });
    },
  });

  const handleTriggerReview = (issueId: string) => {
    triggerReviewMutation.mutate(issueId);
  };

  const handleConfirm = () => {
    if (!pendingAction) return;
    if (pendingAction.type === "archive" && pendingAction.entry.executionWorkspace) {
      archiveMutation.mutate(pendingAction.entry.executionWorkspace.id);
    } else if (pendingAction.type === "retry" && pendingAction.entry.executionWorkspace) {
      archiveMutation.mutate(pendingAction.entry.executionWorkspace.id);
    } else if (pendingAction.type === "remove") {
      removeMutation.mutate(pendingAction.entry.path);
    } else if (pendingAction.type === "prune") {
      pruneAllMutation.mutate(pendingAction.ids);
    }
    setPendingAction(null);
  };

  const isMutating = archiveMutation.isPending || pruneAllMutation.isPending || removeMutation.isPending || issueStatusMutation.isPending || triggerReviewMutation.isPending;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
        Loading worktrees…
      </div>
    );
  }

  if (branchWorktrees.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
        <GitBranch className="h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm font-medium text-muted-foreground">No git worktrees</p>
        <p className="text-xs text-muted-foreground/70 max-w-xs">
          Worktrees are created automatically when agents check out issues in isolated branches.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {branchWorktrees.length} {branchWorktrees.length === 1 ? "worktree" : "worktrees"}
        </p>
        {staleEntries.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive border-destructive/30 hover:border-destructive/60 hover:bg-destructive/5"
            disabled={isMutating}
            onClick={() =>
              setPendingAction({
                type: "prune",
                count: staleEntries.length,
                ids: staleEntries.map((e) => e.executionWorkspace!.id),
              })
            }
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Prune {staleEntries.length} stale
          </Button>
        )}
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Branch / Path</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Issue</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Agent</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Status</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Last used</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {branchWorktrees.map((entry, idx) => (
              <WorktreeRow
                key={entry.path}
                entry={entry}
                isLast={idx === branchWorktrees.length - 1}
                isMutating={isMutating}
                onArchive={() => setPendingAction({ type: "archive", entry })}
                onRetryCleanup={() => setPendingAction({ type: "retry", entry })}
                onRemove={() => setPendingAction({ type: "remove", entry })}
                onIssueAction={handleIssueAction}
                onTriggerReview={handleTriggerReview}
              />
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={!!pendingAction} onOpenChange={(open) => { if (!open) setPendingAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingAction?.type === "archive" && "Archive worktree?"}
              {pendingAction?.type === "retry" && "Retry cleanup?"}
              {pendingAction?.type === "remove" && "Remove worktree?"}
              {pendingAction?.type === "prune" && `Prune ${pendingAction.count} stale worktree${pendingAction.count === 1 ? "" : "s"}?`}
            </DialogTitle>
            <DialogDescription>
              {pendingAction?.type === "archive" && (
                <>The worktree for <strong>{pendingAction.entry.branch ?? pendingAction.entry.path}</strong> will be archived and its directory removed from disk. This cannot be undone.</>
              )}
              {pendingAction?.type === "retry" && (
                <>Re-run cleanup for <strong>{pendingAction.entry.branch ?? pendingAction.entry.path}</strong>. The worktree directory will be removed from disk.</>
              )}
              {pendingAction?.type === "remove" && (
                <>The worktree at <strong>{pendingAction.entry.path}</strong> (branch: <strong>{pendingAction.entry.branch ?? "detached"}</strong>) will be permanently removed from disk. This cannot be undone.</>
              )}
              {pendingAction?.type === "prune" && (
                <>{pendingAction.count} idle {pendingAction.count === 1 ? "worktree" : "worktrees"} unused for over 7 days will be archived and removed from disk. This cannot be undone.</>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleConfirm}>
              {pendingAction?.type === "prune" ? "Prune all" : pendingAction?.type === "retry" ? "Retry cleanup" : pendingAction?.type === "remove" ? "Remove worktree" : "Archive & clean up"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WorktreeRow({
  entry,
  isLast,
  isMutating,
  onArchive,
  onRetryCleanup,
  onRemove,
  onIssueAction,
  onTriggerReview,
}: {
  entry: GitWorktreeEntry;
  isLast: boolean;
  isMutating: boolean;
  onArchive: () => void;
  onRetryCleanup: () => void;
  onRemove: () => void;
  onIssueAction: (issueId: string, status: string, comment?: string) => void;
  onTriggerReview: (issueId: string) => void;
}) {
  const ws = entry.executionWorkspace;
  const isArchived = ws?.status === "archived";
  const isCleanupFailed = ws?.status === "cleanup_failed";
  const pathBasename = entry.path.split("/").pop() ?? entry.path;
  const issueStatus = entry.issue?.status;

  const handleCopyPath = () => {
    navigator.clipboard.writeText(entry.path);
  };

  return (
    <tr className={cn("hover:bg-muted/30 transition-colors", !isLast && "border-b border-border")}>
      {/* Branch / path */}
      <td className="px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className={cn("font-mono text-[13px]", isArchived && "text-muted-foreground")}>
              {entry.branch ?? pathBasename}
            </span>
          </div>
          <span className="text-[11px] text-muted-foreground/60 truncate max-w-[260px]" title={entry.path}>
            {entry.path}
          </span>
          {ws?.cleanupReason && isCleanupFailed && (
            <span className="text-xs text-destructive truncate max-w-[260px]" title={ws.cleanupReason}>
              {ws.cleanupReason}
            </span>
          )}
        </div>
      </td>

      {/* Issue */}
      <td className="px-4 py-3">
        {entry.issue ? (
          <Link
            to={`/issues/${entry.issue.id}`}
            className="flex items-center gap-1 text-[13px] text-foreground/80 hover:text-foreground hover:underline max-w-[180px]"
          >
            {entry.issue.identifier && (
              <span className="shrink-0 text-xs text-muted-foreground font-mono">{entry.issue.identifier}</span>
            )}
            <span className="truncate">{entry.issue.title}</span>
            <ExternalLink className="h-3 w-3 shrink-0 opacity-50" />
          </Link>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </td>

      {/* Agent */}
      <td className="px-4 py-3">
        {entry.agent ? (
          <Link
            to={`/agents/${entry.agent.id}`}
            className="text-[13px] text-foreground/80 hover:text-foreground hover:underline"
          >
            {entry.agent.name}
          </Link>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </td>

      {/* Status */}
      <td className="px-4 py-3">
        <StatusBadge entry={entry} />
      </td>

      {/* Last used */}
      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
        {ws?.lastUsedAt ? timeAgo(new Date(ws.lastUsedAt)) : "—"}
      </td>

      {/* Actions */}
      <td className="px-2 py-3 text-right">
        {!isArchived && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={isMutating}>
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">Actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* Navigation links */}
              {entry.issue && (
                <DropdownMenuItem asChild>
                  <Link to={`/issues/${entry.issue.id}`} className="cursor-pointer">Open issue</Link>
                </DropdownMenuItem>
              )}
              {entry.agent && (
                <DropdownMenuItem asChild>
                  <Link to={`/agents/${entry.agent.id}`} className="cursor-pointer">Open agent</Link>
                </DropdownMenuItem>
              )}

              {/* Copy path */}
              <DropdownMenuItem onClick={handleCopyPath}>
                <Clipboard className="h-4 w-4 mr-2" />
                Copy path
              </DropdownMenuItem>

              {/* Status-based issue actions */}
              {entry.issue && issueStatus && (
                <>
                  <DropdownMenuSeparator />
                  {/* In Review → Mark Done or Request Changes */}
                  {issueStatus === "in_review" && (
                    <>
                      <DropdownMenuItem onClick={() => onTriggerReview(entry.issue!.id)}>
                        <Zap className="h-4 w-4 mr-2" />
                        Trigger review
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onIssueAction(entry.issue!.id, "done")}>
                        <CheckCircle2 className="h-4 w-4 mr-2" />
                        Mark done
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onIssueAction(entry.issue!.id, "in_progress", "Changes requested — returning to development.")}>
                        <ArrowLeft className="h-4 w-4 mr-2" />
                        Request changes
                      </DropdownMenuItem>
                    </>
                  )}
                  {/* In Progress → Move to Review */}
                  {issueStatus === "in_progress" && (
                    <DropdownMenuItem onClick={() => onIssueAction(entry.issue!.id, "in_review")}>
                      <Eye className="h-4 w-4 mr-2" />
                      Move to review
                    </DropdownMenuItem>
                  )}
                  {/* Todo / Backlog → Start Work */}
                  {(issueStatus === "todo" || issueStatus === "backlog") && (
                    <DropdownMenuItem onClick={() => onIssueAction(entry.issue!.id, "in_progress")}>
                      <Play className="h-4 w-4 mr-2" />
                      Start work
                    </DropdownMenuItem>
                  )}
                  {/* Blocked → Unblock */}
                  {issueStatus === "blocked" && (
                    <DropdownMenuItem onClick={() => onIssueAction(entry.issue!.id, "in_progress", "Unblocked — resuming work.")}>
                      <Play className="h-4 w-4 mr-2" />
                      Unblock
                    </DropdownMenuItem>
                  )}
                  {/* Done / Cancelled → Reopen */}
                  {(issueStatus === "done" || issueStatus === "cancelled") && (
                    <DropdownMenuItem onClick={() => onIssueAction(entry.issue!.id, "in_progress", "Reopened from worktrees view.")}>
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Reopen
                    </DropdownMenuItem>
                  )}
                </>
              )}

              {/* Destructive actions */}
              <DropdownMenuSeparator />
              {ws && isCleanupFailed ? (
                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onRetryCleanup}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Retry cleanup
                </DropdownMenuItem>
              ) : ws ? (
                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onArchive}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Archive & clean up
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onRemove}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Remove worktree
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </td>
    </tr>
  );
}
