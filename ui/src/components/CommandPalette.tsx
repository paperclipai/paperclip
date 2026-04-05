import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { Modal, Button } from "@heroui/react";
import {
  CircleDot,
  Bot,
  Hexagon,
  Target,
  LayoutDashboard,
  Inbox,
  DollarSign,
  History,
  SquarePen,
  Plus,
  Search,
} from "lucide-react";
import { Identity } from "./Identity";
import { agentUrl, projectUrl } from "../lib/utils";
import { cn } from "../lib/utils";

/* ── Types ── */

interface CommandItem {
  id: string;
  group: string;
  label: string;
  sublabel?: string;
  hint?: string;
  icon: React.ReactNode;
  trailing?: React.ReactNode;
  onSelect: () => void;
}

/* ── Sub-components ── */

interface CommandGroupProps {
  heading: string;
  items: CommandItem[];
  activeIndex: number;
  globalOffset: number;
  onSelect: (item: CommandItem) => void;
  onHover: (index: number) => void;
}

function CommandGroup({ heading, items, activeIndex, globalOffset, onSelect, onHover }: CommandGroupProps) {
  return (
    <div>
      <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {heading}
      </div>
      {items.map((item, localIdx) => {
        const globalIdx = globalOffset + localIdx;
        const isActive = activeIndex === globalIdx;
        return (
          <button
            key={item.id}
            type="button"
            data-command-item
            data-index={globalIdx}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
              isActive ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-accent/50",
            )}
            onClick={() => onSelect(item)}
            onMouseEnter={() => onHover(globalIdx)}
          >
            <span className="shrink-0 text-muted-foreground">{item.icon}</span>
            <span className="flex-1 truncate">{item.label}</span>
            {item.sublabel && (
              <span className="text-xs text-muted-foreground font-mono shrink-0">{item.sublabel}</span>
            )}
            {item.trailing}
            {item.hint && (
              <span className="ml-auto text-xs text-muted-foreground shrink-0">{item.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── Main component ── */

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { openNewIssue, openNewAgent } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const searchQuery = query.trim();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
        if (isMobile) setSidebarOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, setSidebarOpen]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
    } else {
      // focus input after modal opens
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const { data: issues = [] } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });

  const { data: searchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.search(selectedCompanyId!, searchQuery),
    queryFn: () => issuesApi.list(selectedCompanyId!, { q: searchQuery }),
    enabled: !!selectedCompanyId && open && searchQuery.length > 0,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });

  const { data: allProjects = [] } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });

  const projects = useMemo(() => allProjects.filter((p) => !p.archivedAt), [allProjects]);

  function go(path: string) {
    setOpen(false);
    navigate(path);
  }

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  const visibleIssues = useMemo(
    () => (searchQuery.length > 0 ? searchedIssues : issues),
    [issues, searchedIssues, searchQuery],
  );

  // Build flat item list for keyboard navigation
  const allGroups = useMemo(() => {
    const lq = query.toLowerCase();
    const groups: { heading: string; items: CommandItem[] }[] = [];

    const actionItems: CommandItem[] = [
      {
        id: "action-new-issue",
        group: "Actions",
        label: "Create new issue",
        hint: "C",
        icon: <SquarePen className="h-4 w-4" />,
        onSelect: () => { setOpen(false); openNewIssue(); },
      },
      {
        id: "action-new-agent",
        group: "Actions",
        label: "Create new agent",
        icon: <Plus className="h-4 w-4" />,
        onSelect: () => { setOpen(false); openNewAgent(); },
      },
      {
        id: "action-new-project",
        group: "Actions",
        label: "Create new project",
        icon: <Plus className="h-4 w-4" />,
        onSelect: () => go("/projects"),
      },
    ].filter((item) => !lq || item.label.toLowerCase().includes(lq));

    if (actionItems.length > 0) groups.push({ heading: "Actions", items: actionItems });

    const pageItems: CommandItem[] = [
      { id: "page-dashboard", group: "Pages", label: "Dashboard", icon: <LayoutDashboard className="h-4 w-4" />, onSelect: () => go("/dashboard") },
      { id: "page-inbox", group: "Pages", label: "Inbox", icon: <Inbox className="h-4 w-4" />, onSelect: () => go("/inbox") },
      { id: "page-issues", group: "Pages", label: "Issues", icon: <CircleDot className="h-4 w-4" />, onSelect: () => go("/issues") },
      { id: "page-projects", group: "Pages", label: "Projects", icon: <Hexagon className="h-4 w-4" />, onSelect: () => go("/projects") },
      { id: "page-goals", group: "Pages", label: "Goals", icon: <Target className="h-4 w-4" />, onSelect: () => go("/goals") },
      { id: "page-agents", group: "Pages", label: "Agents", icon: <Bot className="h-4 w-4" />, onSelect: () => go("/agents") },
      { id: "page-costs", group: "Pages", label: "Costs", icon: <DollarSign className="h-4 w-4" />, onSelect: () => go("/costs") },
      { id: "page-activity", group: "Pages", label: "Activity", icon: <History className="h-4 w-4" />, onSelect: () => go("/activity") },
    ].filter((item) => !lq || item.label.toLowerCase().includes(lq));

    if (pageItems.length > 0) groups.push({ heading: "Pages", items: pageItems });

    const issueItems: CommandItem[] = visibleIssues.slice(0, 10)
      .filter((issue) => !lq || issue.title.toLowerCase().includes(lq) || (issue.identifier ?? "").toLowerCase().includes(lq))
      .map((issue) => {
        const name = agentName(issue.assigneeAgentId ?? null);
        return {
          id: `issue-${issue.id}`,
          group: "Issues",
          label: issue.title,
          sublabel: issue.identifier ?? issue.id.slice(0, 8),
          icon: <CircleDot className="h-4 w-4" />,
          trailing: name ? <Identity name={name} size="sm" className="ml-2 hidden sm:inline-flex" /> : undefined,
          onSelect: () => go(`/issues/${issue.identifier ?? issue.id}`),
        };
      });

    if (issueItems.length > 0) groups.push({ heading: "Issues", items: issueItems });

    const agentItems: CommandItem[] = agents.slice(0, 10)
      .filter((agent) => !lq || agent.name.toLowerCase().includes(lq))
      .map((agent) => ({
        id: `agent-${agent.id}`,
        group: "Agents",
        label: agent.name,
        sublabel: agent.role,
        icon: <Bot className="h-4 w-4" />,
        onSelect: () => go(agentUrl(agent)),
      }));

    if (agentItems.length > 0) groups.push({ heading: "Agents", items: agentItems });

    const projectItems: CommandItem[] = projects.slice(0, 10)
      .filter((project) => !lq || project.name.toLowerCase().includes(lq))
      .map((project) => ({
        id: `project-${project.id}`,
        group: "Projects",
        label: project.name,
        icon: <Hexagon className="h-4 w-4" />,
        onSelect: () => go(projectUrl(project)),
      }));

    if (projectItems.length > 0) groups.push({ heading: "Projects", items: projectItems });

    return groups;
  }, [query, visibleIssues, agents, projects, openNewIssue, openNewAgent]);

  const flatItems = useMemo(() => allGroups.flatMap((g) => g.items), [allGroups]);

  // Reset active index when items change
  useEffect(() => {
    setActiveIndex(0);
  }, [flatItems.length]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      flatItems[activeIndex]?.onSelect();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const activeEl = list.querySelector(`[data-index="${activeIndex}"]`) as HTMLElement | null;
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Group offsets for rendering
  const groupOffsets = useMemo(() => {
    const offsets: number[] = [];
    let offset = 0;
    for (const group of allGroups) {
      offsets.push(offset);
      offset += group.items.length;
    }
    return offsets;
  }, [allGroups]);

  return (
    <>
      <Modal.Backdrop
        isOpen={open}
        onOpenChange={(v: boolean) => {
          setOpen(v);
          if (v && isMobile) setSidebarOpen(false);
        }}
      >
        <Modal.Container placement="top" size="lg" className="mt-[10vh]">
          <Modal.Dialog>
            <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
              {/* Search input */}
              <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Search issues, agents, projects..."
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                {query && (
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setQuery("")}
                  >
                    <span className="text-xs">Clear</span>
                  </button>
                )}
              </div>

              {/* Results list */}
              <div
                ref={listRef}
                className="max-h-[min(480px,60vh)] overflow-y-auto overscroll-contain p-1.5"
              >
                {flatItems.length === 0 ? (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    No results found.
                  </div>
                ) : (
                  allGroups.map((group, groupIdx) => (
                    <div key={group.heading}>
                      {groupIdx > 0 && <div className="my-1 border-t border-border" />}
                      <CommandGroup
                        heading={group.heading}
                        items={group.items}
                        activeIndex={activeIndex}
                        globalOffset={groupOffsets[groupIdx]!}
                        onSelect={(item) => item.onSelect()}
                        onHover={(idx) => setActiveIndex(idx)}
                      />
                    </div>
                  ))
                )}
              </div>

              {/* Footer hint */}
              <div className="border-t border-border px-3 py-1.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                <span><kbd className="font-mono">↑↓</kbd> navigate</span>
                <span><kbd className="font-mono">↵</kbd> select</span>
                <span><kbd className="font-mono">esc</kbd> close</span>
              </div>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
