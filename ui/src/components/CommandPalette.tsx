import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
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
  BookOpen,
  FileText,
  Settings,
  Keyboard,
  BarChart3,
  Shield,
  Users,
  Layers,
  Bookmark,
  Search,
  Trash2,
} from "lucide-react";
import { Identity } from "./Identity";
import { agentUrl, projectUrl } from "../lib/utils";

/* ── Natural Language Search (12.37) ── */

interface NLMapping {
  patterns: RegExp[];
  url: string;
  label: string;
}

const NL_MAPPINGS: NLMapping[] = [
  { patterns: [/show\s*(me\s+)?all\s+failed\s+tasks/i, /failed\s+tasks/i, /failed\s+issues/i], url: "/issues?q=&status=blocked", label: "Show failed/blocked tasks" },
  { patterns: [/blocked\s+issues/i, /blocked\s+tasks/i, /what.*blocked/i], url: "/issues?q=&status=blocked", label: "Show blocked missions" },
  { patterns: [/overdue\s+issues/i, /overdue\s+tasks/i, /what.*overdue/i], url: "/issues?q=&status=in_progress", label: "Show in-progress missions (check for overdue)" },
  { patterns: [/active\s+(issues|tasks)/i, /in\s*progress/i, /what.*working\s+on/i], url: "/issues?q=&status=in_progress", label: "Show active missions" },
  { patterns: [/unassigned\s+(issues|tasks)/i, /no\s+assignee/i], url: "/issues?assignee=__unassigned", label: "Show unassigned missions" },
  { patterns: [/high\s*priority/i, /urgent\s+(issues|tasks)/i, /critical\s+(issues|tasks)/i], url: "/issues?q=&priority=critical,high", label: "Show high priority missions" },
  { patterns: [/backlog/i, /backlog\s+(issues|tasks)/i], url: "/issues?q=&status=backlog", label: "Show backlog" },
  { patterns: [/done\s+(issues|tasks)/i, /completed\s+(issues|tasks)/i, /finished/i], url: "/issues?q=&status=done", label: "Show completed missions" },
  { patterns: [/all\s+agents/i, /show\s*(me\s+)?agents/i, /who\s+works\s+here/i], url: "/agents", label: "Show all agents" },
  { patterns: [/paused\s+agents/i, /idle\s+agents/i], url: "/agents", label: "Show agents (filter for paused)" },
  { patterns: [/all\s+projects/i, /show\s*(me\s+)?projects/i], url: "/projects", label: "Show all projects" },
  { patterns: [/all\s+goals/i, /show\s*(me\s+)?goals/i, /objectives/i], url: "/goals", label: "Show all goals" },
  { patterns: [/costs?|spending|budget/i], url: "/costs", label: "Show costs" },
  { patterns: [/activity|what\s+happened/i, /recent\s+changes/i], url: "/activity", label: "Show recent activity" },
  { patterns: [/hiring|open\s+positions/i, /recruit/i], url: "/hiring", label: "Show hiring pipeline" },
  { patterns: [/org\s*chart|hierarchy|reporting/i], url: "/org", label: "Show org chart" },
];

function matchNaturalLanguage(query: string): NLMapping[] {
  if (query.length < 4) return [];
  return NL_MAPPINGS.filter((m) => m.patterns.some((p) => p.test(query)));
}

/* ── Saved Searches (12.37) ── */

interface SavedSearch {
  id: string;
  name: string;
  url: string;
}

const SAVED_SEARCHES_KEY = "ironworks:saved-searches";

function loadSavedSearches(): SavedSearch[] {
  try {
    const raw = localStorage.getItem(SAVED_SEARCHES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistSavedSearches(searches: SavedSearch[]) {
  try {
    localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(searches));
  } catch {
    /* ignore */
  }
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(loadSavedSearches);
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { openNewIssue, openNewAgent } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const searchQuery = query.trim();

  const nlMatches = useMemo(() => matchNaturalLanguage(searchQuery), [searchQuery]);

  const saveCurrentSearch = useCallback(() => {
    const currentUrl = window.location.pathname + window.location.search;
    const name = searchQuery || `Search: ${currentUrl}`;
    const id = `ss-${Date.now()}`;
    const updated = [...savedSearches, { id, name, url: currentUrl }];
    setSavedSearches(updated);
    persistSavedSearches(updated);
  }, [searchQuery, savedSearches]);

  const removeSavedSearch = useCallback(
    (id: string) => {
      const updated = savedSearches.filter((s) => s.id !== id);
      setSavedSearches(updated);
      persistSavedSearches(updated);
    },
    [savedSearches],
  );

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
    if (!open) setQuery("");
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

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v && isMobile) setSidebarOpen(false);
      }}
      data-tour="command-palette"
    >
      <CommandInput placeholder="Search missions, agents, projects..." value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Natural Language Suggestions (12.37) */}
        {nlMatches.length > 0 && (
          <>
            <CommandGroup heading="Smart Suggestions">
              {nlMatches.map((match) => (
                <CommandItem key={match.url} onSelect={() => go(match.url)}>
                  <Search className="mr-2 h-4 w-4 text-blue-500" />
                  {match.label}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {/* Saved Searches (12.37) */}
        {savedSearches.length > 0 && (
          <>
            <CommandGroup heading="Saved Searches">
              {savedSearches.map((ss) => (
                <CommandItem key={ss.id} value={`saved-search ${ss.name}`} onSelect={() => go(ss.url)}>
                  <Bookmark className="mr-2 h-4 w-4 text-amber-500" />
                  <span className="flex-1 truncate">{ss.name}</span>
                  <button
                    className="ml-2 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSavedSearch(ss.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() => {
              setOpen(false);
              openNewIssue();
            }}
          >
            <SquarePen className="mr-2 h-4 w-4" />
            Create new mission
            <span className="ml-auto text-xs text-muted-foreground">C</span>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false);
              openNewAgent();
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create new agent
          </CommandItem>
          <CommandItem onSelect={() => go("/projects")}>
            <Plus className="mr-2 h-4 w-4" />
            Create new project
          </CommandItem>
          <CommandItem
            onSelect={() => {
              saveCurrentSearch();
              setOpen(false);
            }}
          >
            <Bookmark className="mr-2 h-4 w-4" />
            Save current page as search
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Pages">
          <CommandItem onSelect={() => go("/dashboard")}>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Dashboard
            <span className="ml-auto text-xs text-muted-foreground">g d</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/inbox")}>
            <Inbox className="mr-2 h-4 w-4" />
            Inbox
            <span className="ml-auto text-xs text-muted-foreground">g n</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/issues")}>
            <CircleDot className="mr-2 h-4 w-4" />
            Missions
            <span className="ml-auto text-xs text-muted-foreground">g i</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/projects")}>
            <Hexagon className="mr-2 h-4 w-4" />
            Projects
            <span className="ml-auto text-xs text-muted-foreground">g p</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/goals")}>
            <Target className="mr-2 h-4 w-4" />
            Goals
            <span className="ml-auto text-xs text-muted-foreground">g o</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/agents")}>
            <Bot className="mr-2 h-4 w-4" />
            Agents
            <span className="ml-auto text-xs text-muted-foreground">g a</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/costs")}>
            <DollarSign className="mr-2 h-4 w-4" />
            Costs
            <span className="ml-auto text-xs text-muted-foreground">g c</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/activity")}>
            <History className="mr-2 h-4 w-4" />
            Activity
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="More Pages">
          <CommandItem onSelect={() => go("/playbooks")}>
            <FileText className="mr-2 h-4 w-4" />
            Playbooks
            <span className="ml-auto text-xs text-muted-foreground">g b</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/library")}>
            <BookOpen className="mr-2 h-4 w-4" />
            Library
            <span className="ml-auto text-xs text-muted-foreground">g l</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/performance")}>
            <BarChart3 className="mr-2 h-4 w-4" />
            Performance
          </CommandItem>
          <CommandItem onSelect={() => go("/audit-log")}>
            <Shield className="mr-2 h-4 w-4" />
            Audit Log
          </CommandItem>
          <CommandItem onSelect={() => go("/org")}>
            <Users className="mr-2 h-4 w-4" />
            Org Chart
          </CommandItem>
          <CommandItem onSelect={() => go("/company/settings")}>
            <Settings className="mr-2 h-4 w-4" />
            Company Settings
            <span className="ml-auto text-xs text-muted-foreground">g s</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/keyboard-shortcuts")}>
            <Keyboard className="mr-2 h-4 w-4" />
            Keyboard Shortcuts
            <span className="ml-auto text-xs text-muted-foreground">g k</span>
          </CommandItem>
        </CommandGroup>

        {visibleIssues.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Missions">
              {visibleIssues.slice(0, 10).map((issue) => (
                <CommandItem
                  key={issue.id}
                  value={searchQuery.length > 0 ? `${searchQuery} ${issue.identifier ?? ""} ${issue.title}` : undefined}
                  onSelect={() => go(`/issues/${issue.identifier ?? issue.id}`)}
                >
                  <CircleDot className="mr-2 h-4 w-4" />
                  <span className="text-muted-foreground mr-2 font-mono text-xs">{issue.identifier ?? issue.id.slice(0, 8)}</span>
                  <span className="flex-1 truncate">{issue.title}</span>
                  {issue.assigneeAgentId &&
                    (() => {
                      const name = agentName(issue.assigneeAgentId);
                      return name ? <Identity name={name} size="sm" className="ml-2 hidden sm:inline-flex" /> : null;
                    })()}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {agents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Agents">
              {agents.slice(0, 10).map((agent) => (
                <CommandItem key={agent.id} onSelect={() => go(agentUrl(agent))}>
                  <Bot className="mr-2 h-4 w-4" />
                  {agent.name}
                  <span className="text-xs text-muted-foreground ml-2">{agent.role}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {projects.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Projects">
              {projects.slice(0, 10).map((project) => (
                <CommandItem key={project.id} onSelect={() => go(projectUrl(project))}>
                  <Hexagon className="mr-2 h-4 w-4" />
                  {project.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
