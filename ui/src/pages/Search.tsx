import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search as SearchIcon, AlertTriangle, FileQuestion, Plus, X } from "lucide-react";
import {
  COMPANY_SEARCH_DEFAULT_LIMIT,
  COMPANY_SEARCH_SCOPES,
  type CompanySearchResponse,
  type CompanySearchResult,
  type CompanySearchScope,
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
import { queryKeys } from "../lib/queryKeys";
import { loadRecentSearches, pushRecentSearch } from "../lib/recent-searches";
import { PageTabBar, type PageTabItem } from "../components/PageTabBar";
import { IssueGroupHeader } from "../components/IssueGroupHeader";
import { SearchResultRow } from "../components/search/SearchResultRow";
import type { Agent } from "@paperclipai/shared";
import { t, useTranslation } from "@/i18n";

const SEARCH_DEBOUNCE_MS = 250;
const IDENTIFIER_PATTERN = /^[A-Z]+-\d+$/;

function scopeLabel(scope: CompanySearchScope): string {
  switch (scope) {
    case "all":
      return t("pages.search.scopeAll", { defaultValue: "All" });
    case "issues":
      return t("pages.search.scopeTasks", { defaultValue: "Tasks" });
    case "comments":
      return t("pages.search.scopeComments", { defaultValue: "Comments" });
    case "documents":
      return t("pages.search.scopeDocuments", { defaultValue: "Documents" });
    case "artifacts":
      return t("pages.search.scopeArtifacts", { defaultValue: "Artifacts" });
    case "agents":
      return t("pages.search.scopeAgents", { defaultValue: "Agents" });
    case "projects":
      return t("pages.search.scopeProjects", { defaultValue: "Projects" });
    default:
      return scope;
  }
}

type SubGroupKey = "issues" | "comments" | "documents" | "artifacts" | "agents" | "projects";

const SUBGROUP_ORDER: SubGroupKey[] = ["issues", "comments", "documents", "artifacts", "agents", "projects"];

function subgroupLabel(key: SubGroupKey): string {
  switch (key) {
    case "issues":
      return t("pages.search.subgroupTasks", { defaultValue: "Tasks" });
    case "comments":
      return t("pages.search.subgroupComments", { defaultValue: "Comments" });
    case "documents":
      return t("pages.search.subgroupDocuments", { defaultValue: "Documents" });
    case "artifacts":
      return t("pages.search.subgroupArtifacts", { defaultValue: "Artifacts" });
    case "agents":
      return t("pages.search.subgroupAgents", { defaultValue: "Agents" });
    case "projects":
      return t("pages.search.subgroupProjects", { defaultValue: "Projects" });
    default:
      return key;
  }
}

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
  if (scope === "all") return t("pages.search.allScopes", { defaultValue: "All scopes" });
  return scopeLabel(scope);
}

export function buildSearchUrl(href: string, query: string, scope: CompanySearchScope): string {
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
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialogActions();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const urlQuery = searchParams.get("q") ?? "";
  const urlScopeRaw = searchParams.get("scope");
  const urlScope: CompanySearchScope = isCompanySearchScope(urlScopeRaw) ? urlScopeRaw : "all";

  const [draftQuery, setDraftQuery] = useState(urlQuery);
  const [committedQuery, setCommittedQuery] = useState(urlQuery);
  const [scope, setScope] = useState<CompanySearchScope>(urlScope);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastUrlSyncRef = useRef<string>("");
  const lastIdentifierRedirectRef = useRef<string>("");
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  useEffect(() => {
    setBreadcrumbs([{ label: t("pages.search.breadcrumb", { defaultValue: "Search" }) }]);
  }, [setBreadcrumbs, t]);

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

  // Debounce the draft query into committedQuery and write to URL via replaceState.
  useEffect(() => {
    if (draftQuery === committedQuery) return;
    const handle = window.setTimeout(() => {
      setCommittedQuery(draftQuery);
      if (typeof window !== "undefined") {
        const next = buildSearchUrl(window.location.href, draftQuery, scope);
        if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}` && next !== lastUrlSyncRef.current) {
          lastUrlSyncRef.current = next;
          window.history.replaceState(window.history.state, "", next);
        }
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draftQuery, committedQuery, scope]);

  const handleScopeChange = useCallback(
    (next: string) => {
      if (!isCompanySearchScope(next) || next === scope) return;
      setScope(next);
      if (typeof window !== "undefined") {
        const url = buildSearchUrl(window.location.href, committedQuery, next);
        window.history.pushState(window.history.state, "", url);
      }
    },
    [committedQuery, scope],
  );

  const trimmedQuery = committedQuery.trim();
  const queryEnabled = !!selectedCompanyId && trimmedQuery.length > 0;

  const { data, isFetching, error, refetch } = useQuery<CompanySearchResponse>({
    queryKey: queryKeys.companySearch.search(
      selectedCompanyId ?? "__no-company__",
      trimmedQuery,
      scope,
      COMPANY_SEARCH_DEFAULT_LIMIT,
      0,
    ),
    queryFn: () =>
      searchApi.search(selectedCompanyId!, {
        q: trimmedQuery,
        scope,
        limit: COMPANY_SEARCH_DEFAULT_LIMIT,
      }),
    enabled: queryEnabled,
    placeholderData: (previousData) => previousData,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentsById = useMemo<ReadonlyMap<string, Pick<Agent, "id" | "name">>>(() => {
    const map = new Map<string, Pick<Agent, "id" | "name">>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  // Persist recent searches once we have a successful response with a non-empty query.
  useEffect(() => {
    if (!selectedCompanyId) return;
    if (!data || !trimmedQuery) return;
    const next = pushRecentSearch(selectedCompanyId, trimmedQuery);
    setRecentSearches(next);
  }, [data, trimmedQuery, selectedCompanyId]);

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
      const next = buildSearchUrl(window.location.href, "", scope);
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

  const counts = data?.countsByType ?? { issue: 0, artifact: 0, agent: 0, project: 0 };
  const totalResults = data?.results.length ?? 0;

  const tabItems = useMemo<PageTabItem[]>(() => {
    function pill(value: number) {
      if (!data) return null;
      return (
        <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-[10px] tabular-nums font-normal">
          {value}
        </Badge>
      );
    }
    const issuesTotal = counts.issue ?? 0;
    return COMPANY_SEARCH_SCOPES.map((value) => {
      let count: number | null = null;
      if (value === "all") count = (counts.issue ?? 0) + (counts.artifact ?? 0) + (counts.agent ?? 0) + (counts.project ?? 0);
      else if (value === "issues") count = issuesTotal;
      else if (value === "artifacts") count = counts.artifact ?? 0;
      else if (value === "agents") count = counts.agent ?? 0;
      else if (value === "projects") count = counts.project ?? 0;
      return {
        value,
        label: (
          <span className="flex items-center">
            {scopeLabel(value as CompanySearchScope)}
            {count !== null ? pill(count) : null}
          </span>
        ),
      } satisfies PageTabItem;
    });
  }, [counts, data]);

  const subgroups = useMemo(() => buildSubgroups(data?.results ?? []), [data?.results]);

  const showInitialState = !trimmedQuery;
  const isLoading = queryEnabled && isFetching && !data;
  const hasResults = !!data && totalResults > 0;
  const isEmpty = !!data && !isFetching && totalResults === 0;
  const hasError = !!error && !isLoading;
  const apiError = hasError ? shapeError(error) : null;
  const apiMessage = data?.results === undefined && data ? null : null;
  void apiMessage;

  function navigateIssuesFallback() {
    navigate(`/issues?q=${encodeURIComponent(trimmedQuery)}`);
  }

  function handleRecentClick(value: string) {
    setDraftQuery(value);
    setCommittedQuery(value);
    if (typeof window !== "undefined") {
      const next = buildSearchUrl(window.location.href, value, scope);
      window.history.replaceState(window.history.state, "", next);
    }
  }

  function showAllScope() {
    if (scope === "all") return;
    handleScopeChange("all");
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-page="search">
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <h1 className="sr-only">{t("pages.search.srHeading", { defaultValue: "Search" })}</h1>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            autoFocus
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.currentTarget.value)}
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
            placeholder={t("pages.search.inputPlaceholder", { defaultValue: "Search tasks, comments, documents, artifacts, agents, projects…" })}
            aria-label={t("pages.search.inputAriaLabel", { defaultValue: "Search query" })}
            className="h-10 pl-9 pr-20 text-sm"
          />
          {draftQuery.length > 0 ? (
            <button
              type="button"
              onClick={handleClear}
              aria-label={t("pages.search.clearAriaLabel", { defaultValue: "Clear search" })}
              className="absolute right-12 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-accent/50"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <kbd
            aria-hidden
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          >
            ⌘K
          </kbd>
        </div>
      </div>

      <Tabs value={scope} onValueChange={handleScopeChange} className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border px-2 sm:px-4">
          <PageTabBar items={tabItems} value={scope} onValueChange={handleScopeChange} align="start" />
        </div>

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
                trimmedQuery={trimmedQuery}
                scope={scope}
                showAllScope={showAllScope}
                navigateIssuesFallback={navigateIssuesFallback}
                openNewIssue={() => openNewIssue({ title: trimmedQuery })}
                refetch={() => void refetch()}
                recentSearches={recentSearches}
                onRecentClick={handleRecentClick}
                subgroups={subgroups}
                totalResults={totalResults}
                isFetching={isFetching && !!data}
                agentsById={agentsById}
              />
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
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
  isFetching,
  agentsById,
}: SearchTabContentProps) {
  const { t } = useTranslation();
  if (showInitialState) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10 sm:px-6">
        <div>
          <h2 className="text-lg font-semibold">{t("pages.search.initialHeading", { defaultValue: "Type to search company memory." })}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("pages.search.initialSubtitle", { defaultValue: "Tasks, comments, plan documents, artifacts, agents, projects — same surface, ranked by relevance." })}
          </p>
        </div>
        {recentSearches.length > 0 ? (
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("pages.search.recentSearches", { defaultValue: "Recent searches" })}
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
            <span className="font-medium text-foreground">{t("pages.search.tipIdentifierLabel", { defaultValue: "Identifier lookup:" })}</span>{" "}
            {t("pages.search.tipIdentifierBefore", { defaultValue: "type" })}{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">PAP-123</code>{" "}
            {t("pages.search.tipIdentifierAfter", { defaultValue: "to jump straight to a task." })}
          </li>
          <li>
            <span className="font-medium text-foreground">{t("pages.search.tipQuotedLabel", { defaultValue: "Quoted phrases:" })}</span>{" "}
            {t("pages.search.tipQuotedText", { defaultValue: "wrap a phrase in quotes to match the exact sequence." })}
          </li>
          <li>
            <span className="font-medium text-foreground">{t("pages.search.tipShortcutLabel", { defaultValue: "⌘K:" })}</span>{" "}
            {t("pages.search.tipShortcutText", { defaultValue: "reopens the command palette pre-seeded with your current query." })}
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
        <div className="text-base font-semibold">{t("pages.search.errorTitle", { defaultValue: "Couldn’t run that search" })}</div>
        <p className="text-sm text-muted-foreground">
          {status
            ? t("pages.search.errorServerStatus", { status, defaultValue: "The server returned {{status}}." })
            : t("pages.search.errorRequestFailed", { defaultValue: "The request failed." })}{" "}
          {t("pages.search.errorBody", { defaultValue: "Your input and filters are still here, so you can retry or fall back to the Tasks filter." })}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={refetch} variant="default" size="sm">
            {t("pages.search.retryButton", { defaultValue: "Retry" })}
          </Button>
          <Button onClick={navigateIssuesFallback} variant="outline" size="sm">
            {t("pages.search.openTasksFilterButton", { defaultValue: "Open Tasks filter view" })}
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 px-2 py-3 sm:px-4">
        <div className="px-3 text-xs text-muted-foreground" data-testid="search-loading">
          {t("pages.search.searchingFor", { query: trimmedQuery, defaultValue: "Searching for “{{query}}”…" })}
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
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col items-center justify-center gap-3 px-4 py-12 text-center">
        <FileQuestion className="h-10 w-10 text-muted-foreground" aria-hidden />
        <div className="text-base font-semibold">{t("pages.search.noResultsTitle", { query: trimmedQuery, defaultValue: "No results for “{{query}}”" })}</div>
        <p className="text-sm text-muted-foreground">
          {t("pages.search.noResultsBody", { scope: describeScope(scope).toLowerCase(), defaultValue: "We couldn’t find a match in {{scope}}. Try widening the scope or rephrasing your query." })}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {scope !== "all" ? (
            <Button onClick={showAllScope} size="sm" variant="outline">
              {t("pages.search.searchAllScopesButton", { defaultValue: "Search all scopes" })}
            </Button>
          ) : null}
          <Button onClick={openNewIssue} size="sm" variant="default">
            <Plus className="mr-1.5 h-4 w-4" />
            {t("pages.search.createTaskButton", { defaultValue: "Create task from this query" })}
          </Button>
          <Button onClick={navigateIssuesFallback} size="sm" variant="ghost">
            {t("pages.search.openTasksFilterButton", { defaultValue: "Open Tasks filter view" })}
          </Button>
        </div>
        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          <li>{t("pages.search.emptyTipFewerTokens", { defaultValue: "Try fewer tokens or a single distinctive term." })}</li>
          <li>
            {t("pages.search.emptyTipIdentifierBefore", { defaultValue: "Use an identifier shortcut like" })}{" "}
            <code className="rounded bg-muted px-1 py-0.5">PAP-123</code>.
          </li>
          <li>{t("pages.search.emptyTipQuotes", { defaultValue: "Wrap multi-word phrases in quotes." })}</li>
        </ul>
      </div>
    );
  }

  if (!hasResults) return null;

  return (
    <div className="flex w-full max-w-[960px] flex-col px-2 sm:px-4" data-testid="search-results">
      <div className="flex items-center justify-between py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>
          {t("pages.search.resultsSummary", { count: totalResults, defaultValue: "{{count}} result · sorted by relevance" })}
        </span>
        {isFetching ? <span aria-live="polite" className="normal-case tracking-normal">{t("pages.search.updating", { defaultValue: "Updating…" })}</span> : null}
      </div>
      <div className="flex flex-col pb-10">
        {scope === "all" ? (
          subgroups.map((group, groupIndex) => (
            <section
              key={group.key}
              aria-label={subgroupLabel(group.key)}
              className={cn("flex flex-col", groupIndex > 0 && "mt-6")}
            >
              <IssueGroupHeader
                label={subgroupLabel(group.key)}
                trailing={
                  <span className="text-xs font-normal tabular-nums text-muted-foreground">
                    {group.results.length}
                  </span>
                }
                className="pt-2 pb-1 text-[11px] tracking-wider text-muted-foreground"
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
