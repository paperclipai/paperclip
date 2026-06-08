import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, FileText, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import type { DocumentStatus, DocumentType } from "@paperclipai/shared";
import { DOCUMENT_STATUSES, DOCUMENT_TYPES } from "@paperclipai/shared";
import { documentsApi, type CompanyDocumentListFilters } from "../api/documents";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { DocumentRow, type DocumentOwner } from "../components/documents/DocumentRow";
import { useSearchParams } from "@/lib/router";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SEARCH_DEBOUNCE_MS = 250;

const STATUS_LABELS: Record<DocumentStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  archived: "Archived",
};

const TYPE_LABELS: Record<DocumentType, string> = {
  plan: "Plan",
  spec: "Spec",
  brief: "Brief",
  report: "Report",
  other: "Other",
};

type SortOption = "updated_desc" | "updated_asc" | "title_asc" | "feedback_desc" | "status";

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "updated_desc", label: "Updated (newest)" },
  { value: "updated_asc", label: "Updated (oldest)" },
  { value: "title_asc", label: "Title (A–Z)" },
  { value: "feedback_desc", label: "Open feedback" },
  { value: "status", label: "Status" },
];

const SORT_LABELS: Record<SortOption, string> = {
  updated_desc: "Updated ↓",
  updated_asc: "Updated ↑",
  title_asc: "Title A–Z",
  feedback_desc: "Most feedback",
  status: "Status",
};

function parseMulti<T extends string>(values: string[], allowed: readonly T[]): T[] {
  const set = new Set<string>(allowed);
  return values.filter((value): value is T => set.has(value));
}

function parseSort(value: string | null): SortOption {
  return SORT_OPTIONS.some((option) => option.value === value)
    ? (value as SortOption)
    : "updated_desc";
}

const STATUS_ORDER: Record<DocumentStatus, number> = {
  draft: 0,
  in_review: 1,
  approved: 2,
  archived: 3,
};

export function Documents() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();

  const query = searchParams.get("q") ?? "";
  const statusFilter = useMemo(
    () => parseMulti(searchParams.getAll("status"), DOCUMENT_STATUSES),
    [searchParams],
  );
  const typeFilter = useMemo(
    () => parseMulti(searchParams.getAll("type"), DOCUMENT_TYPES),
    [searchParams],
  );
  const ownerFilter = searchParams.get("owner") ?? undefined;
  const hasFeedback = searchParams.get("feedback") === "1";
  const trustedOnly = searchParams.get("trusted") === "1";
  const includeArchived = statusFilter.includes("archived");
  const sort = parseSort(searchParams.get("sort"));
  const linkedFilter = searchParams.get("linked") ?? "";

  const [draftQuery, setDraftQuery] = useState(query);
  const [draftLinked, setDraftLinked] = useState(linkedFilter);

  useEffect(() => {
    setBreadcrumbs([{ label: "Documents" }]);
  }, [setBreadcrumbs]);

  // Keep the search box synced when `q` changes from outside (back/forward).
  useEffect(() => {
    setDraftQuery((prev) => (prev.trim() === query ? prev : query));
  }, [query]);

  // Keep linked input synced with URL param.
  useEffect(() => {
    setDraftLinked((prev) => (prev.trim() === linkedFilter ? prev : linkedFilter));
  }, [linkedFilter]);

  // Debounce the search box into the `q` URL param.
  useEffect(() => {
    const trimmed = draftQuery.trim();
    if (trimmed === query) return;
    const timer = setTimeout(() => {
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
    return () => clearTimeout(timer);
  }, [draftQuery, query, setSearchParams]);

  // Debounce the linked input into the `linked` URL param.
  useEffect(() => {
    const trimmed = draftLinked.trim();
    if (trimmed === linkedFilter) return;
    const timer = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (trimmed) next.set("linked", trimmed);
          else next.delete("linked");
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftLinked, linkedFilter, setSearchParams]);

  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        mutate(next);
        return next;
      });
    },
    [setSearchParams],
  );

  const toggleMulti = useCallback(
    (key: "status" | "type", value: string) => {
      updateParams((params) => {
        const current = params.getAll(key);
        params.delete(key);
        const next = current.includes(value)
          ? current.filter((entry) => entry !== value)
          : [...current, value];
        for (const entry of next) params.append(key, entry);
      });
    },
    [updateParams],
  );

  const toggleFlag = useCallback(
    (key: "feedback" | "trusted") => {
      updateParams((params) => {
        if (params.get(key) === "1") params.delete(key);
        else params.set(key, "1");
      });
    },
    [updateParams],
  );

  const setSort = useCallback(
    (value: SortOption) => {
      updateParams((params) => {
        if (value === "updated_desc") params.delete("sort");
        else params.set("sort", value);
      });
    },
    [updateParams],
  );

  const clearFilters = useCallback(() => {
    setDraftQuery("");
    setDraftLinked("");
    setSearchParams({}, { replace: true });
  }, [setSearchParams]);

  const filters: CompanyDocumentListFilters = useMemo(
    () => ({
      q: query || undefined,
      status: statusFilter.length > 0 ? statusFilter : undefined,
      type: typeFilter.length > 0 ? typeFilter : undefined,
      ownerAgentId: ownerFilter,
      hasOpenFeedback: hasFeedback || undefined,
      trustedOnly: trustedOnly || undefined,
      includeArchived: includeArchived || undefined,
      limit: 100,
    }),
    [query, statusFilter, typeFilter, ownerFilter, hasFeedback, trustedOnly, includeArchived],
  );

  const {
    data: documents,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.documents.list(selectedCompanyId!, filters as Record<string, unknown>),
    queryFn: () => documentsApi.list(selectedCompanyId!, filters),
    enabled: !!selectedCompanyId,
    placeholderData: (previous) => previous,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const ownerById = useMemo(() => {
    const map = new Map<string, DocumentOwner>();
    for (const agent of agents ?? []) {
      map.set(agent.id, { name: agent.name });
    }
    return map;
  }, [agents]);

  const sortedDocuments = useMemo(() => {
    const list = [...(documents ?? [])];
    list.sort((a, b) => {
      switch (sort) {
        case "updated_asc":
          return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        case "title_asc":
          return (a.title ?? "").localeCompare(b.title ?? "");
        case "feedback_desc": {
          const open = (doc: typeof a) =>
            doc.feedbackCounts.openComments +
            doc.feedbackCounts.openReviewThreads +
            doc.feedbackCounts.pendingSuggestions;
          return open(b) - open(a);
        }
        case "status":
          return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        case "updated_desc":
        default:
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
    });
    return list;
  }, [documents, sort]);

  const displayDocuments = linkedFilter.trim()
    ? sortedDocuments.filter((doc) =>
        doc.backlinks.some((bl) =>
          (bl.identifier ?? "").toLowerCase().includes(linkedFilter.trim().toLowerCase()),
        ),
      )
    : sortedDocuments;

  const activeFilterCount =
    statusFilter.length +
    typeFilter.length +
    (ownerFilter ? 1 : 0) +
    (hasFeedback ? 1 : 0) +
    (trustedOnly ? 1 : 0) +
    (linkedFilter.trim() ? 1 : 0);
  const hasActiveFilters = activeFilterCount > 0 || query.length > 0;

  if (!selectedCompanyId) {
    return <EmptyState icon={FileText} message="Select a company to view documents." />;
  }

  const ownerAgent = ownerFilter ? ownerById.get(ownerFilter) : undefined;

  return (
    <div className="w-full max-w-5xl space-y-4">
      {/* Search + filter controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.currentTarget.value)}
            placeholder="Search documents..."
            aria-label="Search documents"
            className="h-9 pl-9 pr-9 text-sm"
          />
          {draftQuery.length > 0 ? (
            <button
              type="button"
              onClick={() => setDraftQuery("")}
              aria-label="Clear document search"
              className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Status filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn("h-8", statusFilter.length > 0 && "bg-accent")}
                data-testid="documents-status-filter"
              >
                Status{statusFilter.length > 0 ? ` (${statusFilter.length})` : ""}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Status</DropdownMenuLabel>
              {DOCUMENT_STATUSES.map((status) => (
                <DropdownMenuCheckboxItem
                  key={status}
                  checked={statusFilter.includes(status)}
                  onSelect={(event) => {
                    event.preventDefault();
                    toggleMulti("status", status);
                  }}
                >
                  {STATUS_LABELS[status]}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Type filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn("h-8", typeFilter.length > 0 && "bg-accent")}
                data-testid="documents-type-filter"
              >
                Type{typeFilter.length > 0 ? ` (${typeFilter.length})` : ""}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Type</DropdownMenuLabel>
              {DOCUMENT_TYPES.map((type) => (
                <DropdownMenuCheckboxItem
                  key={type}
                  checked={typeFilter.includes(type)}
                  onSelect={(event) => {
                    event.preventDefault();
                    toggleMulti("type", type);
                  }}
                >
                  {TYPE_LABELS[type]}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Owner filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn("h-8", ownerFilter && "bg-accent")}
                data-testid="documents-owner-filter"
              >
                {ownerAgent ? ownerAgent.name : "Owner"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 w-52 overflow-y-auto">
              <DropdownMenuLabel>Owner</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => updateParams((params) => params.delete("owner"))}
                className="justify-between"
              >
                Any owner
                {!ownerFilter ? <Check className="h-3.5 w-3.5" /> : null}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {(agents ?? []).map((agent) => (
                <DropdownMenuItem
                  key={agent.id}
                  onSelect={() => updateParams((params) => params.set("owner", agent.id))}
                  className="justify-between"
                >
                  <span className="truncate">{agent.name}</span>
                  {ownerFilter === agent.id ? <Check className="h-3.5 w-3.5" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Linked work filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn("h-8", linkedFilter.trim() && "bg-accent")}
                data-testid="documents-linked-filter"
              >
                {linkedFilter.trim() ? linkedFilter.trim() : "Linked"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52 p-2">
              <DropdownMenuLabel>Linked work</DropdownMenuLabel>
              <div className="mt-1 px-1">
                <Input
                  value={draftLinked}
                  onChange={(event) => setDraftLinked(event.currentTarget.value)}
                  placeholder="e.g. PAP-10440"
                  className="h-8 text-sm"
                  autoFocus
                  onKeyDown={(event) => event.stopPropagation()}
                />
              </div>
              {draftLinked.trim() ? (
                <div className="mt-1 px-1">
                  <button
                    type="button"
                    onClick={() => {
                      setDraftLinked("");
                      updateParams((params) => params.delete("linked"));
                    }}
                    className="w-full rounded px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                  >
                    Clear
                  </button>
                </div>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Sort */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                data-testid="documents-sort"
              >
                {SORT_LABELS[sort]}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              {SORT_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onSelect={() => setSort(option.value)}
                  className="justify-between"
                >
                  {option.label}
                  {sort === option.value ? <Check className="h-3.5 w-3.5" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Toggles */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={cn("h-8 w-8", (hasFeedback || trustedOnly) && "bg-accent")}
                aria-label="More filters"
                title="More filters"
                data-testid="documents-more-filters"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Filters</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={hasFeedback}
                onSelect={(event) => {
                  event.preventDefault();
                  toggleFlag("feedback");
                }}
              >
                With open feedback
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={trustedOnly}
                onSelect={(event) => {
                  event.preventDefault();
                  toggleFlag("trusted");
                }}
              >
                Trusted sources only
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* New document CTA */}
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-8"
            onClick={() => {}}
            data-testid="documents-new"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            New document
          </Button>
        </div>
      </div>

      {/* Active filter chips */}
      {hasActiveFilters ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {statusFilter.map((status) => (
            <FilterChip key={`status-${status}`} label={`Status: ${STATUS_LABELS[status]}`} onRemove={() => toggleMulti("status", status)} />
          ))}
          {typeFilter.map((type) => (
            <FilterChip key={`type-${type}`} label={`Type: ${TYPE_LABELS[type]}`} onRemove={() => toggleMulti("type", type)} />
          ))}
          {ownerFilter ? (
            <FilterChip
              label={`Owner: ${ownerAgent?.name ?? "Unknown"}`}
              onRemove={() => updateParams((params) => params.delete("owner"))}
            />
          ) : null}
          {linkedFilter.trim() ? (
            <FilterChip
              label={`Linked: ${linkedFilter.trim()}`}
              onRemove={() => {
                setDraftLinked("");
                updateParams((params) => params.delete("linked"));
              }}
            />
          ) : null}
          {hasFeedback ? <FilterChip label="Open feedback" onRemove={() => toggleFlag("feedback")} /> : null}
          {trustedOnly ? <FilterChip label="Trusted sources" onRemove={() => toggleFlag("trusted")} /> : null}
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-md px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            Clear all
          </button>
        </div>
      ) : null}

      {error ? <p className="text-sm text-destructive">{(error as Error).message}</p> : null}

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : displayDocuments.length === 0 ? (
        hasActiveFilters ? (
          <EmptyState icon={FileText} message="No documents match these filters." action="Clear filters" onAction={clearFilters} />
        ) : (
          <EmptyState
            icon={FileText}
            message="No documents yet. Plans, specs, and briefs from across the company will appear here for review."
            action="New document"
            onAction={() => {}}
          />
        )
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          {displayDocuments.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              to={`/documents/${document.id}`}
              owner={
                document.ownerAgentId ? ownerById.get(document.ownerAgentId) ?? null : null
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-accent/60 px-2 py-1 font-medium text-foreground">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
