import { useState, useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { instanceSettingsApi } from "../api/instanceSettings";
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
  FileCode2,
  Plus,
  Search,
} from "lucide-react";
import { Identity } from "./Identity";
import { agentUrl, projectUrl } from "../lib/utils";
import {
  SEARCH_OPERATOR_QUICK_FILTERS,
  buildSearchPathFromQuery,
  parseSearchQuery,
  type SearchQueryParserContext,
} from "../lib/search-query-parser";

const SEARCH_ALL_VALUE = "__paperclip-search-all__";

export function buildFullSearchPath(query: string, context: SearchQueryParserContext = {}) {
  return buildSearchPathFromQuery(query, context);
}

const ISSUE_DETAIL_PATH_RE = /\/issues\/[^/?#]+(?:$|\?|#|\/)/;

function isOnIssueDetail(pathname: string): boolean {
  return ISSUE_DETAIL_PATH_RE.test(pathname);
}

/** Max promoted project matches kept when typing in the palette. */
const MAX_MATCHED_PROJECTS = 5;
/** Task cap when projects are also promoted, so Tasks can't crowd them out. */
const TASK_LIMIT_WITH_PROJECTS = 6;
const TASK_LIMIT = 10;

/** True when every char of `needle` appears in `haystack` in order (fuzzy). */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Score a project against a lowercased query. Higher is a better match;
 * `null` means no match. Prefers name hits (exact > prefix > substring) over
 * description hits, with fuzzy subsequence as a last resort.
 */
function scoreProjectMatch(name: string, description: string, q: string): number | null {
  if (name === q) return 1000;
  // Shorter names rank first, but clamp the length penalty so a prefix match can
  // never sink below the substring band (max 699) for unusually long names —
  // keeps the prefix > substring > description > fuzzy ordering invariant.
  if (name.startsWith(q)) return Math.max(700, 900 - name.length);
  const nameIdx = name.indexOf(q);
  if (nameIdx >= 0) return 700 - nameIdx;
  if (description.includes(q)) return 400;
  if (isSubsequence(q, name)) return 200;
  return null;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const { selectedCompanyId } = useCompany();
  const { openNewIssue, openNewAgent } = useDialogActions();
  const { isMobile, setSidebarOpen } = useSidebar();
  const searchQuery = query.trim();
  const onIssueDetail = isOnIssueDetail(location.pathname);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const fileViewerEnabled = experimentalSettings?.enableExperimentalFileViewer === true;

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
  const projects = useMemo(
    () => allProjects,
    [allProjects],
  );

  const { data: labels = [] } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: open,
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const parserContext = useMemo<SearchQueryParserContext>(() => ({
    currentUserId,
    agents,
    projects,
    labels,
  }), [agents, currentUserId, labels, projects]);
  const parsedQuery = useMemo(() => parseSearchQuery(query, parserContext), [parserContext, query]);
  const quickSearchQuery = parsedQuery.query.trim();

  const { data: issues = [] } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open && searchQuery.length === 0,
  });

  const { data: searchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.search(selectedCompanyId!, quickSearchQuery, undefined, 10),
    queryFn: () => issuesApi.list(selectedCompanyId!, { q: quickSearchQuery, limit: 10, includeRoutineExecutions: true }),
    enabled: !!selectedCompanyId && open && quickSearchQuery.length > 0,
  });

  function go(path: string) {
    setOpen(false);
    navigate(path);
  }

  function goFullSearch() {
    go(buildFullSearchPath(searchQuery, parserContext));
  }

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  const visibleIssues = useMemo(
    () => (quickSearchQuery.length > 0 ? searchedIssues : issues),
    [issues, searchedIssues, quickSearchQuery],
  );

  // Client-side typeahead ranking over the already-loaded projects. cmdk ranks
  // items by their `value` (which defaults to the rendered name) and would bury
  // or drop description-only matches, so we rank in JS and force-match below.
  const matchedProjects = useMemo(() => {
    if (quickSearchQuery.length === 0) return [];
    const q = quickSearchQuery.toLowerCase();
    return projects
      .map((project) => ({
        project,
        score: scoreProjectMatch(
          project.name.toLowerCase(),
          (project.description ?? "").toLowerCase(),
          q,
        ),
      }))
      .filter((entry): entry is { project: (typeof projects)[number]; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHED_PROJECTS)
      .map((entry) => entry.project);
  }, [projects, quickSearchQuery]);

  const showSearchAll = searchQuery.length > 0;
  const showPromotedProjects = showSearchAll && matchedProjects.length > 0;
  const taskLimit = showPromotedProjects ? TASK_LIMIT_WITH_PROJECTS : TASK_LIMIT;
  const showEmptyHint =
    showSearchAll && visibleIssues.length === 0 && matchedProjects.length === 0;

  return (
    <CommandDialog open={open} onOpenChange={(v) => {
        setOpen(v);
        if (v && isMobile) setSidebarOpen(false);
      }}>
      <CommandInput
        placeholder="Search tasks, agents, projects..."
        value={query}
        onValueChange={setQuery}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            goFullSearch();
            return;
          }
          if (event.key === "Enter" && showEmptyHint) {
            event.preventDefault();
            goFullSearch();
          }
        }}
      />
      <CommandList>
        <CommandEmpty>
          {showSearchAll ? (
            <span>
              No quick task matches. Press{" "}
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-(length:--text-nano)">↵</kbd>{" "}
              to <span className="font-medium">search all</span> or keep typing to refine.
            </span>
          ) : (
            "No results found."
          )}
        </CommandEmpty>

        {showSearchAll ? (
          <CommandGroup heading="Search">
            <CommandItem
              value={`${SEARCH_ALL_VALUE} ${searchQuery}`}
              onSelect={goFullSearch}
              className="bg-accent/40 border border-accent data-[selected=true]:bg-accent/60"
              data-testid="command-search-all"
            >
              <Search className="mr-2 h-4 w-4" />
              <span className="flex-1 truncate">
                Search all for <span className="font-semibold">&ldquo;{searchQuery}&rdquo;</span>
              </span>
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                <span>open full search</span>
                <kbd className="rounded border border-border bg-background px-1 py-0.5 text-(length:--text-nano)">↵</kbd>
              </span>
            </CommandItem>
          </CommandGroup>
        ) : null}

        {showSearchAll ? <CommandSeparator /> : null}

        <CommandGroup heading="Quick filters">
          {SEARCH_OPERATOR_QUICK_FILTERS.map((chip) => (
            <CommandItem
              key={chip}
              value={`quick-filter ${chip}`}
              onSelect={() => setQuery((current) => current.trim() ? `${current.trim()} ${chip}` : chip)}
              data-testid="command-filter-chip"
            >
              <Search className="mr-2 h-4 w-4" />
              <span className="font-mono text-xs">{chip}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {showPromotedProjects && (
          <>
            <CommandGroup heading="Projects">
              {matchedProjects.map((project) => (
                <CommandItem
                  key={project.id}
                  value={`${searchQuery} ${project.name}`}
                  onSelect={() => go(projectUrl(project))}
                  data-testid="command-project-match"
                >
                  <Hexagon className="mr-2 h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate">{project.name}</span>
                  {project.description ? (
                    <span className="ml-2 hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:inline">
                      {project.description}
                    </span>
                  ) : null}
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
            Create new task
            <span className="ml-auto text-xs text-muted-foreground">C</span>
          </CommandItem>
          {onIssueDetail && fileViewerEnabled && (
            <CommandItem
              onSelect={() => {
                setOpen(false);
                window.dispatchEvent(new CustomEvent("paperclip:open-file-viewer"));
              }}
            >
              <FileCode2 className="mr-2 h-4 w-4" />
              Open file in this issue...
              <span className="ml-auto text-xs text-muted-foreground">g f</span>
            </CommandItem>
          )}
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
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Pages">
          <CommandItem onSelect={() => go("/dashboard")}>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Dashboard
          </CommandItem>
          <CommandItem onSelect={() => go("/inbox")}>
            <Inbox className="mr-2 h-4 w-4" />
            Inbox
          </CommandItem>
          <CommandItem onSelect={() => go("/issues")}>
            <CircleDot className="mr-2 h-4 w-4" />
            Tasks
          </CommandItem>
          <CommandItem onSelect={() => go("/projects")}>
            <Hexagon className="mr-2 h-4 w-4" />
            Projects
          </CommandItem>
          <CommandItem onSelect={() => go("/goals")}>
            <Target className="mr-2 h-4 w-4" />
            Goals
          </CommandItem>
          <CommandItem onSelect={() => go("/agents")}>
            <Bot className="mr-2 h-4 w-4" />
            Agents
          </CommandItem>
          <CommandItem onSelect={() => go("/costs")}>
            <DollarSign className="mr-2 h-4 w-4" />
            Costs
          </CommandItem>
          <CommandItem onSelect={() => go("/activity")}>
            <History className="mr-2 h-4 w-4" />
            Activity
          </CommandItem>
        </CommandGroup>

        {visibleIssues.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Tasks">
              {visibleIssues.slice(0, taskLimit).map((issue) => (
                <CommandItem
                  key={issue.id}
                  value={
                    searchQuery.length > 0
                      ? `${searchQuery} ${issue.identifier ?? ""} ${issue.title}`
                      : undefined
                  }
                  onSelect={() => go(`/issues/${issue.identifier ?? issue.id}`)}
                >
                  <CircleDot className="mr-2 h-4 w-4" />
                  <span className="text-muted-foreground mr-2 font-mono text-xs">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                  <span className="flex-1 truncate">{issue.title}</span>
                  {issue.assigneeAgentId && (() => {
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

        {projects.length > 0 && !showSearchAll && (
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
