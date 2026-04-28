import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, BookOpen, Bot, CheckCircle2, GitBranch, RefreshCw, Save, Search, SquareChartGantt, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "../../components/EmptyState";
import { PageSkeleton } from "../../components/PageSkeleton";
import { Rt2DailyBoard } from "../../components/Rt2DailyBoard";
import { Rt2DailyWikiPanel } from "../../components/Rt2DailyWikiPanel";
import { authApi } from "../../api/auth";
import { projectsApi } from "../../api/projects";
import { rt2DailyReportApi } from "../../api/rt2-daily-report";
import { rt2GraphApi } from "../../api/rt2-graph";
import { rt2KnowledgeApi } from "../../api/rt2-knowledge";
import { rt2SearchApi } from "../../api/rt2-search";
import { Rt2GraphPanel } from "../../components/Rt2GraphPanel";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { useDialog } from "../../context/DialogContext";
import { queryKeys } from "../../lib/queryKeys";
import { calendarDateKey, projectUrl } from "../../lib/utils";

type KnowledgeView = "search" | "daily" | "wiki" | "graph" | "bridge" | "operations";

export function KnowledgePage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewProject } = useDialog();
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [view, setView] = useState<KnowledgeView>("search");
  const [searchQuery, setSearchQuery] = useState("forecast");
  const [searchProjectId, setSearchProjectId] = useState("");
  const [searchSourceType, setSearchSourceType] = useState("all");
  const [searchConfidence, setSearchConfidence] = useState("all");
  const [searchContradictionStatus, setSearchContradictionStatus] = useState("all");
  const [vaultRootPath, setVaultRootPath] = useState("C:/RealTycoon2/ObsidianVault");
  const [vaultSubdirectory, setVaultSubdirectory] = useState("rt2-export");
  const [approvedCandidateIds, setApprovedCandidateIds] = useState<string[]>([]);
  const [conflictDecision, setConflictDecision] = useState<"rt2_wins" | "vault_wins" | "manual_merge">("rt2_wins");
  const [manualMergeMarkdown, setManualMergeMarkdown] = useState("");
  const reportDate = calendarDateKey();

  useEffect(() => {
    setBreadcrumbs([{ label: "Knowledge" }]);
  }, [setBreadcrumbs]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const { data: projects = [], isLoading: projectsLoading, error: projectsError } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const activeProjects = useMemo(
    () => projects.filter((project) => !project.archivedAt),
    [projects],
  );

  useEffect(() => {
    if (activeProjects.length === 0) {
      setSelectedProjectId("");
      return;
    }

    if (!selectedProjectId || !activeProjects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(activeProjects[0]!.id);
    }
  }, [activeProjects, selectedProjectId]);

  const selectedProject = useMemo(
    () => activeProjects.find((project) => project.id === selectedProjectId) ?? null,
    [activeProjects, selectedProjectId],
  );
  const searchInput = useMemo(() => ({
    q: searchQuery.trim(),
    limit: 20,
    projectId: searchProjectId || undefined,
    sourceType: searchSourceType !== "all" ? searchSourceType : undefined,
    confidence: searchConfidence !== "all" ? searchConfidence : undefined,
    contradictionStatus: searchContradictionStatus !== "all" ? searchContradictionStatus : undefined,
  }), [searchConfidence, searchContradictionStatus, searchProjectId, searchQuery, searchSourceType]);

  const boardQueryKey =
    currentUserId && selectedCompanyId && selectedProjectId
      ? queryKeys.rt2Daily.board(selectedCompanyId, selectedProjectId, currentUserId, reportDate)
      : (["rt2-daily", "board-disabled"] as const);
  const wikiQueryKey =
    currentUserId && selectedCompanyId && selectedProjectId
      ? queryKeys.rt2Daily.wiki(selectedCompanyId, selectedProjectId, currentUserId, reportDate)
      : (["rt2-daily", "wiki-disabled"] as const);

  const dailyBoard = useQuery({
    queryKey: boardQueryKey,
    queryFn: () => rt2DailyReportApi.getBoard(selectedCompanyId!, selectedProjectId, reportDate),
    enabled: Boolean(selectedCompanyId && selectedProjectId && currentUserId && view === "daily"),
  });

  const dailyWiki = useQuery({
    queryKey: wikiQueryKey,
    queryFn: () => rt2DailyReportApi.getWiki(selectedCompanyId!, selectedProjectId, reportDate),
    enabled: Boolean(selectedCompanyId && selectedProjectId && currentUserId && view === "wiki"),
  });
  const semanticStatus = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.rt2Knowledge.semanticStatus(selectedCompanyId)
      : (["rt2-knowledge", "semantic-status-disabled"] as const),
    queryFn: () => rt2SearchApi.status(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && view === "search"),
  });
  const semanticSearch = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.rt2Knowledge.search(selectedCompanyId, searchInput)
      : (["rt2-knowledge", "semantic-search-disabled"] as const),
    queryFn: () => rt2SearchApi.search(selectedCompanyId!, searchInput),
    enabled: Boolean(selectedCompanyId && view === "search" && searchInput.q.length > 0),
  });
  const wikiPages = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.rt2Knowledge.pages(selectedCompanyId, undefined, 20)
      : (["rt2-knowledge", "pages-disabled"] as const),
    queryFn: () => rt2KnowledgeApi.listWikiPages(selectedCompanyId!, { limit: 20 }),
    enabled: Boolean(selectedCompanyId && view === "wiki"),
  });
  const dailyWikiPages = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.rt2Knowledge.dailyPages(selectedCompanyId, reportDate)
      : (["rt2-knowledge", "daily-pages-disabled"] as const),
    queryFn: () => rt2KnowledgeApi.listDailyWikiPages(selectedCompanyId!, { date: reportDate, limit: 50 }),
    enabled: Boolean(selectedCompanyId && view === "wiki"),
  });
  const vaultExport = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.rt2Knowledge.vault(selectedCompanyId, undefined, 20)
      : (["rt2-knowledge", "vault-disabled"] as const),
    queryFn: () => rt2KnowledgeApi.exportVault(selectedCompanyId!, { limit: 20 }),
    enabled: Boolean(selectedCompanyId && (view === "wiki" || view === "bridge")),
  });
  const vaultWriter = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.rt2Knowledge.vaultWriter(selectedCompanyId)
      : (["rt2-knowledge", "vault-writer-disabled"] as const),
    queryFn: () => rt2KnowledgeApi.getVaultWriter(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && view === "bridge"),
  });
  const contradictions = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.rt2Knowledge.contradictions(selectedCompanyId, "open", selectedProjectId)
      : (["rt2-knowledge", "contradictions-disabled"] as const),
    queryFn: () => rt2KnowledgeApi.listContradictions(selectedCompanyId!, {
      status: "open",
      projectId: selectedProjectId || undefined,
    }),
    enabled: Boolean(selectedCompanyId && selectedProjectId && view === "bridge"),
  });
  const operationsHealth = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.rt2Knowledge.operationsHealth(selectedCompanyId)
      : (["rt2-knowledge", "operations-health-disabled"] as const),
    queryFn: () => rt2KnowledgeApi.getOperationsHealth(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && view === "operations"),
  });
  useEffect(() => {
    if (!vaultWriter.data) return;
    setVaultRootPath(vaultWriter.data.rootPath);
    setVaultSubdirectory(vaultWriter.data.exportSubdirectory);
  }, [vaultWriter.data]);
  const graphReport = useQuery({
    queryKey: selectedCompanyId && selectedProjectId
      ? ["rt2-knowledge", selectedCompanyId, selectedProjectId, "operator-graph-report"]
      : (["rt2-knowledge", "operator-graph-report-disabled"] as const),
    queryFn: () => rt2GraphApi.getProjectGraphReport(selectedCompanyId!, selectedProjectId),
    enabled: Boolean(selectedCompanyId && selectedProjectId && view === "bridge"),
  });

  const saveCard = useMutation({
    mutationFn: ({
      todoIssueId,
      data,
    }: {
      todoIssueId: string;
      data: Parameters<typeof rt2DailyReportApi.saveCard>[2];
    }) => rt2DailyReportApi.saveCard(selectedCompanyId!, todoIssueId, data),
    onSuccess: ({ wikiPage }) => {
      queryClient.setQueryData(wikiQueryKey, wikiPage);
      queryClient.invalidateQueries({ queryKey: boardQueryKey });
      queryClient.invalidateQueries({ queryKey: wikiQueryKey });
    },
  });

  const askWiki = useMutation({
    mutationFn: (question: "오늘 뭐 했지?") =>
      rt2DailyReportApi.queryWiki(selectedCompanyId!, {
        projectId: selectedProjectId,
        reportDate,
        question,
      }),
  });
  const projectKnowledge = useMutation({
    mutationFn: () => rt2KnowledgeApi.project(selectedCompanyId!, 100),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Knowledge.pages(selectedCompanyId!, undefined, 20) });
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Knowledge.vault(selectedCompanyId!, undefined, 20) });
      if (selectedProjectId) {
        queryClient.invalidateQueries({
          queryKey: ["rt2-knowledge", selectedCompanyId, selectedProjectId, "operator-graph-report"],
        });
        queryClient.invalidateQueries({ queryKey: ["rt2-graph-report", selectedCompanyId, selectedProjectId] });
      }
    },
  });
  const reindexSemantic = useMutation({
    mutationFn: () => rt2SearchApi.reindex(selectedCompanyId!, "changed"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Knowledge.semanticStatus(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Knowledge.search(selectedCompanyId!, searchInput) });
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Knowledge.operationsHealth(selectedCompanyId!) });
    },
  });
  const importPreview = useMutation({
    mutationFn: () => {
      const files = (vaultExport.data?.files ?? []).map((file) => ({
        path: file.path,
        content: file.content,
      }));
      return rt2KnowledgeApi.previewVaultImport(selectedCompanyId!, {
        vaultName: vaultExport.data?.vaultName,
        projectId: selectedProjectId,
        files,
      });
    },
    onSuccess: (preview) => {
      setApprovedCandidateIds(
        preview.candidates
          .filter((candidate) => candidate.action !== "skip" && candidate.action !== "conflict")
          .map((candidate) => candidate.id),
      );
    },
  });
  const saveVaultWriter = useMutation({
    mutationFn: () => rt2KnowledgeApi.saveVaultWriter(selectedCompanyId!, {
      vaultName: vaultExport.data?.vaultName ?? `rt2-company-${selectedCompanyId}`,
      rootPath: vaultRootPath,
      exportSubdirectory: vaultSubdirectory,
      writerMode: "dry_run",
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Knowledge.vaultWriter(selectedCompanyId!) });
    },
  });
  const dryRunVaultWriter = useMutation({
    mutationFn: () => rt2KnowledgeApi.dryRunVaultWriter(selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Knowledge.vaultWriter(selectedCompanyId!) });
    },
  });
  const applyImport = useMutation({
    mutationFn: () => {
      const files = (vaultExport.data?.files ?? []).map((file) => ({
        path: file.path,
        content: file.content,
      }));
      return rt2KnowledgeApi.applyVaultImport(selectedCompanyId!, {
        vaultName: vaultExport.data?.vaultName,
        projectId: selectedProjectId,
        files,
        approvedCandidateIds,
        reason: "Operator approved selected Obsidian import candidates.",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Knowledge.pages(selectedCompanyId!, undefined, 20) });
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Knowledge.vault(selectedCompanyId!, undefined, 20) });
    },
  });
  const resolveConflict = useMutation({
    mutationFn: () => {
      const file = vaultExport.data?.files[0];
      if (!file) throw new Error("No vault file is available for conflict resolution.");
      return rt2KnowledgeApi.resolveVaultConflict(selectedCompanyId!, {
        projectId: selectedProjectId,
        file: { path: file.path, content: file.content },
        decision: conflictDecision,
        manualMarkdown: conflictDecision === "manual_merge" ? manualMergeMarkdown : undefined,
        reason: "Operator resolved bidirectional vault conflict from Knowledge Bridge.",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Knowledge.pages(selectedCompanyId!, undefined, 20) });
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Knowledge.vault(selectedCompanyId!, undefined, 20) });
    },
  });
  const generateContradictions = useMutation({
    mutationFn: () => rt2KnowledgeApi.generateContradictions(selectedCompanyId!, selectedProjectId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.rt2Knowledge.contradictions(selectedCompanyId!, "open", selectedProjectId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Knowledge.semanticStatus(selectedCompanyId!) });
    },
  });
  const resolveContradiction = useMutation({
    mutationFn: ({
      candidateId,
      decision,
    }: {
      candidateId: string;
      decision: "false_positive" | "accept_newer" | "keep_older" | "request_follow_up";
    }) => rt2KnowledgeApi.resolveContradiction(selectedCompanyId!, candidateId, {
      decision,
      reason: `Operator selected ${decision} from Knowledge Bridge.`,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.rt2Knowledge.contradictions(selectedCompanyId!, "open", selectedProjectId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Knowledge.semanticStatus(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={BookOpen} message="Select a company to open Knowledge." />;
  }

  if (projectsLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (projectsError) {
    return <p className="text-sm text-destructive">{(projectsError as Error).message}</p>;
  }

  if (activeProjects.length === 0) {
    return (
      <EmptyState
        icon={BookOpen}
        message="Create a project first. Knowledge is composed from project-level RT2 activity."
        action="Create project"
        onAction={openNewProject}
      />
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-card px-6 py-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Knowledge
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Daily, wiki, graph in one route</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              프로젝트 탭에 갇혀 있던 RT2 지식 surface를 회사 레벨 route로 올렸습니다. 세부 drill-down은
              여전히 project detail에서 이어지고, 여기서는 현재 프로젝트를 골라 바로 확인합니다.
            </p>
          </div>
          {selectedProject ? (
            <Button variant="outline" asChild>
              <Link to={projectUrl(selectedProject)}>Open project detail</Link>
            </Button>
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Project Scope
            </div>
            <p className="text-sm text-muted-foreground">
              현재 view는 project-scoped data를 읽습니다. 이후 phase에서 company-wide projections로 확장합니다.
            </p>
          </div>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            <span>Project</span>
            <select
              className="min-w-[16rem] rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
            >
              {activeProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <Tabs className="mt-5" value={view} onValueChange={(next) => setView(next as KnowledgeView)}>
          <TabsList variant="line">
            <TabsTrigger value="search">
              <Search className="h-4 w-4" />
              Search
            </TabsTrigger>
            <TabsTrigger value="daily">
              <SquareChartGantt className="h-4 w-4" />
              Daily
            </TabsTrigger>
            <TabsTrigger value="wiki">
              <BookOpen className="h-4 w-4" />
              Wiki
            </TabsTrigger>
            <TabsTrigger value="graph">
              <GitBranch className="h-4 w-4" />
              Graph
            </TabsTrigger>
            <TabsTrigger value="bridge">
              <UploadCloud className="h-4 w-4" />
              Bridge
            </TabsTrigger>
            <TabsTrigger value="operations">
              <Activity className="h-4 w-4" />
              Operations
            </TabsTrigger>
          </TabsList>

          <TabsContent value="search" className="pt-4">
            <div className="space-y-4">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                <label className="space-y-1 text-sm text-muted-foreground">
                  <span>Semantic query</span>
                  <input
                    data-page-search-target="true"
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search RT2 wiki, graph, work artifacts..."
                  />
                </label>
                <div className="flex items-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => reindexSemantic.mutate()}
                    disabled={reindexSemantic.isPending}
                  >
                    <RefreshCw className="h-4 w-4" />
                    {reindexSemantic.isPending ? "Indexing" : "Reindex changed"}
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-4">
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Project</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                    value={searchProjectId}
                    onChange={(event) => setSearchProjectId(event.target.value)}
                  >
                    <option value="">All company knowledge</option>
                    {activeProjects.map((project) => (
                      <option key={project.id} value={project.id}>{project.name}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Source</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                    value={searchSourceType}
                    onChange={(event) => setSearchSourceType(event.target.value)}
                  >
                    <option value="all">All sources</option>
                    <option value="daily_wiki_page">Daily wiki</option>
                    <option value="wiki_page">Wiki</option>
                    <option value="graph_node">Graph node</option>
                    <option value="graph_edge">Graph edge</option>
                    <option value="deliverable">Deliverable</option>
                    <option value="task">Task</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Confidence</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                    value={searchConfidence}
                    onChange={(event) => setSearchConfidence(event.target.value)}
                  >
                    <option value="all">Any confidence</option>
                    <option value="EXTRACTED">EXTRACTED</option>
                    <option value="INFERRED">INFERRED</option>
                    <option value="AMBIGUOUS">AMBIGUOUS</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Contradiction</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                    value={searchContradictionStatus}
                    onChange={(event) => setSearchContradictionStatus(event.target.value)}
                  >
                    <option value="all">Any status</option>
                    <option value="unknown">Unknown</option>
                    <option value="none">None</option>
                    <option value="unresolved">Unresolved</option>
                    <option value="resolved">Resolved</option>
                  </select>
                </label>
              </div>

              <div className="grid gap-3 text-xs md:grid-cols-4">
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-muted-foreground">Indexed chunks</div>
                  <div className="mt-1 text-lg font-semibold">{semanticStatus.data?.indexedChunks ?? 0}</div>
                </div>
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-muted-foreground">Sources</div>
                  <div className="mt-1 text-lg font-semibold">{semanticStatus.data?.sourceCount ?? 0}</div>
                </div>
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-muted-foreground">Stale chunks</div>
                  <div className="mt-1 text-lg font-semibold">{semanticStatus.data?.staleChunks ?? 0}</div>
                </div>
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-muted-foreground">Mode</div>
                  <div className="mt-1 text-lg font-semibold">{semanticStatus.data?.providerMode ?? "fallback"}</div>
                </div>
              </div>

              {semanticSearch.isLoading ? (
                <PageSkeleton variant="detail" />
              ) : semanticSearch.error ? (
                <p className="text-sm text-destructive">{(semanticSearch.error as Error).message}</p>
              ) : semanticSearch.data?.results.length ? (
                <div className="space-y-3">
                  <div className="text-xs text-muted-foreground">
                    {semanticSearch.data.total} results · {semanticSearch.data.searchTimeMs}ms · semantic + lexical fallback
                  </div>
                  {semanticSearch.data.results.map((result) => (
                    <article key={`${result.sourceType}:${result.sourceId}`} className="rounded-lg border border-border bg-background px-4 py-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                              {result.sourceType}
                            </span>
                            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                              {result.freshness}
                            </span>
                            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                              {result.confidence}
                            </span>
                            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                              contradiction:{result.contradictionStatus}
                            </span>
                          </div>
                          <h3 className="mt-2 truncate text-sm font-semibold">{result.title}</h3>
                          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{result.snippet}</p>
                        </div>
                        <div className="shrink-0 text-right text-xs text-muted-foreground">
                          <div className="text-sm font-semibold text-foreground">{result.score.toFixed(2)}</div>
                          <div>{new Date(result.updatedAt).toLocaleDateString()}</div>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {result.evidence.slice(0, 4).map((item) => (
                          <span key={`${item.source}:${item.reason}`} className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
                            {item.source} · {item.reason}
                          </span>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              ) : searchInput.q ? (
                <p className="text-sm text-muted-foreground">No semantic or lexical knowledge matched this query.</p>
              ) : (
                <p className="text-sm text-muted-foreground">Enter a query to search company knowledge.</p>
              )}
            </div>
          </TabsContent>

          <TabsContent value="daily" className="pt-4">
            {!currentUserId ? (
              <p className="text-sm text-muted-foreground">Daily board를 보려면 로그인 정보가 필요합니다.</p>
            ) : dailyBoard.isLoading ? (
              <PageSkeleton variant="detail" />
            ) : dailyBoard.error ? (
              <p className="text-sm text-destructive">{(dailyBoard.error as Error).message}</p>
            ) : dailyBoard.data ? (
              <Rt2DailyBoard
                board={dailyBoard.data}
                pendingTodoIssueId={saveCard.isPending ? saveCard.variables?.todoIssueId ?? null : null}
                onSaveCard={(todoIssueId, data) => saveCard.mutate({ todoIssueId, data })}
              />
            ) : (
              <p className="text-sm text-muted-foreground">오늘 Daily board 데이터가 없습니다.</p>
            )}
          </TabsContent>

          <TabsContent value="wiki" className="pt-4">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
              <div>
                {!currentUserId ? (
                  <p className="text-sm text-muted-foreground">Daily wiki를 보려면 로그인 정보가 필요합니다.</p>
                ) : dailyWiki.isLoading ? (
                  <PageSkeleton variant="detail" />
                ) : dailyWiki.error ? (
                  <p className="text-sm text-destructive">{(dailyWiki.error as Error).message}</p>
                ) : dailyWiki.data ? (
                  <Rt2DailyWikiPanel
                    page={dailyWiki.data}
                    answer={askWiki.data ?? null}
                    queryPending={askWiki.isPending}
                    onAsk={(question) => askWiki.mutate(question)}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">오늘 Daily wiki 데이터가 없습니다.</p>
                )}
              </div>
              <aside className="space-y-3 rounded-xl border border-border bg-background p-4">
                <div>
                  <div className="text-sm font-semibold">Operator wiki</div>
                  <p className="text-xs text-muted-foreground">
                    Event projector가 만든 index/log/topic page와 Obsidian-compatible vault export를 확인합니다.
                  </p>
                </div>
                {wikiPages.isLoading ? (
                  <p className="text-sm text-muted-foreground">Loading wiki pages...</p>
                ) : wikiPages.error ? (
                  <p className="text-sm text-destructive">{(wikiPages.error as Error).message}</p>
                ) : (
                  <div className="space-y-2">
                    {(wikiPages.data?.pages ?? []).slice(0, 6).map((page) => (
                      <div key={page.id} className="rounded-lg border border-border px-3 py-2">
                        <div className="text-sm font-medium">{page.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {page.pageKey} · {page.sourceEventIds.length} events
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="rounded-lg border border-dashed border-border px-3 py-2">
                  <div className="text-xs font-medium uppercase text-muted-foreground">Vault export</div>
                  <div className="mt-1 text-sm">
                    {vaultExport.data ? `${vaultExport.data.files.length} markdown files ready` : "Preparing export preview"}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Primary write path는 DB/event projector이며, markdown은 inspection/export output입니다.
                  </div>
                </div>
              </aside>

              <aside className="space-y-3 rounded-xl border border-border bg-background p-4">
                <div>
                  <div className="text-sm font-semibold">Daily Wiki pages</div>
                  <p className="text-xs text-muted-foreground">
                    Daily projector로 생성된 일별 위키 페이지 목록을 확인합니다.
                  </p>
                </div>
                {dailyWikiPages.isLoading ? (
                  <p className="text-sm text-muted-foreground">Loading daily pages...</p>
                ) : dailyWikiPages.error ? (
                  <p className="text-sm text-destructive">{(dailyWikiPages.error as Error).message}</p>
                ) : dailyWikiPages.data?.pages.length ? (
                  <div className="space-y-2">
                    {dailyWikiPages.data.pages.slice(0, 10).map((page) => (
                      <div key={page.pageKey} className="rounded-lg border border-border px-3 py-2">
                        <div className="text-sm font-medium">{page.pageKey}</div>
                        <div className="text-xs text-muted-foreground">
                          {page.reportDate} · {page.sourceEventIds?.length ?? 0} events
                          {page.userId !== "all" ? ` · user:${page.userId}` : ""}
                        </div>
                        {page.shortSummary.length > 0 && (
                          <div className="mt-1 text-xs text-muted-foreground">{page.shortSummary[0]}</div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Daily wiki page가 없습니다.</p>
                )}
              </aside>
            </div>
          </TabsContent>

          <TabsContent value="graph" className="pt-4">
            {selectedProjectId ? (
              <Rt2GraphPanel companyId={selectedCompanyId} projectId={selectedProjectId} />
            ) : (
              <p className="text-sm text-muted-foreground">Project를 선택하면 Task Mesh graph가 표시됩니다.</p>
            )}
          </TabsContent>

          <TabsContent value="bridge" className="pt-4">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
              <section className="space-y-4 rounded-xl border border-border bg-background p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-sm font-semibold">Knowledge bridge workflow</div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Event projector를 갱신하고 Obsidian-compatible export/import preview를 같은 흐름에서 검수합니다.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => projectKnowledge.mutate()}
                    disabled={projectKnowledge.isPending}
                  >
                    <RefreshCw className="h-4 w-4" />
                    {projectKnowledge.isPending ? "Projecting" : "Project knowledge"}
                  </Button>
                </div>

                {projectKnowledge.data ? (
                  <div className="grid gap-2 text-xs sm:grid-cols-3">
                    <div className="rounded-lg border border-border px-3 py-2">
                      <div className="text-muted-foreground">Wiki pages</div>
                      <div className="text-lg font-semibold">{projectKnowledge.data.wikiPages}</div>
                    </div>
                    <div className="rounded-lg border border-border px-3 py-2">
                      <div className="text-muted-foreground">Graph rows</div>
                      <div className="text-lg font-semibold">
                        {projectKnowledge.data.graphNodes + projectKnowledge.data.graphEdges}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border px-3 py-2">
                      <div className="text-muted-foreground">Pending events</div>
                      <div className="text-lg font-semibold">{projectKnowledge.data.pendingEvents}</div>
                    </div>
                  </div>
                ) : null}

                <div className="rounded-lg border border-border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-medium uppercase text-muted-foreground">Vault export</div>
                      <div className="mt-1 text-sm">
                        {vaultExport.data
                          ? `${vaultExport.data.files.length} markdown files in ${vaultExport.data.vaultName}`
                          : "Export bundle is loading"}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => importPreview.mutate()}
                      disabled={!vaultExport.data || vaultExport.data.files.length === 0 || importPreview.isPending}
                    >
                      <UploadCloud className="h-4 w-4" />
                      {importPreview.isPending ? "Checking" : "Import preview"}
                    </Button>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    Markdown은 inspection/export output입니다. Import preview는 파일의 frontmatter와 source event evidence만 검증합니다.
                  </div>
                </div>

                <div className="space-y-3 rounded-lg border border-border px-3 py-3">
                  <div>
                    <div className="text-xs font-medium uppercase text-muted-foreground">Local vault writer</div>
                    <div className="mt-1 text-sm">
                      {vaultWriter.data?.exportPath ?? "Obsidian-compatible export target을 설정하세요."}
                    </div>
                  </div>
                  <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_12rem]">
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>Vault root path</span>
                      <input
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                        value={vaultRootPath}
                        onChange={(event) => setVaultRootPath(event.target.value)}
                      />
                    </label>
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>Export folder</span>
                      <input
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                        value={vaultSubdirectory}
                        onChange={(event) => setVaultSubdirectory(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => saveVaultWriter.mutate()} disabled={saveVaultWriter.isPending}>
                      <Save className="h-4 w-4" />
                      {saveVaultWriter.isPending ? "Saving" : "Save writer"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => dryRunVaultWriter.mutate()} disabled={dryRunVaultWriter.isPending || !vaultWriter.data}>
                      <RefreshCw className="h-4 w-4" />
                      {dryRunVaultWriter.isPending ? "Running" : "Dry-run"}
                    </Button>
                  </div>
                  {(saveVaultWriter.data?.lastDryRun ?? dryRunVaultWriter.data ?? vaultWriter.data?.lastDryRun) ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                      {(() => {
                        const dryRun = saveVaultWriter.data?.lastDryRun ?? dryRunVaultWriter.data ?? vaultWriter.data?.lastDryRun;
                        return dryRun
                          ? `${dryRun.fileCount} files · ${dryRun.conflictCount} conflicts · target ${dryRun.exportPath || "not configured"}`
                          : null;
                      })()}
                    </div>
                  ) : null}
                </div>

                <div className="space-y-3 rounded-lg border border-border px-3 py-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="text-xs font-medium uppercase text-muted-foreground">Contradiction review</div>
                      <div className="mt-1 text-sm">
                        Daily wiki evidence conflicts become review candidates with raw evidence and deterministic reason codes.
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => generateContradictions.mutate()}
                      disabled={!selectedProjectId || generateContradictions.isPending}
                    >
                      <RefreshCw className="h-4 w-4" />
                      {generateContradictions.isPending ? "Checking" : "Generate"}
                    </Button>
                  </div>
                  {generateContradictions.data ? (
                    <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                      {generateContradictions.data.candidatesCreated} candidates · {generateContradictions.data.semanticComparisons} comparisons
                    </div>
                  ) : null}
                  {contradictions.isLoading ? (
                    <p className="text-sm text-muted-foreground">Loading contradiction candidates...</p>
                  ) : contradictions.data?.candidates.length ? (
                    <div className="max-h-72 space-y-2 overflow-auto">
                      {contradictions.data.candidates.slice(0, 6).map((candidate) => (
                        <div key={candidate.id} className="rounded-md border border-border px-3 py-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{candidate.title}</div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {candidate.reasonCode} · confidence {candidate.confidence}
                              </div>
                              <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                                {candidate.rawEvidence.map((item) => String(item.snippet ?? "")).filter(Boolean).join(" / ")}
                              </div>
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {(["false_positive", "accept_newer", "keep_older", "request_follow_up"] as const).map((decision) => (
                              <Button
                                key={decision}
                                size="sm"
                                variant="outline"
                                onClick={() => resolveContradiction.mutate({ candidateId: candidate.id, decision })}
                                disabled={resolveContradiction.isPending}
                              >
                                {decision}
                              </Button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Open contradiction candidates are clear for this project.</p>
                  )}
                </div>

                {vaultExport.data?.files.length ? (
                  <div className="max-h-64 space-y-2 overflow-auto">
                    {vaultExport.data.files.slice(0, 8).map((file) => (
                      <div key={file.path} className="rounded-lg border border-border px-3 py-2">
                        <div className="text-sm font-medium">{file.path}</div>
                        <div className="text-xs text-muted-foreground">
                          {file.sourceEventIds.length} source events · updated {new Date(file.updatedAt).toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Project knowledge를 실행하면 export bundle이 준비됩니다.</p>
                )}
              </section>

              <section className="space-y-4 rounded-xl border border-border bg-background p-4">
                <div>
                  <div className="text-sm font-semibold">Graph report and evidence</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Graph report의 confidence와 vault import preview의 source event match 상태를 함께 확인합니다.
                  </p>
                </div>

                <div className="grid gap-2 text-xs sm:grid-cols-3">
                  <div className="rounded-lg border border-border px-3 py-2">
                    <div className="text-muted-foreground">EXTRACTED</div>
                    <div className="text-lg font-semibold">
                      {graphReport.data?.confidenceSummary.EXTRACTED ?? 0}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border px-3 py-2">
                    <div className="text-muted-foreground">INFERRED</div>
                    <div className="text-lg font-semibold">
                      {graphReport.data?.confidenceSummary.INFERRED ?? 0}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border px-3 py-2">
                    <div className="text-muted-foreground">AMBIGUOUS</div>
                    <div className="text-lg font-semibold">
                      {graphReport.data?.confidenceSummary.AMBIGUOUS ?? 0}
                    </div>
                  </div>
                </div>

                {importPreview.data ? (
                  <div className="rounded-lg border border-border px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-medium uppercase text-muted-foreground">Import evidence</div>
                        <div className="mt-1 text-sm font-medium">{importPreview.data.evidenceStatus}</div>
                      </div>
                      <div className="text-right text-xs text-muted-foreground">
                        {importPreview.data.matchedEventIds.length} matched · {importPreview.data.missingEventIds.length} missing
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      {importPreview.data.files.slice(0, 8).map((file) => (
                        <div key={file.path} className="rounded-md border border-border px-2 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm">{file.path}</span>
                            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">
                              {file.status}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {file.sourceEventIds.length} source events
                            {file.warnings.length > 0 ? ` · ${file.warnings.join(", ")}` : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 border-t border-border pt-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="text-xs font-medium uppercase text-muted-foreground">Approved changes</div>
                          <div className="mt-1 text-sm">
                            {approvedCandidateIds.length} of {importPreview.data.candidates.length} candidates selected
                          </div>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => applyImport.mutate()}
                          disabled={approvedCandidateIds.length === 0 || applyImport.isPending}
                        >
                          <CheckCircle2 className="h-4 w-4" />
                          {applyImport.isPending ? "Applying" : "Apply approved"}
                        </Button>
                      </div>
                      <div className="mt-3 max-h-56 space-y-2 overflow-auto">
                        {importPreview.data.candidates.slice(0, 10).map((candidate) => (
                          <label key={candidate.id} className="flex gap-2 rounded-md border border-border px-2 py-2">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={approvedCandidateIds.includes(candidate.id)}
                              disabled={candidate.action === "skip" || candidate.action === "conflict"}
                              onChange={(event) => {
                                setApprovedCandidateIds((current) => event.target.checked
                                  ? [...current, candidate.id]
                                  : current.filter((id) => id !== candidate.id));
                              }}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">{candidate.label}</span>
                              <span className="block text-xs text-muted-foreground">
                                {candidate.kind} · {candidate.action} · {candidate.status}
                                {candidate.warnings.length > 0 ? ` · ${candidate.warnings.join(", ")}` : ""}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                      {applyImport.data ? (
                        <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-200">
                          Applied {applyImport.data.updatedWikiPages} wiki pages, {applyImport.data.updatedGraphNodes} graph nodes, {applyImport.data.updatedGraphEdges} graph edges.
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Import preview를 실행하면 vault file별 evidence status가 표시됩니다.
                  </p>
                )}

                <div className="space-y-3 rounded-lg border border-border px-3 py-3">
                  <div>
                    <div className="text-xs font-medium uppercase text-muted-foreground">Conflict resolution</div>
                    <div className="mt-1 text-sm">
                      RT2 wins, Vault wins, manual merge 결정을 감사 기록과 함께 남깁니다.
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(["rt2_wins", "vault_wins", "manual_merge"] as const).map((decision) => (
                      <button
                        key={decision}
                        type="button"
                        className={`rounded-md border px-3 py-2 text-left text-xs ${
                          conflictDecision === decision ? "border-primary bg-primary/10" : "border-border bg-background"
                        }`}
                        onClick={() => setConflictDecision(decision)}
                      >
                        {decision}
                      </button>
                    ))}
                  </div>
                  {conflictDecision === "manual_merge" ? (
                    <textarea
                      className="min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                      value={manualMergeMarkdown}
                      onChange={(event) => setManualMergeMarkdown(event.target.value)}
                      placeholder="# Manual merged RT2 knowledge"
                    />
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resolveConflict.mutate()}
                    disabled={!vaultExport.data?.files.length || resolveConflict.isPending}
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {resolveConflict.isPending ? "Resolving" : "Resolve sample conflict"}
                  </Button>
                  {resolveConflict.data ? (
                    <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                      {resolveConflict.data.pageKey} · {resolveConflict.data.decision} · audit {resolveConflict.data.auditId}
                    </div>
                  ) : null}
                </div>

                {graphReport.data?.staleWarnings.length ? (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                    {graphReport.data.staleWarnings.slice(0, 3).join(" ")}
                  </div>
                ) : null}
              </section>
            </div>
          </TabsContent>

          <TabsContent value="operations" className="pt-4">
            {operationsHealth.isLoading ? (
              <PageSkeleton variant="detail" />
            ) : operationsHealth.error ? (
              <p className="text-sm text-destructive">{(operationsHealth.error as Error).message}</p>
            ) : operationsHealth.data ? (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <HealthCard
                    label="Overall health"
                    value={operationsHealth.data.status}
                    detail={`${operationsHealth.data.reasons.length} active signals`}
                    status={operationsHealth.data.status}
                  />
                  <HealthCard
                    label="Index"
                    value={`${operationsHealth.data.semanticIndex.indexedChunks} chunks`}
                    detail={`${operationsHealth.data.semanticIndex.staleChunks} stale · ${operationsHealth.data.semanticIndex.providerMode ?? "fallback"}`}
                    status={operationsHealth.data.semanticIndex.status}
                  />
                  <HealthCard
                    label="Contradictions"
                    value={`${operationsHealth.data.contradictionReview.openCandidates} open`}
                    detail={`${operationsHealth.data.contradictionReview.resolvedCandidates} resolved · ${operationsHealth.data.contradictionReview.recentlyResolved} recent`}
                    status={operationsHealth.data.contradictionReview.status}
                  />
                  <HealthCard
                    label="Jarvis grounding"
                    value={operationsHealth.data.jarvisGrounding.groundingAvailable ? "available" : "missing"}
                    detail={`${operationsHealth.data.jarvisGrounding.taskCount} RT2 tasks`}
                    status={operationsHealth.data.jarvisGrounding.status}
                  />
                </div>

                <section className="rounded-lg border border-border bg-background p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="text-sm font-semibold">Semantic index run</div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Last successful run is tracked separately from the latest run.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => reindexSemantic.mutate()}
                      disabled={reindexSemantic.isPending}
                    >
                      <RefreshCw className={`h-4 w-4 ${reindexSemantic.isPending ? "animate-spin" : ""}`} />
                      Reindex changed
                    </Button>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <div className="rounded-md border border-border px-3 py-2 text-sm">
                      <div className="text-xs text-muted-foreground">Latest run</div>
                      <div className="mt-1 font-medium">
                        {operationsHealth.data.semanticIndex.latestRun?.status ?? "none"}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {operationsHealth.data.semanticIndex.latestRun?.startedAt ?? "No semantic index run recorded"}
                      </div>
                    </div>
                    <div className="rounded-md border border-border px-3 py-2 text-sm">
                      <div className="text-xs text-muted-foreground">Last successful run</div>
                      <div className="mt-1 font-medium">
                        {operationsHealth.data.semanticIndex.lastSuccessfulRun?.completedAt ?? "none"}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {operationsHealth.data.semanticIndex.embeddingModel ?? "No embedding model recorded"}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="rounded-lg border border-border bg-background p-4">
                  <div className="text-sm font-semibold">Health signals</div>
                  {operationsHealth.data.reasons.length ? (
                    <div className="mt-3 space-y-2">
                      {operationsHealth.data.reasons.map((reason) => (
                        <div key={`${reason.code}-${reason.message}`} className="flex gap-2 rounded-md border border-border px-3 py-2 text-sm">
                          {reason.severity === "failed" ? (
                            <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
                          ) : (
                            <Bot className="mt-0.5 h-4 w-4 text-amber-600" />
                          )}
                          <div>
                            <div className="font-medium">{reason.code}</div>
                            <div className="text-muted-foreground">{reason.message}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">All semantic knowledge operations checks are healthy.</p>
                  )}
                </section>
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </section>
    </div>
  );
}

function HealthCard({
  label,
  value,
  detail,
  status,
}: {
  label: string;
  value: string;
  detail: string;
  status: "healthy" | "degraded" | "failed";
}) {
  const statusClass = status === "failed"
    ? "text-destructive"
    : status === "degraded"
      ? "text-amber-600"
      : "text-emerald-600";

  return (
    <div className="rounded-lg border border-border bg-background px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">{label}</div>
        <span className={`text-xs font-medium ${statusClass}`}>{status}</span>
      </div>
      <div className="mt-2 text-lg font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}
