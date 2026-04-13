/**
 * Sidebar — workspace-first layout with tabs.
 *
 * "Workspaces" tab: project → workspace tree (Lucitra addition)
 * "More" tab: original Paperclip nav (Chat, Terminal, Dashboard, Projects, Agents, etc.)
 *
 * Inbox is pinned above the tabs so approval notifications are always visible.
 *
 * The "More" tab preserves the original Paperclip sidebar content so upstream
 * changes merge cleanly. Keep modifications inside the WorkspacesTab and
 * the tab wrapper; avoid touching PaperclipNav internals.
 */

import {
  Inbox,
  CircleDot,
  Target,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Boxes,
  Repeat,
  Settings,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  TerminalSquare,
  FolderOpen,
  Plus,
  ListTodo,
} from "lucide-react";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useNavigate } from "@/lib/router";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useWorkspace } from "../context/WorkspaceContext";
import { heartbeatsApi } from "../api/heartbeats";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";
import type { Project } from "@paperclipai/shared";

type SidebarTab = "workspaces" | "more";

export function Sidebar() {
  const [activeTab, setActiveTab] = useState<SidebarTab>("workspaces");
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { openNewIssue, openNewProject } = useDialog();
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Inbox — always visible for approval notifications */}
      <div className="px-3 shrink-0 pt-1">
        <SidebarNavItem
          to="/inbox"
          label="Inbox"
          icon={Inbox}
          badge={inboxBadge.inbox}
          badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
          alert={inboxBadge.failedRuns > 0}
        />
      </div>

      {/* Tab bar: Workspaces | More */}
      <div className="flex items-center border-b border-border shrink-0">
        <button
          onClick={() => setActiveTab("workspaces")}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-[13px] font-medium transition-colors",
            activeTab === "workspaces"
              ? "text-foreground border-b-2 border-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          Workspaces
        </button>
        <button
          onClick={() => setActiveTab("more")}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-[13px] font-medium transition-colors",
            activeTab === "more"
              ? "text-foreground border-b-2 border-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <ListTodo className="h-3.5 w-3.5" />
          More
        </button>
      </div>

      {activeTab === "workspaces" ? (
        <WorkspacesTab openNewProject={openNewProject} />
      ) : (
        /* ── Original Paperclip sidebar content (upstream-safe) ── */
        <PaperclipNav
          openNewIssue={openNewIssue}
          pluginContext={pluginContext}
          liveRunCount={liveRunCount}
          inboxBadge={inboxBadge}
        />
      )}
    </aside>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Workspaces Tab — Lucitra addition
   ═══════════════════════════════════════════════════════════════════ */

function WorkspacesTab({
  openNewProject,
}: {
  openNewProject: () => void;
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* + New Workspace */}
      <div className="px-3 py-2 shrink-0">
        <button
          onClick={openNewProject}
          className="flex items-center gap-2 w-full px-2 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded-md transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Workspace
          <span className="ml-auto text-[11px] text-muted-foreground/60 font-mono">⌘N</span>
        </button>
      </div>

      {/* Project / Workspace tree */}
      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide px-2 py-1">
        <ProjectWorkspaceTree />
      </nav>

      {/* Add repository — bottom */}
      <div className="px-3 py-2 border-t border-border shrink-0">
        <button
          onClick={openNewProject}
          className="flex items-center gap-2 w-full px-2 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded-md transition-colors"
        >
          <FolderOpen className="h-4 w-4" />
          Add repository
        </button>
      </div>
    </div>
  );
}

function ProjectWorkspaceTree() {
  const { selectedCompanyId } = useCompany();
  const { workspaces, selected, selectWorkspace } = useWorkspace();
  const { isMobile, setSidebarOpen } = useSidebar();
  const navigate = useNavigate();

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const projectTree = useMemo(() => {
    if (!projects) return [];
    return projects
      .filter((p) => !p.archivedAt && p.status !== "cancelled")
      .map((project) => ({
        project,
        workspaces: workspaces.filter((w) => w.project.id === project.id),
      }));
  }, [projects, workspaces]);

  return (
    <div className="flex flex-col gap-1">
      {projectTree.map(({ project, workspaces: projectWorkspaces }) => (
        <ProjectTreeNode
          key={project.id}
          project={project}
          workspaces={projectWorkspaces}
          selectedWorkspaceId={selected?.workspace.id ?? null}
          onSelectWorkspace={(wsId) => {
            selectWorkspace(wsId);
            navigate("/workspace");
            if (isMobile) setSidebarOpen(false);
          }}
        />
      ))}

      {projectTree.length === 0 && (
        <div className="px-3 py-6 text-center">
          <p className="text-xs text-muted-foreground">No projects yet.</p>
          <p className="text-[10px] text-muted-foreground/60 mt-1">
            Add a repository to get started.
          </p>
        </div>
      )}
    </div>
  );
}

function ProjectTreeNode({
  project,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
}: {
  project: Project;
  workspaces: Array<{ workspace: { id: string; name: string; repoRef?: string | null }; cwd: string }>;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const workspaceCount = workspaces.length;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md hover:bg-accent/50 transition-colors group"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 text-muted-foreground/60 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span
          className="shrink-0 h-4 w-4 rounded-sm flex items-center justify-center text-[10px] font-bold text-white"
          style={{ backgroundColor: project.color ?? "#6366f1" }}
        >
          {project.name.charAt(0).toUpperCase()}
        </span>
        <span className="flex-1 text-[13px] font-medium text-foreground truncate text-left">
          {project.name}
        </span>
        {workspaceCount > 0 && (
          <span className="text-[11px] text-muted-foreground/60 shrink-0">
            ({workspaceCount})
          </span>
        )}
      </button>

      {expanded && (
        <div className="ml-3 pl-2 border-l border-border/50">
          {workspaces.map((entry) => {
            const isSelected = entry.workspace.id === selectedWorkspaceId;
            return (
              <button
                key={entry.workspace.id}
                onClick={() => onSelectWorkspace(entry.workspace.id)}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 rounded-md transition-colors text-left",
                  isSelected
                    ? "bg-accent text-foreground"
                    : "hover:bg-accent/50 text-foreground/80",
                )}
              >
                <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium block truncate">
                    {entry.workspace.name}
                  </span>
                  {entry.workspace.repoRef && (
                    <span className="text-[10px] text-muted-foreground font-mono block truncate">
                      {entry.workspace.repoRef}
                    </span>
                  )}
                </div>
              </button>
            );
          })}

          {workspaces.length === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground/60">
              No workspaces
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PaperclipNav — Original Paperclip sidebar content (upstream-safe)

   This section mirrors the upstream Paperclip sidebar nav. Keep
   modifications minimal so upstream commits merge cleanly.
   ═══════════════════════════════════════════════════════════════════ */

function PaperclipNav({
  openNewIssue,
  pluginContext,
  liveRunCount,
  inboxBadge,
}: {
  openNewIssue: () => void;
  pluginContext: { companyId: string | null; companyPrefix: string | null };
  liveRunCount: number;
  inboxBadge: { inbox: number; failedRuns: number };
}) {
  const [moreOpen, setMoreOpen] = useState(false);

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  return (
    <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
      {/* Primary nav */}
      <div className="flex flex-col gap-0.5">
        <SidebarNavItem to="/plugins/paperclip-chat" label="Chat" icon={MessageSquare} />
        <SidebarNavItem to="/terminal" label="Terminal" icon={TerminalSquare} />
        <SidebarNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} liveCount={liveRunCount} />
        <SidebarNavItem
          to="/inbox"
          label="Inbox"
          icon={Inbox}
          badge={inboxBadge.inbox}
          badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
          alert={inboxBadge.failedRuns > 0}
        />
        <PluginSlotOutlet
          slotTypes={["sidebar"]}
          context={pluginContext}
          className="flex flex-col gap-0.5"
          itemClassName="text-[13px] font-medium"
          missingBehavior="placeholder"
        />
      </div>

      <SidebarProjects />

      <SidebarAgents />

      {/* Collapsible "More" for secondary items */}
      <div className="flex flex-col gap-0.5">
        <button
          onClick={() => setMoreOpen(!moreOpen)}
          className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors w-full"
        >
          <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${moreOpen ? "" : "-rotate-90"}`} />
          <span className="truncate">More</span>
        </button>
        {moreOpen && (
          <div className="flex flex-col gap-0.5 ml-1">
            <button
              onClick={() => openNewIssue()}
              className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
            >
              <SquarePen className="h-4 w-4 shrink-0" />
              <span className="truncate">New Issue</span>
            </button>
            <SidebarNavItem to="/issues" label="Issues" icon={CircleDot} />
            <SidebarNavItem to="/routines" label="Routines" icon={Repeat} textBadge="Beta" textBadgeTone="amber" />
            <SidebarNavItem to="/goals" label="Goals" icon={Target} />
            <SidebarNavItem to="/org" label="Org" icon={Network} />
            <SidebarNavItem to="/skills" label="Skills" icon={Boxes} />
            <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />
            <SidebarNavItem to="/activity" label="Activity" icon={History} />
            <SidebarNavItem to="/approvals" label="Approvals" icon={SquarePen} />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-0.5 mt-auto">
        <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
      </div>

      <PluginSlotOutlet
        slotTypes={["sidebarPanel"]}
        context={pluginContext}
        className="flex flex-col gap-3"
        itemClassName="rounded-lg border border-border p-3"
        missingBehavior="placeholder"
      />
    </nav>
  );
}
