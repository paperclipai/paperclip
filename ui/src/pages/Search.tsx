import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search as SearchIcon, AlertTriangle, FileQuestion, Plus, X } from "lucide-react";
import {
  COMPANY_SEARCH_DEFAULT_LIMIT,
  COMPANY_SEARCH_SCOPES,
  type CompanySearchCountType,
  type CompanySearchResponse,
  type CompanySearchResult,
  type CompanySearchScope,
  type CompanySearchSort,
} from "@paperclipai/shared";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useNavigate, useSearchParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialogActions } from "../context/DialogContext";
import { searchApi } from "../api/search";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { loadRecentSearches, pushRecentSearch } from "../lib/recent-searches";
import { PageTabBar, type PageTabItem } from "../components/PageTabBar";
import {
  applySearchFiltersToParams,
  applySearchOperatorSuggestion,
  hasSearchFilters,
  parseSearchQuery,
  readSearchFiltersFromParams,
  searchFilterPills,
  searchOperatorSuggestions,
  type ParsedSearchQuery,
  type SearchQueryParserContext,
} from "../lib/search-query-parser";
import { IssueGroupHeader } from "../components/IssueGroupHeader";
import { SearchResultRow } from "../components/search/SearchResultRow";
import { SearchFilterBar, type SearchFilterDataProps } from "../components/search/SearchFilterBar";
import { SearchFilterChips } from "../components/search/SearchFilterChips";
import { SearchFilterSheet, SearchFilterSheetTrigger } from "../components/search/SearchFilterSheet";
import { SearchSortMenu } from "../components/search/SearchSortMenu";
import { ZeroResultsRecovery } from "../components/search/ZeroResultsRecovery";
import { useSidebar } from "../context/SidebarContext";
import {
  SORT_LABELS,
  countActiveFilters,
  parseSearchSort,
  type FilterChipLookups,
} from "../lib/search-filters";
import type { ReactNode } from "react";
import type { Agent, IssueLabel, Project } from "@paperclipai/shared";

const SEARCH_DEBOUNCE_MS = 250;
const IDENTIFIER_PATTERN = /^[A-Z]+-\d+$/;

const SCOPE_LABELS: Record<CompanySearchScope, string> = {
  all: "All",
  issues: "Tasks",
  comments: "Comments",
  documents: "Documents",
  artifacts: "Artifacts",
  agents: "Agents",
  projects: "Projects",
};

type SubGroupKey = "issues" | "comments" | "documents" | "artifacts" | "agents" | "projects";

const SUBGROUP_ORDER: SubGroupKey[] = ["issues", "comments", "documents", "artifacts", "agents", "projects"];

const SUBGROUP_LABELS: Record<SubGroupKey, string> = {
  issues: "Tasks",
  comments: "Comments",
  documents: "Documents",
  artifacts: "Artifacts",
  agents: "Agents",
  projects: "Projects",
};

function classifyResult(result: CompanySearchResult): SubGroupKey {
  if (result.type === "artifact") return "artifacts";
  if (result.type === "agent") return "agents";
  if (result.type === "project") return "projects";
  const matched = new Set(result.matchedFields);
  if (matched.has("title") || matched.has("identifier") || matched.has("description")) return "issues";
  if (matched.has("comment")) return "comments";
  if (matched.has("document")) return "documents";
  return "issues";
}

function buildSubgroups(results: CompanySearchResult[]): Array<{ key: SubGroupKey; results: CompanySearchResult[] }> {
  const buckets = new Map<SubGroupKey, CompanySearchResult[]>();
  for (const result of results) {
    const key = classifyResult(result);
    const list = buckets.get(key) ?? [];
    list.push(result);
    buckets.set(key, list);
  }
  return SUBGROUP_ORDER.filter((key) => (buckets.get(key)?.length ?? 0) > 0).map((key) => ({
    key,
    results: buckets.get(key) ?? [],
  }));
}

function isCompanySearchScope(value: string | null): value is CompanySearchScope {
  return Boolean(value) && (COMPANY_SEARCH_SCOPES as readonly string[]).includes(value as string);
}

function describeScope(scope: CompanySearchScope) {
  if (scope === "all") return "All scopes";
  return SCOPE_LABELS[scope];
}

function totalMatchCount(counts: Partial<Record<CompanySearchCountType, number>>): number {
  return (
    (counts.issue ?? 0)
    + (counts.comment ?? 0)
    + (counts.document ?? 0)
    + (counts.artifact ?? 0)
    + (counts.agent ?? 0)
    + (counts.project ?? 0)
  );
}

function mergeSearchFilters(
  base: ParsedSearchQuery["filters"],
  override: ParsedSearchQuery["filters"],
): ParsedSearchQuery["filters"] {
  return { ...base, ...override };
}

export function buildSearchUrl(
  href: string,
  query: string,
  scope: CompanySearchScope,
  filters: ParsedSearchQuery["filters"] = {},
  sort: CompanySearchSort = "relevance",
): string {
  const url = new URL(href);
  if (query.length === 0) {
    url.searchParams.delete("q");
  } else {
    url.searchParams.set("q", query);
  }
  if (scope === "all") {
    url.searchParams.delete("scope");
  } else {
    url.searchParams.set("scope", scope);
  }
  applySearchFiltersToParams(url.searchParams, filters);
  if (sort === "relevance") {
    url.searchParams.delete("sort");
  } else {
    url.searchParams.set("sort", sort);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function shapeError(error: unknown): { message: string; status?: number } {
  if (!error) return { message: "Unknown error" };
  if (error instanceof Error) {
    const status = (error as Error & { status?: number }).status;
    return { message: error.message, status: typeof status === "number" ? status : undefined };
  }
  return { message: String(error) };
}

export function Search() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialogActions();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const { isMobile } = useSidebar();
  const urlQuery = searchParams.get("q") ?? "";
  const urlScopeRaw = searchParams.get("scope");
  const urlScope: CompanySearchScope = isCompanySearchScope(urlScopeRaw) ? urlScopeRaw : "all";
  const urlSort = useMemo(() => parseSearchSort(searchParams), [searchParams]);

  const [draftQuery, setDraftQuery] = useState(urlQuery);
  const [committedQuery, setCommittedQuery] = useState(urlQuery);
  const [scope, setScope] = useState<CompanySearchScope>(urlScope);
  const [sort, setSort] = useState<CompanySearchSort>(urlSort);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draftSheetFilters, setDraftSheetFilters] = useState<ParsedSearchQuery["filters"]>({});
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const lastUrlSyncRef = useRef<string>("");
  const lastIdentifierRedirectRef = useRef<string>("");
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Search" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    setRecentSearches(loadRecentSearches(selectedCompanyId));
  }, [selectedCompanyId]);

  // Pull URL changes back into local state (e.g. browser back/forward).
  useEffect(() => {
    setDraftQuery(urlQuery);
    setCommittedQuery(urlQuery);
  }, [urlQuery]);

  useEffect(() => {
    setScope(urlScope);
  }, [urlScope]);

  useEffect(() => {
    setSort(urlSort);
  }, [urlSort]);

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects = [] } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: labels = [] } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const parserContext = useMemo<SearchQueryParserContext>(() => ({
    currentUserId,
    agents: agents as Agent[],
    projects: projects as Project[],
    labels: labels as IssueLabel[],
  }), [agents, currentUserId, labels, projects]);
  const parsedUrlFilters = useMemo(() => readSearchFiltersFromParams(searchParams), [searchParams]);
  const [urlFilters, setUrlFilters] = useState(parsedUrlFilters);

  useEffect(() => {
    setUrlFilters(parsedUrlFilters);
  }, [parsedUrlFilters]);
  const parsedDraftQuery = useMemo(() => parseSearchQuery(draftQuery, parserContext), [draftQuery, parserContext]);
  const parsedCommittedQuery = useMemo(() => parseSearchQuery(committedQuery, parserContext), [committedQuery, parserContext]);
  const committedOperatorFilters = parsedCommittedQuery.filters;
  const draftOperatorFilters = parsedDraftQuery.filters;
  const activeFilters = useMemo(
    () => mergeSearchFilters(urlFilters, committedOperatorFilters),
    [committedOperatorFilters, urlFilters],
  );
  const draftFilters = useMemo(
    () => mergeSearchFilters(urlFilters, draftOperatorFilters),
    [draftOperatorFilters, urlFilters],
  );

  // Debounce the draft query into committedQuery and write parsed filters to URL via replaceState.
  useEffect(() => {
    if (draftQuery === committedQuery) return;
    const handle = window.setTimeout(() => {
      setCommittedQuery(draftQuery);
      if (typeof window !== "undefined") {
        // Typed operators live only in the query text and are never folded into
        // urlFilters, so deleting a token drops its filter from the next request.
        // The URL still carries the merged view for reload/back-forward persistence.
        const next = buildSearchUrl(window.location.href, parsedDraftQuery.query, scope, draftFilters, sort);
        if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}` && next !== lastUrlSyncRef.current) {
          lastUrlSyncRef.current = next;
          window.history.replaceState(window.history.state, "", next);
        }
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draftFilters, draftQuery, committedQuery, parsedDraftQuery.query, scope, sort]);

  const handleScopeChange = useCallback(
    (next: string) => {
      if (!isCompanySearchScope(next) || next === scope) return;
      setScope(next);
      if (typeof window !== "undefined") {
        const url = buildSearchUrl(window.location.href, parsedCommittedQuery.query, next, activeFilters, sort);
        window.history.pushState(window.history.state, "", url);
      }
    },
    [activeFilters, parsedCommittedQuery.query, scope, sort],
  );

  const handleSortChange = useCallback(
    (next: CompanySearchSort) => {
      setSort(next);
      if (typeof window !== "undefined") {
        const url = buildSearchUrl(window.location.href, parsedCommittedQuery.query, scope, activeFilters, next);
        window.history.pushState(window.history.state, "", url);
      }
    },
    [activeFilters, parsedCommittedQuery.query, scope],
  );

  // Filter-bar / chip / sheet changes make the controls authoritative: `next`
  // already contains any operator-derived values (the controls render the merged
  // view), so strip the typed tokens from the query to keep the plain text and
  // prevent a removed filter from resurrecting out of the input.
  const handleFiltersChange = useCallback(
    (next: ParsedSearchQuery["filters"]) => {
      const plain = parsedCommittedQuery.query;
      setDraftQuery(plain);
      setCommittedQuery(plain);
      setUrlFilters(next);
      if (typeof window !== "undefined") {
        const url = buildSearchUrl(window.location.href, plain, scope, next, sort);
        window.history.pushState(window.history.state, "", url);
      }
    },
    [parsedCommittedQuery.query, scope, sort],
  );

  // "Clear all" drops both URL filters and any typed operator tokens (keeping the
  // plain text query), so the results snap back to the unfiltered set.
  const handleClearAllFilters = useCallback(() => {
    const plain = parsedCommittedQuery.query;
    setDraftQuery(plain);
    setCommittedQuery(plain);
    setUrlFilters({});
    if (typeof window !== "undefined") {
      const url = buildSearchUrl(window.location.href, plain, scope, {}, sort);
      window.history.replaceState(window.history.state, "", url);
    }
  }, [parsedCommittedQuery.query, scope, sort]);

  const trimmedQuery = parsedCommittedQuery.query.trim();
  const displayQuery = committedQuery.trim();
  const queryEnabled = !!selectedCompanyId && (trimmedQuery.length > 0 || hasSearchFilters(activeFilters));

  const { data, isFetching, error, refetch } = useQuery<CompanySearchResponse>({
    queryKey: [
      ...queryKeys.companySearch.search(
        selectedCompanyId ?? "__no-company__",
        trimmedQuery,
        scope,
        COMPANY_SEARCH_DEFAULT_LIMIT,
        0,
      ),
      activeFilters,
      sort,
    ] as const,
    queryFn: () =>
      searchApi.search(selectedCompanyId!, {
        q: trimmedQuery,
        scope,
        limit: COMPANY_SEARCH_DEFAULT_LIMIT,
        ...activeFilters,
        ...(sort !== "relevance" ? { sort } : {}),
      }),
    enabled: queryEnabled,
    placeholderData: (previousData) => previousData,
  });

  const agentsById = useMemo<ReadonlyMap<string, Pick<Agent, "id" | "name">>>(() => {
    const map = new Map<string, Pick<Agent, "id" | "name">>();
    for (const agent of agents) map.set(agent.id, agent);
    return map;
  }, [agents]);

  const projectsById = useMemo(() => new Map((projects as Project[]).map((p) => [p.id, p])), [projects]);
  const labelsById = useMemo(() => new Map((labels as IssueLabel[]).map((l) => [l.id, l])), [labels]);

  const filterLookups = useMemo<FilterChipLookups>(
    () => ({
      agentName: (id) => agentsById.get(id)?.name,
      userName: () => undefined,
      projectName: (id) => projectsById.get(id)?.name,
      labelName: (id) => labelsById.get(id)?.name,
      currentUserId,
    }),
    [agentsById, projectsById, labelsById, currentUserId],
  );

  const filterData = useMemo<SearchFilterDataProps>(
    () => ({
      counts: data?.filterOptionCounts,
      agents: agents as Agent[],
      projects: projects as Project[],
      labels: labels as IssueLabel[],
      currentUserId,
    }),
    [data?.filterOptionCounts, agents, projects, labels, currentUserId],
  );

  const filtersActive = hasSearchFilters(activeFilters);
  const activeFilterCount = countActiveFilters(activeFilters);

  // Preview query for the mobile bottom sheet: run the draft filters so the apply
  // button can show "Show N results" before the user commits.
  const { data: previewData } = useQuery<CompanySearchResponse>({
    queryKey: [
      ...queryKeys.companySearch.search(
        selectedCompanyId ?? "__no-company__",
        trimmedQuery,
        scope,
        COMPANY_SEARCH_DEFAULT_LIMIT,
        0,
      ),
      "preview",
      draftSheetFilters,
      sort,
    ] as const,
    queryFn: () =>
      searchApi.search(selectedCompanyId!, {
        q: trimmedQuery,
        scope,
        limit: COMPANY_SEARCH_DEFAULT_LIMIT,
        ...draftSheetFilters,
        ...(sort !== "relevance" ? { sort } : {}),
      }),
    enabled: queryEnabled && sheetOpen,
    placeholderData: (previousData) => previousData,
  });

  // Persist recent searches once we have a successful response with a non-empty query.
  useEffect(() => {
    if (!selectedCompanyId) return;
    if (!data || !displayQuery) return;
    const next = pushRecentSearch(selectedCompanyId, displayQuery);
    setRecentSearches(next);
  }, [data, displayQuery, selectedCompanyId]);

  // Identifier shortcut: when q matches PAP-123 and the API returns an exact identifier match, redirect to it.
  useEffect(() => {
    if (!data) return;
    const upper = trimmedQuery.toUpperCase();
    if (!IDENTIFIER_PATTERN.test(upper)) return;
    if (lastIdentifierRedirectRef.current === upper) return;
    const exact = data.results.find(
      (result) => result.type === "issue" && result.issue?.identifier?.toUpperCase() === upper,
    );
    if (!exact?.issue) return;
    lastIdentifierRedirectRef.current = upper;
    // Strip the comment/document deep-link suffix so an exact identifier match
    // lands on the issue root, not the top-scored snippet.
    const baseHref = exact.href.split("#")[0] ?? exact.href;
    const navigateHref = baseHref.startsWith("/") ? baseHref : `/${baseHref}`;
    navigate(navigateHref, { replace: true });
  }, [data, navigate, trimmedQuery]);

  const handleClear = useCallback(() => {
    setDraftQuery("");
    setCommittedQuery("");
    inputRef.current?.focus();
    if (typeof window !== "undefined") {
      setUrlFilters({});
      const next = buildSearchUrl(window.location.href, "", scope, {});
      window.history.replaceState(window.history.state, "", next);
    }
  }, [scope]);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // Global "/" focus shortcut.
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (target?.isContentEditable || tag === "input" || tag === "textarea") return;
      event.preventDefault();
      focusInput();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusInput]);

  const counts = data?.countsByType ?? { issue: 0, comment: 0, document: 0, artifact: 0, agent: 0, project: 0 };
  const totalResults = data?.results.length ?? 0;
  const allMatchTotal = data ? totalMatchCount(counts) : 0;
  const previewTotal = previewData ? totalMatchCount(previewData.countsByType) : null;

  const tabItems = useMemo<PageTabItem[]>(() => {
    function pill(value: number) {
      if (!data) return null;
      return (
        <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-(length:--text-nano) tabular-nums font-normal">
          {value}
        </Badge>
      );
    }
    const issuesTotal = counts.issue ?? 0;
    return COMPANY_SEARCH_SCOPES.map((value) => {
      let count: number | null = null;
      if (value === "all") {
        count = (counts.issue ?? 0)
          + (counts.comment ?? 0)
          + (counts.document ?? 0)
          + (counts.artifact ?? 0)
          + (counts.agent ?? 0)
          + (counts.project ?? 0);
      } else if (value === "issues") count = issuesTotal;
      else if (value === "comments") count = counts.comment ?? 0;
      else if (value === "documents") count = counts.document ?? 0;
      else if (value === "artifacts") count = counts.artifact ?? 0;
      else if (value === "agents") count = counts.agent ?? 0;
      else if (value === "projects") count = counts.project ?? 0;
      // Issue-only filters don't constrain agents/projects, so show a dash there
      // rather than an unfiltered count that would misrepresent the result set.
      const dashOut = filtersActive && (value === "agents" || value === "projects");
      return {
        value,
        label: (
          <span className="flex items-center">
            {SCOPE_LABELS[value as CompanySearchScope]}
            {dashOut ? (
              <span className="ml-1.5 text-(length:--text-nano) text-muted-foreground">—</span>
            ) : count !== null ? (
              pill(count)
            ) : null}
          </span>
        ),
      } satisfies PageTabItem;
    });
  }, [counts, data, filtersActive]);

  const subgroups = useMemo(() => buildSubgroups(data?.results ?? []), [data?.results]);

  const operatorPills = useMemo(() => searchFilterPills(draftFilters, parserContext), [draftFilters, parserContext]);
  const operatorSuggestions = useMemo(
    () => (inputFocused ? searchOperatorSuggestions(draftQuery, 4) : []),
    [draftQuery, inputFocused],
  );
  const showInitialState = !displayQuery && !hasSearchFilters(activeFilters);
  const isLoading = queryEnabled && isFetching && !data;
  const hasResults = !!data && totalResults > 0;
  const isEmpty = !!data && !isFetching && totalResults === 0;
  const hasError = !!error && !isLoading;
  const apiError = hasError ? shapeError(error) : null;
  const apiMessage = data?.results === undefined && data ? null : null;
  void apiMessage;

  // Zero-results recovery (wireframe screen 4) is only meaningful when active
  // filters are what emptied the page; the backend signals that via `zeroResults`.
  const zeroResultsSlot: ReactNode = data?.zeroResults ? (
    <ZeroResultsRecovery
      query={displayQuery || trimmedQuery}
      filters={activeFilters}
      zeroResults={data.zeroResults}
      lookups={filterLookups}
      onChange={handleFiltersChange}
      onClearAll={handleClearAllFilters}
    />
  ) : null;

  function navigateIssuesFallback() {
    const fallbackQuery = trimmedQuery || displayQuery;
    navigate(fallbackQuery ? `/issues?q=${encodeURIComponent(fallbackQuery)}` : "/issues");
  }

  function handleRecentClick(value: string) {
    setDraftQuery(value);
    setCommittedQuery(value);
    if (typeof window !== "undefined") {
      setUrlFilters({});
      const next = buildSearchUrl(window.location.href, value, scope, {});
      window.history.replaceState(window.history.state, "", next);
    }
  }

  function showAllScope() {
    if (scope === "all") return;
    handleScopeChange("all");
  }

  const searchDisplayLabel = displayQuery || operatorPills.map((pill) => pill.label).join(" ");

  return (
    <div className="flex h-full min-h-0 flex-col" data-page="search">
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <h1 className="sr-only">Search</h1>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            autoFocus
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.currentTarget.value)}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                if (draftQuery.length > 0) {
                  event.preventDefault();
                  handleClear();
                } else {
                  event.currentTarget.blur();
                }
              }
            }}
            placeholder="Search tasks, comments, documents, artifacts, agents, projects…"
            aria-label="Search query"
            className="h-10 pl-9 pr-20 text-sm"
          />
          {draftQuery.length > 0 ? (
            <button
              type="button"
              onClick={handleClear}
              aria-label="Clear search"
              className="absolute right-12 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-accent/50"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <kbd
            aria-hidden
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 text-(length:--text-nano) font-medium text-muted-foreground"
          >
            ⌘K
          </kbd>
        </div>
        <div className="mt-2 flex min-h-6 flex-wrap items-center gap-1.5 text-(length:--text-micro) text-muted-foreground">
          {operatorPills.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="search-operator-pills">
              {operatorPills.map((pill) => (
                <Badge key={`${pill.key}:${pill.value}`} variant="outline" className="px-1.5 py-0 text-(length:--text-micro) font-normal normal-case">
                  {pill.label}
                </Badge>
              ))}
            </div>
          ) : null}
          {operatorSuggestions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="search-operator-suggestions">
              {operatorSuggestions.map((suggestion) => (
                <button
                  key={suggestion.token}
                  type="button"
                  aria-label={`Insert operator ${suggestion.token}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setDraftQuery(applySearchOperatorSuggestion(draftQuery, suggestion.token));
                    inputRef.current?.focus();
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 hover:bg-accent/60"
                >
                  <span className="font-mono text-(length:--text-micro)">{suggestion.token}</span>
                  <span className="hidden text-(length:--text-micro) sm:inline">{suggestion.description}</span>
                </button>
              ))}
            </div>
          ) : (
            <span className="truncate">
              Try <code className="rounded bg-muted px-1 py-0.5 text-(length:--text-micro)">status:todo</code>,{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-(length:--text-micro)">assignee:me</code>,{" "}
              or <code className="rounded bg-muted px-1 py-0.5 text-(length:--text-micro)">updated:&gt;7d</code>.
            </span>
          )}
        </div>
      </div>

      <Tabs value={scope} onValueChange={handleScopeChange} className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border px-2 sm:px-4">
          <PageTabBar items={tabItems} value={scope} onValueChange={handleScopeChange} align="start" />
        </div>

        {!showInitialState ? (
          <div className="flex flex-col gap-2 border-b border-border px-2 py-2 sm:px-4" data-testid="search-filters">
            {isMobile ? (
              <div className="flex items-center gap-2">
                <SearchFilterSheetTrigger activeCount={activeFilterCount} onClick={() => setSheetOpen(true)} />
                <div className="ml-auto">
                  <SearchSortMenu value={sort} onChange={handleSortChange} />
                </div>
              </div>
            ) : (
              <SearchFilterBar
                filters={activeFilters}
                onChange={handleFiltersChange}
                sort={sort}
                onSortChange={handleSortChange}
                data={filterData}
              />
            )}
            <SearchFilterChips
              filters={activeFilters}
              lookups={filterLookups}
              onChange={handleFiltersChange}
              onClearAll={handleClearAllFilters}
            />
          </div>
        ) : null}

        {COMPANY_SEARCH_SCOPES.map((scopeValue) => (
          <TabsContent
            key={scopeValue}
            value={scopeValue}
            className="flex h-full min-h-0 flex-col overflow-y-auto"
          >
            {scopeValue === scope ? (
              <SearchTabContent
                showInitialState={showInitialState}
                isLoading={isLoading}
                hasResults={hasResults}
                hasError={hasError}
                apiError={apiError}
                isEmpty={isEmpty}
                trimmedQuery={searchDisplayLabel}
                scope={scope}
                showAllScope={showAllScope}
                navigateIssuesFallback={navigateIssuesFallback}
                openNewIssue={() => openNewIssue({ title: searchDisplayLabel })}
                refetch={() => void refetch()}
                recentSearches={recentSearches}
                onRecentClick={handleRecentClick}
                subgroups={subgroups}
                totalResults={totalResults}
                allMatchTotal={allMatchTotal}
                activeFilterCount={activeFilterCount}
                sortLabel={SORT_LABELS[sort]}
                zeroResultsSlot={zeroResultsSlot}
                isFetching={isFetching && !!data}
                agentsById={agentsById}
              />
            ) : null}
          </TabsContent>
        ))}
      </Tabs>

      {isMobile ? (
        <SearchFilterSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          filters={activeFilters}
          onApply={handleFiltersChange}
          onDraftChange={setDraftSheetFilters}
          previewTotal={previewTotal}
          data={filterData}
          sort={sort}
          onSortChange={handleSortChange}
        />
      ) : null}
    </div>
  );
}

interface SearchTabContentProps {
  showInitialState: boolean;
  isLoading: boolean;
  hasResults: boolean;
  hasError: boolean;
  apiError: { message: string; status?: number } | null;
  isEmpty: boolean;
  trimmedQuery: string;
  scope: CompanySearchScope;
  showAllScope: () => void;
  navigateIssuesFallback: () => void;
  openNewIssue: () => void;
  refetch: () => void;
  recentSearches: string[];
  onRecentClick: (query: string) => void;
  subgroups: Array<{ key: SubGroupKey; results: CompanySearchResult[] }>;
  totalResults: number;
  allMatchTotal: number;
  activeFilterCount: number;
  sortLabel: string;
  zeroResultsSlot: ReactNode;
  isFetching: boolean;
  agentsById: ReadonlyMap<string, Pick<Agent, "id" | "name">>;
}

function SearchTabContent({
  showInitialState,
  isLoading,
  hasResults,
  hasError,
  apiError,
  isEmpty,
  trimmedQuery,
  scope,
  showAllScope,
  navigateIssuesFallback,
  openNewIssue,
  refetch,
  recentSearches,
  onRecentClick,
  subgroups,
  totalResults,
  allMatchTotal,
  activeFilterCount,
  sortLabel,
  zeroResultsSlot,
  isFetching,
  agentsById,
}: SearchTabContentProps) {
  if (showInitialState) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10 sm:px-6">
        <div>
          <h2 className="text-lg font-semibold">Type to search company memory.</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Tasks, comments, plan documents, artifacts, agents, projects — same surface, ranked by relevance.
          </p>
        </div>
        {recentSearches.length > 0 ? (
          <div>
            <div className="mb-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
              Recent searches
            </div>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {recentSearches.map((entry) => (
                <li key={entry}>
                  <button
                    type="button"
                    onClick={() => onRecentClick(entry)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/40"
                  >
                    <SearchIcon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="flex-1 truncate">{entry}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">Identifier lookup:</span> type{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-(length:--text-micro)">PAP-123</code> to jump straight to a task.
          </li>
          <li>
            <span className="font-medium text-foreground">Quoted phrases:</span> wrap a phrase in quotes to match the
            exact sequence.
          </li>
          <li>
            <span className="font-medium text-foreground">⌘K:</span> reopens the command palette pre-seeded with your
            current query.
          </li>
        </ul>
      </div>
    );
  }

  if (hasError) {
    const status = apiError?.status;
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col items-center justify-center gap-3 px-4 py-12 text-center">
        <AlertTriangle className="h-10 w-10 text-destructive" aria-hidden />
        <div className="text-base font-semibold">Couldn’t run that search</div>
        <p className="text-sm text-muted-foreground">
          {status ? `The server returned ${status}.` : "The request failed."} Your input and filters are still here, so
          you can retry or fall back to the Tasks filter.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={refetch} variant="default" size="sm">
            Retry
          </Button>
          <Button onClick={navigateIssuesFallback} variant="outline" size="sm">
            Open Tasks filter view
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 px-2 py-3 sm:px-4">
        <div className="px-3 text-xs text-muted-foreground" data-testid="search-loading">
          Searching for &ldquo;{trimmedQuery}&rdquo;…
        </div>
        <div className="flex flex-col">
          <div className="px-3 py-2">
            <Skeleton className="h-3 w-24" />
          </div>
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="flex items-start gap-3 px-3 py-2">
              <Skeleton className="mt-1 h-4 w-4 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (isEmpty) {
    // Filters emptied the page → recovery UI (screen 4). Plain zero-results keeps
    // the tips card below.
    if (zeroResultsSlot) return zeroResultsSlot;
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col items-center justify-center gap-3 px-4 py-12 text-center">
        <FileQuestion className="h-10 w-10 text-muted-foreground" aria-hidden />
        <div className="text-base font-semibold">No results for &ldquo;{trimmedQuery}&rdquo;</div>
        <p className="text-sm text-muted-foreground">
          We couldn’t find a match in {describeScope(scope).toLowerCase()}. Try widening the scope or rephrasing your
          query.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {scope !== "all" ? (
            <Button onClick={showAllScope} size="sm" variant="outline">
              Search all scopes
            </Button>
          ) : null}
          <Button onClick={openNewIssue} size="sm" variant="default">
            <Plus className="mr-1.5 h-4 w-4" />
            Create task from this query
          </Button>
          <Button onClick={navigateIssuesFallback} size="sm" variant="ghost">
            Open Tasks filter view
          </Button>
        </div>
        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          <li>Try fewer tokens or a single distinctive term.</li>
          <li>
            Use an identifier shortcut like <code className="rounded bg-muted px-1 py-0.5">PAP-123</code>.
          </li>
          <li>Wrap multi-word phrases in quotes.</li>
        </ul>
      </div>
    );
  }

  if (!hasResults) return null;

  return (
    <div className="flex w-full max-w-(--sz-960px) flex-col px-2 sm:px-4" data-testid="search-results">
      <div className="flex items-center justify-between py-2 text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
        <span>
          {allMatchTotal > totalResults
            ? `${totalResults} of ${allMatchTotal} results`
            : totalResults === 1
              ? "1 result"
              : `${totalResults} results`}
          {` · sorted by ${sortLabel}`}
          {activeFilterCount > 0
            ? ` · ${activeFilterCount} ${activeFilterCount === 1 ? "filter" : "filters"} active`
            : ""}
        </span>
        {isFetching ? <span aria-live="polite" className="normal-case tracking-normal">Updating…</span> : null}
      </div>
      <div className="flex flex-col pb-10">
        {scope === "all" ? (
          subgroups.map((group, groupIndex) => (
            <section
              key={group.key}
              aria-label={SUBGROUP_LABELS[group.key]}
              className={cn("flex flex-col", groupIndex > 0 && "mt-6")}
            >
              <IssueGroupHeader
                label={SUBGROUP_LABELS[group.key]}
                trailing={
                  <span className="text-xs font-normal tabular-nums text-muted-foreground">
                    {group.results.length}
                  </span>
                }
                className="pt-2 pb-1 text-(length:--text-micro) tracking-wider text-muted-foreground"
              />
              <div className="flex flex-col gap-y-1">
                {group.results.map((result) => (
                  <SearchResultRow
                    key={`${result.type}:${result.id}:${result.href}`}
                    result={result}
                    agentsById={agentsById}
                  />
                ))}
              </div>
            </section>
          ))
        ) : (
          <div className="flex flex-col gap-y-1">
            {subgroups
              .flatMap((group) => group.results)
              .map((result) => (
                <SearchResultRow
                  key={`${result.type}:${result.id}:${result.href}`}
                  result={result}
                  agentsById={agentsById}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
