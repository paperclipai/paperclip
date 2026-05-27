import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
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
  Search,
} from "lucide-react";
import { Identity } from "./Identity";
import { agentUrl, projectUrl } from "../lib/utils";
import { useLocalizedCopy } from "@/i18n/ui-copy";

const SEARCH_ALL_VALUE = "__paperclip-search-all__";

export function buildFullSearchPath(query: string) {
  const trimmed = query.trim();
  return trimmed.length === 0 ? "/search" : `/search?q=${encodeURIComponent(trimmed)}`;
}

export function CommandPalette() {
  const copy = useLocalizedCopy();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { openNewIssue, openNewAgent } = useDialogActions();
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
    if (!open) setQuery("");
  }, [open]);

  const { data: issues = [] } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open && searchQuery.length === 0,
  });

  const { data: searchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.search(selectedCompanyId!, searchQuery, undefined, 10),
    queryFn: () => issuesApi.list(selectedCompanyId!, { q: searchQuery, limit: 10, includeRoutineExecutions: true }),
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
  const projects = useMemo(
    () => allProjects.filter((p) => !p.archivedAt),
    [allProjects],
  );

  function go(path: string) {
    setOpen(false);
    navigate(path);
  }

  function goFullSearch() {
    go(buildFullSearchPath(searchQuery));
  }

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  const visibleIssues = useMemo(
    () => (searchQuery.length > 0 ? searchedIssues : issues),
    [issues, searchedIssues, searchQuery],
  );

  const showSearchAll = searchQuery.length > 0;
  const showEmptyHint = showSearchAll && visibleIssues.length === 0;

  return (
    <CommandDialog open={open} onOpenChange={(v) => {
        setOpen(v);
        if (v && isMobile) setSidebarOpen(false);
      }}>
      <CommandInput
        placeholder={copy("commandPalette.placeholder", "Search issues, agents, projects...", "작업, 직원, 프로젝트 검색...")}
        value={query}
        onValueChange={setQuery}
        onKeyDown={(event) => {
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
              {copy("commandPalette.noQuickMatchesPrefix", "No quick issue matches. Press", "빠른 작업 결과가 없습니다.")}
              {" "}
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[10px]">↵</kbd>{" "}
              {copy("commandPalette.noQuickMatchesSuffix", "to search all or keep typing to refine.", "전체 검색을 열거나 계속 입력해 좁히세요.")}
            </span>
          ) : (
            copy("commandPalette.noResults", "No results found.", "검색 결과가 없습니다.")
          )}
        </CommandEmpty>

        {showSearchAll ? (
          <CommandGroup heading={copy("commandPalette.group.search", "Search", "검색")}>
            <CommandItem
              value={`${SEARCH_ALL_VALUE} ${searchQuery}`}
              onSelect={goFullSearch}
              className="bg-accent/40 border border-accent data-[selected=true]:bg-accent/60"
              data-testid="command-search-all"
            >
              <Search className="mr-2 h-4 w-4" />
              <span className="flex-1 truncate">
                {copy("commandPalette.searchAllFor", "Search all for", "전체 검색")} <span className="font-semibold">&ldquo;{searchQuery}&rdquo;</span>
              </span>
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                <span>{copy("commandPalette.openFullSearch", "open full search", "전체 검색 열기")}</span>
                <kbd className="rounded border border-border bg-background px-1 py-0.5 text-[10px]">↵</kbd>
              </span>
            </CommandItem>
          </CommandGroup>
        ) : null}

        {showSearchAll ? <CommandSeparator /> : null}

        <CommandGroup heading={copy("commandPalette.group.actions", "Actions", "작업")}>
          <CommandItem
            onSelect={() => {
              setOpen(false);
              openNewIssue();
            }}
          >
            <SquarePen className="mr-2 h-4 w-4" />
            {copy("commandPalette.createIssue", "Create new issue", "새 작업 만들기")}
            <span className="ml-auto text-xs text-muted-foreground">C</span>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false);
              openNewAgent();
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            {copy("commandPalette.createAgent", "Create new agent", "새 직원 만들기")}
          </CommandItem>
          <CommandItem onSelect={() => go("/projects")}>
            <Plus className="mr-2 h-4 w-4" />
            {copy("commandPalette.createProject", "Create new project", "새 프로젝트 만들기")}
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={copy("commandPalette.group.pages", "Pages", "페이지")}>
          <CommandItem onSelect={() => go("/dashboard")}>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            {copy("sidebar.nav.dashboard", "Dashboard", "대시보드")}
          </CommandItem>
          <CommandItem onSelect={() => go("/inbox")}>
            <Inbox className="mr-2 h-4 w-4" />
            {copy("sidebar.nav.inbox", "Inbox", "받은함")}
          </CommandItem>
          <CommandItem onSelect={() => go("/issues")}>
            <CircleDot className="mr-2 h-4 w-4" />
            {copy("sidebar.nav.issues", "Issues", "작업")}
          </CommandItem>
          <CommandItem onSelect={() => go("/projects")}>
            <Hexagon className="mr-2 h-4 w-4" />
            {copy("sidebar.nav.projects", "Projects", "프로젝트")}
          </CommandItem>
          <CommandItem onSelect={() => go("/goals")}>
            <Target className="mr-2 h-4 w-4" />
            {copy("sidebar.nav.goals", "Goals", "목표")}
          </CommandItem>
          <CommandItem onSelect={() => go("/agents")}>
            <Bot className="mr-2 h-4 w-4" />
            {copy("sidebar.nav.agents", "Agents", "직원")}
          </CommandItem>
          <CommandItem onSelect={() => go("/costs")}>
            <DollarSign className="mr-2 h-4 w-4" />
            {copy("sidebar.nav.costs", "Costs", "비용")}
          </CommandItem>
          <CommandItem onSelect={() => go("/activity")}>
            <History className="mr-2 h-4 w-4" />
            {copy("sidebar.nav.activity", "Activity", "활동")}
          </CommandItem>
        </CommandGroup>

        {visibleIssues.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={copy("commandPalette.group.issues", "Issues", "작업")}>
              {visibleIssues.slice(0, 10).map((issue) => (
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
            <CommandGroup heading={copy("commandPalette.group.agents", "Agents", "직원")}>
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
            <CommandGroup heading={copy("commandPalette.group.projects", "Projects", "프로젝트")}>
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
