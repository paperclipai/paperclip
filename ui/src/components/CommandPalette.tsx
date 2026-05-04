import { useState, useEffect, useMemo } from "react";
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
  BookOpen,
  CircleDot,
  ClipboardList,
  Bot,
  Boxes,
  Hexagon,
  Network,
  ShieldCheck,
  Target,
  Inbox,
  DollarSign,
  History,
  SquarePen,
  Plus,
} from "lucide-react";
import { Identity } from "./Identity";
import { agentUrl, projectUrl } from "../lib/utils";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
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

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  const visibleIssues = useMemo(
    () => (searchQuery.length > 0 ? searchedIssues : issues),
    [issues, searchedIssues, searchQuery],
  );

  return (
    <CommandDialog open={open} onOpenChange={(v) => {
        setOpen(v);
        if (v && isMobile) setSidebarOpen(false);
      }}>
      <CommandInput
        placeholder="작업, Jarvis, 프로젝트 검색..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>검색 결과가 없습니다.</CommandEmpty>

        <CommandGroup heading="빠른 실행">
          <CommandItem
            onSelect={() => {
              go("/daily-work");
            }}
          >
            <SquarePen className="mr-2 h-4 w-4" />
            일일 업무
            <span className="ml-auto text-xs text-muted-foreground">C</span>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false);
              openNewAgent();
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Jarvis 추가
          </CommandItem>
          <CommandItem onSelect={() => go("/projects")}>
            <Plus className="mr-2 h-4 w-4" />
            프로젝트 추가
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="RT2">
          <CommandItem onSelect={() => go("/daily-work")}>
            <SquarePen className="mr-2 h-4 w-4" />
            일일 업무 보드
          </CommandItem>
          <CommandItem onSelect={() => go("/one-liner")}>
            <SquarePen className="mr-2 h-4 w-4" />
            일일 업무 기록
          </CommandItem>
          <CommandItem onSelect={() => go("/knowledge")}>
            <BookOpen className="mr-2 h-4 w-4" />
            지식
          </CommandItem>
          <CommandItem onSelect={() => go("/marketplace")}>
            <Boxes className="mr-2 h-4 w-4" />
            Jarvis 마켓
          </CommandItem>
          <CommandItem onSelect={() => go("/pnl")}>
            <DollarSign className="mr-2 h-4 w-4" />
            성과 정산
          </CommandItem>
          <CommandItem onSelect={() => go("/org")}>
            <Network className="mr-2 h-4 w-4" />
            조직
          </CommandItem>
          <CommandItem onSelect={() => go("/governance")}>
            <ShieldCheck className="mr-2 h-4 w-4" />
            승인/거버넌스
          </CommandItem>
          <CommandItem onSelect={() => go("/plan-alignment")}>
            <ClipboardList className="mr-2 h-4 w-4" />
            개발계획 정합성
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="운영">
          <CommandItem onSelect={() => go("/dashboard")}>
            <ClipboardList className="mr-2 h-4 w-4" />
            업무 대시보드
          </CommandItem>
          <CommandItem onSelect={() => go("/inbox")}>
            <Inbox className="mr-2 h-4 w-4" />
            받은 요청
          </CommandItem>
          <CommandItem onSelect={() => go("/issues")}>
            <CircleDot className="mr-2 h-4 w-4" />
            작업
          </CommandItem>
          <CommandItem onSelect={() => go("/projects")}>
            <Hexagon className="mr-2 h-4 w-4" />
            프로젝트
          </CommandItem>
          <CommandItem onSelect={() => go("/goals")}>
            <Target className="mr-2 h-4 w-4" />
            목표
          </CommandItem>
          <CommandItem onSelect={() => go("/agents")}>
            <Bot className="mr-2 h-4 w-4" />
            Jarvis
          </CommandItem>
          <CommandItem onSelect={() => go("/costs")}>
            <DollarSign className="mr-2 h-4 w-4" />
            비용
          </CommandItem>
          <CommandItem onSelect={() => go("/activity")}>
            <History className="mr-2 h-4 w-4" />
            운영 기록
          </CommandItem>
        </CommandGroup>

        {visibleIssues.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="작업">
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
            <CommandGroup heading="Jarvis">
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
            <CommandGroup heading="프로젝트">
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
