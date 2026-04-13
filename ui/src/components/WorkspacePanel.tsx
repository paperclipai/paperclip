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
  ChevronUp,
  ChevronDown,
  FileText,
  FilePlus,
  FileX,
  FilePen,
  HelpCircle,
  ArrowLeft,
  Play,
  Clock,
  History,
  TerminalSquare,
  Folder,
  FolderOpen,
  File,
  FileCode,
  FileJson,
  Image,
  GitPullRequest,
  CheckCircle2,
  XCircle,
  CircleDot,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { TerminalPanel } from "./Terminal";
import { useWorkspace } from "../context/WorkspaceContext";
import { useCompany } from "../context/CompanyContext";
import { projectsApi, type FileEntry, type CiCheck } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { activityApi } from "../api/activity";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import type { ActivityEvent } from "@paperclipai/shared";

type PanelTab = "changes" | "files" | "review" | "runs" | "activity";

// ═══════════════════════════════════════════════════════════════════
// WorkspacePanel — main container with tab bar
// ═══════════════════════════════════════════════════════════════════

export function WorkspacePanel({ onClose }: { onClose: () => void }) {
  const { selected, branch, cwd } = useWorkspace();
  const [activeTab, setActiveTab] = useState<PanelTab>("changes");
  const [terminalOpen, setTerminalOpen] = useState(false);

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

      {/* Top section: tab content */}
      <div className={cn("overflow-auto min-h-0", terminalOpen ? "flex-1 basis-1/2" : "flex-1")}>
        {activeTab === "changes" && <ChangesTab />}
        {activeTab === "files" && <FilesTab />}
        {activeTab === "review" && <ReviewTab />}
        {activeTab === "runs" && <RunsTab />}
        {activeTab === "activity" && <ActivityTab />}
      </div>

      {/* Bottom section: terminal (Conductor-style Setup|Run|Terminal tabs) */}
      <div className="border-t border-border shrink-0 flex items-center">
        <button
          onClick={() => setTerminalOpen(!terminalOpen)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-colors",
            terminalOpen ? "text-foreground" : "text-muted-foreground/50 hover:text-muted-foreground",
          )}
        >
          <TerminalSquare className="h-3 w-3" />
          Terminal
        </button>
        <div className="ml-auto pr-2">
          {terminalOpen && (
            <button
              onClick={() => setTerminalOpen(false)}
              className="p-0.5 text-muted-foreground/40 hover:text-foreground"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      {terminalOpen && cwd && (
        <div className="min-h-[200px] max-h-[40vh] flex-shrink-0" style={{ height: "35vh" }}>
          <TerminalPanel cwd={cwd} className="h-full" />
        </div>
      )}
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
    { id: "files", label: "Files", icon: Folder },
    { id: "review", label: "Review", icon: GitPullRequest },
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
// Files Tab — workspace file browser
// ═══════════════════════════════════════════════════════════════════

function FilesTab() {
  const { selected } = useWorkspace();
  const workspaceId = selected?.workspace.id ?? "";
  const [currentPath, setCurrentPath] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.files.list(workspaceId, currentPath),
    queryFn: () => projectsApi.listFiles(workspaceId, currentPath || undefined),
    enabled: !!workspaceId,
  });

  const files = data?.files ?? [];

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Path breadcrumb */}
      <div className="px-3 py-1.5 border-b border-border shrink-0 flex items-center gap-1 overflow-x-auto scrollbar-none">
        <button
          onClick={() => setCurrentPath("")}
          className={cn(
            "text-[10px] font-mono shrink-0 transition-colors",
            currentPath ? "text-blue-500 hover:text-blue-400" : "text-foreground font-medium",
          )}
        >
          root
        </button>
        {currentPath && currentPath.split("/").map((segment, i, arr) => {
          const pathUpTo = arr.slice(0, i + 1).join("/");
          const isLast = i === arr.length - 1;
          return (
            <span key={pathUpTo} className="flex items-center gap-1 shrink-0">
              <span className="text-[10px] text-muted-foreground/40">/</span>
              <button
                onClick={() => setCurrentPath(isLast ? pathUpTo : pathUpTo)}
                className={cn(
                  "text-[10px] font-mono transition-colors",
                  isLast ? "text-foreground font-medium" : "text-blue-500 hover:text-blue-400",
                )}
              >
                {segment}
              </button>
            </span>
          );
        })}
      </div>

      {/* File list */}
      <div className="flex-1 overflow-auto min-h-0">
        {isLoading ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">Loading...</div>
        ) : files.length === 0 ? (
          <div className="px-3 py-10 text-center">
            <p className="text-xs text-muted-foreground">Empty directory</p>
          </div>
        ) : (
          <>
            {currentPath && (
              <FileRow
                icon={<ArrowLeft className="h-3.5 w-3.5 text-muted-foreground/50" />}
                name=".."
                detail=""
                onClick={() => {
                  const parts = currentPath.split("/");
                  parts.pop();
                  setCurrentPath(parts.join("/"));
                }}
              />
            )}
            {files.map((entry) => (
              <FileRow
                key={entry.path}
                icon={fileIcon(entry)}
                name={entry.name}
                detail={entry.type === "file" && entry.size != null ? formatFileSize(entry.size) : ""}
                onClick={entry.type === "directory" ? () => setCurrentPath(entry.path) : undefined}
                isDir={entry.type === "directory"}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function FileRow({ icon, name, detail, onClick, isDir }: {
  icon: React.ReactNode;
  name: string;
  detail: string;
  onClick?: () => void;
  isDir?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 transition-colors",
        onClick ? "cursor-pointer hover:bg-accent/50" : "",
      )}
      onClick={onClick}
    >
      {icon}
      <span className={cn("text-[12px] flex-1 truncate", isDir ? "font-medium text-foreground" : "text-foreground/80")}>
        {name}
      </span>
      {detail && (
        <span className="text-[10px] text-muted-foreground/40 shrink-0">{detail}</span>
      )}
    </div>
  );
}

function fileIcon(entry: FileEntry): React.ReactNode {
  if (entry.type === "directory") return <FolderOpen className="h-3.5 w-3.5 text-blue-500/70" />;
  const ext = entry.name.split(".").pop()?.toLowerCase();
  if (["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "c", "cpp", "h"].includes(ext ?? ""))
    return <FileCode className="h-3.5 w-3.5 text-green-500/70" />;
  if (["json", "yaml", "yml", "toml"].includes(ext ?? ""))
    return <FileJson className="h-3.5 w-3.5 text-yellow-500/70" />;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext ?? ""))
    return <Image className="h-3.5 w-3.5 text-purple-500/70" />;
  return <File className="h-3.5 w-3.5 text-muted-foreground/50" />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ═══════════════════════════════════════════════════════════════════
// Review Tab — PR status + CI checks
// ═══════════════════════════════════════════════════════════════════

function ReviewTab() {
  const { selected, branch } = useWorkspace();
  const workspaceId = selected?.workspace.id ?? "";

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.pr.status(workspaceId),
    queryFn: () => projectsApi.getPrStatus(workspaceId),
    enabled: !!workspaceId,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  if (isLoading) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading PR status...
      </div>
    );
  }

  if (!data?.pr) {
    return (
      <div className="px-3 py-10 text-center">
        <GitPullRequest className="h-6 w-6 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">No open PR</p>
        <p className="text-[10px] text-muted-foreground/40 mt-1">
          {branch ? `Branch: ${branch}` : "No branch detected"}
        </p>
        {data?.error && (
          <p className="text-[10px] text-muted-foreground/40 mt-1">{data.error}</p>
        )}
      </div>
    );
  }

  const { pr, checks } = data;
  const passedChecks = checks.filter((c) => c.conclusion === "SUCCESS" || c.conclusion === "success").length;
  const failedChecks = checks.filter((c) => c.conclusion === "FAILURE" || c.conclusion === "failure").length;
  const pendingChecks = checks.filter((c) => !c.conclusion || c.conclusion === "NEUTRAL" || c.status === "IN_PROGRESS" || c.status === "QUEUED").length;

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* PR header */}
      <div className="px-3 py-3 border-b border-border shrink-0">
        <div className="flex items-start gap-2">
          <PrStateIcon state={pr.state} />
          <div className="flex-1 min-w-0">
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12px] font-medium text-foreground hover:text-blue-500 transition-colors flex items-center gap-1"
            >
              <span className="truncate">{pr.title}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/40" />
            </a>
            <div className="text-[10px] text-muted-foreground/50 mt-0.5">
              #{pr.number} · {pr.head} → {pr.base}
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-3 mt-2">
          <span className="text-[10px] text-green-500">+{pr.additions}</span>
          <span className="text-[10px] text-red-500">-{pr.deletions}</span>
          {pr.reviewDecision && (
            <ReviewBadge decision={pr.reviewDecision} />
          )}
        </div>
      </div>

      {/* Checks summary */}
      {checks.length > 0 && (
        <div className="px-3 py-1.5 border-b border-border shrink-0 flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
            Checks
          </span>
          <div className="flex items-center gap-2 ml-auto">
            {passedChecks > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-green-500">
                <CheckCircle2 className="h-3 w-3" /> {passedChecks}
              </span>
            )}
            {failedChecks > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-red-500">
                <XCircle className="h-3 w-3" /> {failedChecks}
              </span>
            )}
            {pendingChecks > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-yellow-500">
                <CircleDot className="h-3 w-3" /> {pendingChecks}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Check list */}
      <div className="flex-1 overflow-auto min-h-0">
        {checks.map((check, i) => (
          <CheckItem key={i} check={check} />
        ))}

        {/* PR body preview */}
        {pr.body && (
          <div className="px-3 py-2 border-t border-border">
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60 block mb-1">
              Description
            </span>
            <div className="text-[11px] text-foreground/70 whitespace-pre-wrap break-words line-clamp-[12]">
              {pr.body}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PrStateIcon({ state }: { state: string }) {
  if (state === "MERGED") return <GitPullRequest className="h-4 w-4 text-purple-500 shrink-0 mt-0.5" />;
  if (state === "CLOSED") return <GitPullRequest className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />;
  return <GitPullRequest className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />;
}

function ReviewBadge({ decision }: { decision: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    APPROVED: { label: "Approved", cls: "text-green-500 bg-green-500/10" },
    CHANGES_REQUESTED: { label: "Changes", cls: "text-orange-500 bg-orange-500/10" },
    REVIEW_REQUIRED: { label: "Review needed", cls: "text-yellow-500 bg-yellow-500/10" },
  };
  const info = map[decision] ?? { label: decision, cls: "text-muted-foreground bg-accent/50" };
  return (
    <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded", info.cls)}>
      {info.label}
    </span>
  );
}

function CheckItem({ check }: { check: CiCheck }) {
  const isSuccess = check.conclusion === "SUCCESS" || check.conclusion === "success";
  const isFailed = check.conclusion === "FAILURE" || check.conclusion === "failure";

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent/30 transition-colors">
      {isSuccess ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
      ) : isFailed ? (
        <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
      ) : (
        <CircleDot className="h-3.5 w-3.5 text-yellow-500 shrink-0" />
      )}
      <span className="text-[11px] text-foreground/80 flex-1 truncate">{check.name}</span>
      {check.url && (
        <a href={check.url} target="_blank" rel="noopener noreferrer" className="shrink-0 p-0.5 text-muted-foreground/40 hover:text-foreground">
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
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
