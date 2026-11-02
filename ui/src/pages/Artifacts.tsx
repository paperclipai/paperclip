import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowLeft, Layers, Package } from "lucide-react";
import type { To } from "react-router-dom";
import {
  artifactsApi,
  type ArtifactGroupBy,
  type ArtifactKindFilter,
} from "../api/artifacts";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ArtifactCard } from "../components/artifacts/ArtifactCard";
import { ArtifactGroupCard } from "../components/artifacts/ArtifactGroupCard";
import { useSearchParams, Link } from "@/lib/router";
import { ArtifactsToolbar, ARTIFACT_KIND_FILTERS } from "@/components/artifacts/ArtifactsToolbar";
import { ArtifactSingleTile, ArtifactStackTile, ArtifactTileGrid, ArtifactsV1Filters, artifactsV1View, subjectFromCompanyArtifact, type ArtifactsV1View } from "@/components/artifacts/v1";
import { useArtifactsV1Enabled } from "@/hooks/useArtifactsV1Enabled";
export { ARTIFACT_KIND_FILTERS, ARTIFACT_GROUP_OPTIONS, artifactGroupByLabel } from "@/components/artifacts/ArtifactsToolbar";

const ARTIFACTS_PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 250;

const KIND_VALUES = new Set(ARTIFACT_KIND_FILTERS.map((filter) => filter.value));

function parseGroupBy(value: string | null): ArtifactGroupBy {
  if (value === "none" || value === "task" || value === "parent_task") return value;
  return "task";
}

function parseKind(value: string | null): ArtifactKindFilter {
  return value && KIND_VALUES.has(value as ArtifactKindFilter)
    ? (value as ArtifactKindFilter)
    : "all";
}

export function Artifacts() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const { enabled: v1 } = useArtifactsV1Enabled();
  const kind = parseKind(searchParams.get("kind"));
  const query = searchParams.get("q") ?? "";
  const urlGroupBy = parseGroupBy(searchParams.get("groupBy"));
  // Artifacts V1 has one row of views: a kind is always a flat view, so a kind in the URL
  // overrides a grouping there — the view row then says what the page shows.
  const groupBy: ArtifactGroupBy = v1 && kind !== "all" ? "none" : urlGroupBy;
  const groupIssueId = searchParams.get("groupIssueId") ?? undefined;

  const [draftQuery, setDraftQuery] = useState(query);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const grouping = groupBy !== "none";
  const viewingStackList = grouping && !groupIssueId;
  const viewingSelectedStack = grouping && !!groupIssueId;

  // Keep the search box in sync when the committed query changes from outside
  // (e.g. back/forward navigation or a shared URL), without clobbering in-flight
  // typing (which leaves `query` unchanged until the debounce commits).
  useEffect(() => {
    setDraftQuery((prev) => (prev.trim() === query ? prev : query));
  }, [query]);

  // Debounce the search box into the `q` URL param so searches are shareable.
  useEffect(() => {
    const trimmed = draftQuery.trim();
    if (trimmed === query) return;
    const handle = window.setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (trimmed) next.set("q", trimmed);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draftQuery, query, setSearchParams]);

  const updateParams = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        mutate(next);
        return next;
      });
    },
    [setSearchParams],
  );

  const selectKind = useCallback(
    (value: ArtifactKindFilter) => {
      updateParams((next) => {
        if (value === "all") next.delete("kind");
        else next.set("kind", value);
      });
    },
    [updateParams],
  );

  // Artifacts V1: one row of views. Tasks is the task grouping; every other
  // view is the flat list, filtered by kind. Either way the open stack closes.
  const selectV1View = useCallback(
    (view: ArtifactsV1View) => {
      updateParams((next) => {
        next.delete("groupIssueId");
        if (view === "tasks") {
          next.delete("groupBy");
          next.delete("kind");
          return;
        }
        next.set("groupBy", "none");
        if (view === "all") next.delete("kind");
        else next.set("kind", view);
      });
    },
    [updateParams],
  );

  const selectGroupBy = useCallback(
    (value: ArtifactGroupBy) => {
      updateParams((next) => {
        // Switching the grouping mode always returns to the stack list.
        next.delete("groupIssueId");
        if (value === "task") next.delete("groupBy");
        else next.set("groupBy", value);
        // Artifacts V1: a grouping is the Tasks view, which carries no kind filter.
        if (v1 && value !== "none") next.delete("kind");
      });
    },
    [updateParams, v1],
  );

  // Build a relative `To` that preserves the active filters/search while
  // changing only the grouping selection. A bare query string keeps the current
  // pathname (the company-prefixed /artifacts route) and stays linkable.
  const buildTo = useCallback(
    (mutate: (next: URLSearchParams) => void): To => {
      const next = new URLSearchParams(searchParams);
      mutate(next);
      const serialized = next.toString();
      return serialized ? `?${serialized}` : "?";
    },
    [searchParams],
  );

  const stackTo = useCallback(
    (issueId: string): To =>
      buildTo((next) => {
        if (groupBy === "task") next.delete("groupBy");
        else if (groupBy !== "none") next.set("groupBy", groupBy);
        next.set("groupIssueId", issueId);
      }),
    [buildTo, groupBy],
  );

  const backToStacksTo = useMemo<To>(
    () =>
      buildTo((next) => {
        if (groupBy === "task") next.delete("groupBy");
        next.delete("groupIssueId");
      }),
    [buildTo, groupBy],
  );

  const {
    data,
    isLoading,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    error,
  } = useInfiniteQuery({
    queryKey: queryKeys.artifacts.list(selectedCompanyId!, kind, query, groupBy, groupIssueId),
    queryFn: ({ pageParam }) =>
      artifactsApi.list(selectedCompanyId!, {
        kind,
        q: query || undefined,
        groupBy,
        groupIssueId,
        limit: ARTIFACTS_PAGE_SIZE,
        cursor: pageParam,
      }),
    enabled: !!selectedCompanyId,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasNextPage || isFetchingNextPage) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void fetchNextPage();
      }
    }, { rootMargin: "320px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const artifacts = useMemo(() => data?.pages.flatMap((page) => page.artifacts) ?? [], [data]);
  const groups = useMemo(
    () => data?.pages.flatMap((page) => page.groups ?? []) ?? [],
    [data],
  );
  const selectedGroup = useMemo(
    () => data?.pages.map((page) => page.selectedGroup).find(Boolean) ?? null,
    [data],
  );
  const searching = query.length > 0;

  useEffect(() => {
    if (viewingSelectedStack && selectedGroup) {
      setBreadcrumbs([
        { label: "Artifacts", href: "/artifacts" },
        { label: `${selectedGroup.issue.identifier} · ${selectedGroup.title}` },
      ]);
    } else {
      setBreadcrumbs([{ label: "Artifacts" }]);
    }
  }, [setBreadcrumbs, viewingSelectedStack, selectedGroup]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Package} message="Select an organization to view artifacts." />;
  }

  const showGroupCards = viewingStackList;
  const items = showGroupCards ? groups : artifacts;

  const emptyMessage = showGroupCards
    ? searching
      ? "No artifact stacks match this search."
      : "No artifact stacks yet."
    : searching
      ? "No artifacts match this search."
      : viewingSelectedStack
        ? "No artifacts in this stack match the current filters."
        : kind === "all"
          ? "No artifacts yet. Outputs attached to issues will appear here."
          : "No artifacts of this type yet.";

  return (
    <div className="w-full max-w-6xl space-y-5">
      <ArtifactsToolbar
        query={draftQuery}
        onQueryChange={setDraftQuery}
        groupBy={groupBy}
        onGroupByChange={selectGroupBy}
        kind={kind}
        onKindChange={selectKind}
        filters={v1 ? <ArtifactsV1Filters view={artifactsV1View(groupBy, kind)} onViewChange={selectV1View} /> : undefined}
      />

      {viewingSelectedStack ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link
            to={backToStacksTo}
            data-testid="artifact-stack-back"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            All stacks
          </Link>
          {selectedGroup ? (
            <span className="truncate text-muted-foreground">
              <span className="text-foreground/80">{selectedGroup.issue.identifier}</span>{" "}
              {selectedGroup.title}
            </span>
          ) : null}
        </div>
      ) : null}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : items.length === 0 ? (
        <EmptyState icon={showGroupCards ? Layers : Package} message={emptyMessage} />
      ) : v1 ? (
        <>
          {/* Artifacts V1 (doc/plans/2026-10-22-artifacts-mvp-v1.md): a task with several artifacts is a stack
              whose newest artifact is the first page; a task with one, and every flat view, is a single tile. */}
          <ArtifactTileGrid>
            {showGroupCards
              ? groups.map((group) => {
                  const preview = group.previewArtifacts[0];
                  if (group.count > 1 || !preview) {
                    return (
                      <ArtifactStackTile
                        key={group.id}
                        identifier={group.issue.identifier}
                        title={group.title}
                        count={group.count}
                        updatedAt={group.updatedAt}
                        front={preview ? subjectFromCompanyArtifact(preview) : { kind: "file", title: group.title, updatedAt: group.updatedAt, taskIdentifier: group.issue.identifier }}
                        to={stackTo(group.issue.id)}
                      />
                    );
                  }
                  return <ArtifactSingleTile key={group.id} subject={subjectFromCompanyArtifact(preview)} to={preview.href} />;
                })
              : artifacts.map((artifact) => (
                  <ArtifactSingleTile key={`${artifact.source}:${artifact.id}`} subject={subjectFromCompanyArtifact(artifact)} to={artifact.href} />
                ))}
          </ArtifactTileGrid>
          <div ref={loadMoreRef} className="flex min-h-10 items-center justify-center pb-2 text-xs text-muted-foreground">
            {isFetchingNextPage ? "Loading more artifacts..." : hasNextPage ? null : isFetching ? "Updating artifacts..." : null}
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            {showGroupCards
              ? groups.map((group) => (
                  <ArtifactGroupCard key={group.id} group={group} to={stackTo(group.issue.id)} />
                ))
              : artifacts.map((artifact) => (
                  <ArtifactCard key={`${artifact.source}:${artifact.id}`} artifact={artifact} />
                ))}
          </div>
          <div ref={loadMoreRef} className="flex min-h-10 items-center justify-center pb-2 text-xs text-muted-foreground">
            {isFetchingNextPage
              ? "Loading more artifacts..."
              : hasNextPage
                ? null
                : isFetching
                  ? "Updating artifacts..."
                  : null}
          </div>
        </>
      )}
    </div>
  );
}
