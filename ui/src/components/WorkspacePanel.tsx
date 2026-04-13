/**
 * Workspace Panel — right-side intelligence surface for agent teams.
 *
 * Three tabs:
 *   Changes — git status, stage/unstage, commit, diff
 *   Runs    — live and recent agent runs in this workspace
 *   Activity — recent workspace events (commits, comments, approvals)
 *
 * Persistent when a workspace is selected. Collapsible via close button.
 */

import { useState, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  GitBranch,
  Plus,
  Minus,
  RefreshCw,
  X,
  ChevronRight,
  FileText,
  FilePlus,
  FileX,
  FilePen,
  HelpCircle,
  ArrowLeft,
  Play,
  Clock,
  History,
} from "lucide-react";
import { useWorkspace } from "../context/WorkspaceContext";
import { useCompany } from "../context/CompanyContext";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { activityApi } from "../api/activity";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import type { ActivityEvent } from "@paperclipai/shared";

type PanelTab = "changes" | "runs" | "activity";

// ═══════════════════════════════════════════════════════════════════
// WorkspacePanel — main container with tab bar
// ═══════════════════════════════════════════════════════════════════

export function WorkspacePanel({ onClose }: { onClose: () => void }) {
  const { selected, branch } = useWorkspace();
  const [activeTab, setActiveTab] = useState<PanelTab>("changes");

  if (!selected) {
    return (
      <aside className="w-[360px] border-l border-border bg-background flex flex-col shrink-0">
        <PanelHeader branch={null} onClose={onClose} />
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Select a workspace
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-[360px] border-l border-border bg-background flex flex-col min-h-0 shrink-0">
      <PanelHeader branch={branch} onClose={onClose} />
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
      <div className="flex-1 overflow-auto min-h-0">
        {activeTab === "changes" && <ChangesTab />}
        {activeTab === "runs" && <RunsTab />}
        {activeTab === "activity" && <ActivityTab />}
      </div>
    </aside>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Header + Tab bar
// ═══════════════════════════════════════════════════════════════════

function PanelHeader({ branch, onClose }: { branch: string | null; onClose: () => void }) {
  return (
    <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
      <span className="text-xs font-semibold text-foreground">Workspace</span>
      {branch && (
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/60 text-muted-foreground/70 truncate max-w-[180px]">
          {branch}
        </span>
      )}
      <button onClick={onClose} className="ml-auto p-1 text-muted-foreground/50 hover:text-foreground rounded">
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function TabBar({ activeTab, onTabChange }: { activeTab: PanelTab; onTabChange: (tab: PanelTab) => void }) {
  const tabs: { id: PanelTab; label: string; icon: typeof GitBranch }[] = [
    { id: "changes", label: "Changes", icon: GitBranch },
    { id: "runs", label: "Runs", icon: Play },
    { id: "activity", label: "Activity", icon: History },
  ];

  return (
    <div className="flex border-b border-border shrink-0">
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onTabChange(id)}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-medium transition-colors",
            activeTab === id
              ? "text-foreground border-b-2 border-foreground"
              : "text-muted-foreground/50 hover:text-muted-foreground",
          )}
        >
          <Icon className="h-3 w-3" />
          {label}
        </button>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Changes Tab — git operations
// ═══════════════════════════════════════════════════════════════════

function ChangesTab() {
  const { selected } = useWorkspace();
  const workspaceId = selected?.workspace.id ?? "";
  const queryClient = useQueryClient();

  const [commitMessage, setCommitMessage] = useState("");
  const [stagedExpanded, setStagedExpanded] = useState(true);
  const [unstagedExpanded, setUnstagedExpanded] = useState(true);
  const [selectedFile, setSelectedFile] = useState<{ path: string; staged: boolean } | null>(null);

  const { data: status, isLoading, refetch } = useQuery({
    queryKey: queryKeys.git.status(workspaceId),
    queryFn: () => projectsApi.getWorkspaceGitStatus(workspaceId),
    enabled: !!workspaceId,
    refetchInterval: 5000,
  });

  const { data: diffData, isLoading: diffLoading } = useQuery({
    queryKey: queryKeys.git.diff(workspaceId, selectedFile?.path ?? "", selectedFile?.staged ?? false),
    queryFn: () => projectsApi.getWorkspaceGitDiff(workspaceId, selectedFile!.path, selectedFile!.staged),
    enabled: !!workspaceId && !!selectedFile,
  });

  const invalidateGit = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.git.status(workspaceId) });
    queryClient.invalidateQueries({ queryKey: ["workspace-git-info", workspaceId] });
  }, [queryClient, workspaceId]);

  const stageMutation = useMutation({
    mutationFn: (paths: string[]) => projectsApi.stageFiles(workspaceId, paths),
    onSuccess: invalidateGit,
  });
  const unstageMutation = useMutation({
    mutationFn: (paths: string[]) => projectsApi.unstageFiles(workspaceId, paths),
    onSuccess: invalidateGit,
  });
  const commitMutation = useMutation({
    mutationFn: (message: string) => projectsApi.commitChanges(workspaceId, message),
    onSuccess: () => { invalidateGit(); setCommitMessage(""); },
  });

  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];

  // Diff sub-view
  if (selectedFile) {
    return (
      <div className="flex flex-col min-h-0 h-full">
        <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
          <button onClick={() => setSelectedFile(null)} className="p-0.5 text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <div className="flex-1 min-w-0">
            <span className="text-xs font-medium truncate block">{fileName(selectedFile.path)}</span>
            <span className="text-[10px] text-muted-foreground/50">{selectedFile.staged ? "Staged" : "Unstaged"}</span>
          </div>
        </div>
        <div className="flex-1 overflow-auto min-h-0">
          {diffLoading ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">Loading diff...</div>
          ) : (
            <DiffViewer diff={diffData?.diff ?? ""} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Commit form */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Commit message..."
          className="w-full text-xs bg-transparent border border-border rounded px-2 py-1.5 resize-none focus:outline-none focus:border-foreground/30 text-foreground placeholder:text-muted-foreground/40"
          rows={2}
        />
        <button
          onClick={() => commitMutation.mutate(commitMessage)}
          disabled={!commitMessage.trim() || staged.length === 0 || commitMutation.isPending}
          className="mt-1.5 w-full text-xs font-medium py-1.5 rounded bg-foreground text-background hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
        >
          {commitMutation.isPending ? "Committing..." : `Commit${staged.length > 0 ? ` (${staged.length})` : ""}`}
        </button>
        {commitMutation.isError && (
          <div className="mt-1 text-[10px] text-red-400">{(commitMutation.error as Error)?.message ?? "Commit failed"}</div>
        )}
      </div>

      {/* File lists */}
      <div className="flex-1 overflow-auto min-h-0">
        {isLoading ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">Loading...</div>
        ) : staged.length === 0 && unstaged.length === 0 ? (
          <div className="px-3 py-10 text-center">
            <p className="text-xs text-muted-foreground">No changes</p>
            <p className="text-[10px] text-muted-foreground/40 mt-1">Working tree is clean</p>
          </div>
        ) : (
          <>
            <SectionHeader
              label="Staged" count={staged.length} expanded={stagedExpanded}
              onToggle={() => setStagedExpanded(!stagedExpanded)}
              action={{ label: "Unstage all", onClick: () => unstageMutation.mutate(staged.map((f) => f.path)) }}
            />
            {stagedExpanded && staged.map((f) => (
              <GitFileItem key={`s:${f.path}`} path={f.path} status={f.status} staged
                onToggle={() => unstageMutation.mutate([f.path])}
                onSelect={() => setSelectedFile({ path: f.path, staged: true })}
                selected={selectedFile?.path === f.path && selectedFile?.staged === true}
              />
            ))}
            <SectionHeader
              label="Unstaged" count={unstaged.length} expanded={unstagedExpanded}
              onToggle={() => setUnstagedExpanded(!unstagedExpanded)}
              action={{ label: "Stage all", onClick: () => stageMutation.mutate(unstaged.map((f) => f.path)) }}
            />
            {unstagedExpanded && unstaged.map((f) => (
              <GitFileItem key={`u:${f.path}`} path={f.path} status={f.status} staged={false}
                onToggle={() => stageMutation.mutate([f.path])}
                onSelect={() => setSelectedFile({ path: f.path, staged: false })}
                selected={selectedFile?.path === f.path && selectedFile?.staged === false}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Runs Tab — live and recent agent runs
// ═══════════════════════════════════════════════════════════════════

function RunsTab() {
  const { selectedCompanyId } = useCompany();

  const { data: liveRuns, isLoading } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId ?? ""),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });

  const { data: recentRuns } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId ?? ""),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, undefined, 20),
    enabled: !!selectedCompanyId,
  });

  if (isLoading) {
    return <div className="px-3 py-6 text-center text-xs text-muted-foreground">Loading...</div>;
  }

  const live = liveRuns ?? [];
  const recent = (recentRuns ?? []).filter((r) => r.status !== "running").slice(0, 10);

  return (
    <div className="flex flex-col gap-0.5">
      {/* Live runs */}
      {live.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
            Live ({live.length})
          </div>
          {live.map((run) => (
            <RunItem key={run.id} id={run.id} agentName={run.agentName} status="running" startedAt={run.startedAt} source={run.invocationSource} />
          ))}
        </>
      )}

      {/* Recent completed */}
      {recent.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60 mt-1">
            Recent
          </div>
          {recent.map((run) => (
            <RunItem key={run.id} id={run.id} agentName={(run as any).agentName ?? "Agent"} status={run.status} startedAt={run.startedAt as string | null} source={run.invocationSource} />
          ))}
        </>
      )}

      {live.length === 0 && recent.length === 0 && (
        <div className="px-3 py-10 text-center">
          <p className="text-xs text-muted-foreground">No runs</p>
          <p className="text-[10px] text-muted-foreground/40 mt-1">Agent runs will appear here</p>
        </div>
      )}
    </div>
  );
}

function RunItem({ id, agentName, status, startedAt, source }: {
  id: string; agentName: string; status: string; startedAt: string | null; source: string;
}) {
  const isLive = status === "running";
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50 transition-colors">
      {isLive ? (
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
        </span>
      ) : (
        <span className={cn("h-2 w-2 rounded-full shrink-0", status === "completed" ? "bg-green-500" : status === "failed" ? "bg-red-500" : "bg-muted-foreground/30")} />
      )}
      <div className="flex-1 min-w-0">
        <span className="text-[12px] font-medium text-foreground block truncate">{agentName}</span>
        <span className="text-[10px] text-muted-foreground/50">{source}{startedAt ? ` · ${timeAgo(startedAt)}` : ""}</span>
      </div>
      {isLive && <span className="text-[10px] text-blue-500 font-medium shrink-0">Live</span>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Activity Tab — recent workspace events
// ═══════════════════════════════════════════════════════════════════

function ActivityTab() {
  const { selectedCompanyId } = useCompany();

  const { data: events, isLoading } = useQuery({
    queryKey: ["workspace-activity", selectedCompanyId],
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (isLoading) {
    return <div className="px-3 py-6 text-center text-xs text-muted-foreground">Loading...</div>;
  }

  const recent = (events ?? []).slice(0, 30);

  if (recent.length === 0) {
    return (
      <div className="px-3 py-10 text-center">
        <p className="text-xs text-muted-foreground">No activity</p>
        <p className="text-[10px] text-muted-foreground/40 mt-1">Agent and workspace events will appear here</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {recent.map((event) => (
        <ActivityItem key={event.id} event={event} />
      ))}
    </div>
  );
}

function ActivityItem({ event }: { event: ActivityEvent }) {
  const action = event.action.replace(/\./g, " · ");
  return (
    <div className="flex items-start gap-2 px-3 py-2 border-b border-border/50 hover:bg-accent/30 transition-colors">
      <Clock className="h-3 w-3 text-muted-foreground/40 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-[11px] text-foreground block">{action}</span>
        <span className="text-[10px] text-muted-foreground/50">
          {event.actorType === "agent" ? "Agent" : "User"}
          {" · "}
          {timeAgo(event.createdAt as string)}
        </span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function fileName(path: string) {
  return path.split("/").pop() ?? path;
}

function dirName(path: string) {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") + "/" : "";
}

// ── Git sub-components ─────────────────────────────────────────────

function statusIcon(status: string) {
  switch (status) {
    case "M": return <FilePen className="h-3.5 w-3.5 text-yellow-500" />;
    case "A": return <FilePlus className="h-3.5 w-3.5 text-green-500" />;
    case "D": return <FileX className="h-3.5 w-3.5 text-red-500" />;
    case "R": return <FileText className="h-3.5 w-3.5 text-blue-500" />;
    case "?": return <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/50" />;
    default: return <FileText className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function DiffViewer({ diff }: { diff: string }) {
  if (!diff) return <div className="px-3 py-6 text-center text-xs text-muted-foreground">No changes</div>;
  return (
    <pre className="text-[11px] leading-[1.6] font-mono overflow-auto">
      {diff.split("\n").map((line, i) => {
        let cls = "px-3 ";
        if (line.startsWith("+++") || line.startsWith("---")) cls += "text-muted-foreground/60";
        else if (line.startsWith("+")) cls += "bg-green-500/10 text-green-400";
        else if (line.startsWith("-")) cls += "bg-red-500/10 text-red-400";
        else if (line.startsWith("@@")) cls += "text-blue-400/70 bg-blue-500/5";
        else if (line.startsWith("diff ")) cls += "text-muted-foreground/40 font-semibold";
        else cls += "text-foreground/70";
        return <div key={i} className={cls}>{line || " "}</div>;
      })}
    </pre>
  );
}

function GitFileItem({ path: filePath, status, staged, onToggle, onSelect, selected }: {
  path: string; status: string; staged: boolean; onToggle: () => void; onSelect: () => void; selected: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-1.5 px-2 py-1 rounded-sm cursor-pointer group transition-colors", selected ? "bg-accent" : "hover:bg-accent/50")} onClick={onSelect}>
      {statusIcon(status)}
      <div className="flex-1 min-w-0 flex items-baseline gap-1">
        <span className="text-[12px] font-medium text-foreground truncate">{fileName(filePath)}</span>
        <span className="text-[10px] text-muted-foreground/40 truncate">{dirName(filePath)}</span>
      </div>
      <button onClick={(e) => { e.stopPropagation(); onToggle(); }} className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-accent transition-opacity text-muted-foreground hover:text-foreground" title={staged ? "Unstage" : "Stage"}>
        {staged ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
      </button>
    </div>
  );
}

function SectionHeader({ label, count, expanded, onToggle, action }: {
  label: string; count: number; expanded: boolean; onToggle: () => void; action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5">
      <button onClick={onToggle} className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60 bg-transparent border-none cursor-pointer p-0">
        <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
        {label}
      </button>
      <span className="text-[10px] text-muted-foreground/40">{count}</span>
      {action && count > 0 && (
        <button onClick={action.onClick} className="ml-auto text-[10px] text-muted-foreground/50 hover:text-foreground bg-transparent border-none cursor-pointer p-0">
          {action.label}
        </button>
      )}
    </div>
  );
}
