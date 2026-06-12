import { startTransition, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, LoaderCircle, Package } from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { deliverablesApi } from "../api/deliverables";
import { AudienceBadge } from "../components/AudienceBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Input } from "@/components/ui/input";
import { issueUrl, agentUrl, relativeTime, formatDateTime, formatFileSize } from "../lib/utils";
import type { DeliverableAudience, DeliverableListItem } from "@paperclipai/shared";

const AUDIENCE_FILTERS: Array<{ value: "all" | DeliverableAudience; label: string }> = [
  { value: "all", label: "All" },
  { value: "human", label: "Human" },
  { value: "internal", label: "Internal" },
];
const DELIVERABLE_SEARCH_DEBOUNCE_MS = 250;

export function Deliverables() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [audience, setAudience] = useState<"all" | DeliverableAudience>("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Deliverables" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      startTransition(() => {
        setSearch(searchDraft);
      });
    }, DELIVERABLE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [searchDraft]);

  const searchTerm = search.trim();
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: queryKeys.deliverables.list(selectedCompanyId!, {
      q: searchTerm || undefined,
      audience: audience === "all" ? undefined : audience,
    }),
    queryFn: () =>
      deliverablesApi.list(selectedCompanyId!, {
        q: searchTerm || undefined,
        audience: audience === "all" ? undefined : audience,
        limit: 200,
      }),
    enabled: !!selectedCompanyId,
    placeholderData: (previousData, previousQuery) => {
      const previousKey = Array.isArray(previousQuery?.queryKey) ? previousQuery.queryKey : [];
      return previousKey[0] === "deliverables" && previousKey[1] === selectedCompanyId
        ? previousData
        : undefined;
    },
  });

  const items = data?.items ?? [];

  if (!selectedCompanyId) {
    return <EmptyState icon={Package} message="Select a company to view deliverables." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Deliverables</h1>
          <p className="text-sm text-muted-foreground">
            Downloadable outputs produced by issue work and workflows.
            {items.length > 0 ? ` (${items.length})` : null}
          </p>
        </div>
        {items.length > 0 || searchTerm || audience !== "all" ? (
          <div className="flex w-full max-w-md gap-2">
            <div className="relative flex-1">
              <Input
                type="search"
                placeholder="Search deliverables..."
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                aria-label="Search deliverables"
                className={isFetching ? "pr-9" : undefined}
              />
              {isFetching ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
                />
              ) : null}
            </div>
            <select
              value={audience}
              onChange={(event) => setAudience(event.target.value as "all" | DeliverableAudience)}
              aria-label="Filter by audience"
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              {AUDIENCE_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          icon={Package}
          message={
            searchTerm
              ? "No deliverables match your search."
              : "No deliverables yet. Agents that produce file artifacts will list them here."
          }
        />
      ) : (
        <div
          className={`overflow-hidden rounded-md border border-border transition-opacity ${
            isFetching ? "opacity-70" : "opacity-100"
          }`}
        >
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Title</th>
                <th className="px-3 py-2 text-left font-medium">Audience</th>
                <th className="px-3 py-2 text-left font-medium">Source</th>
                <th className="px-3 py-2 text-left font-medium">Producer</th>
                <th className="px-3 py-2 text-right font-medium">Size</th>
                <th className="px-3 py-2 text-left font-medium">Created</th>
                <th className="px-3 py-2 text-right font-medium">Download</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <DeliverableRow key={item.id} item={item} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DeliverableRow({ item }: { item: DeliverableListItem }) {
  const rootIssue = item.childIssue ? (item.rootIssue ?? item.childIssue) : null;
  const showChildSeparately = item.childIssue !== null && item.rootIssue !== null && item.rootIssue.id !== item.childIssue.id;

  return (
    <tr className={`border-t border-border hover:bg-muted/30 ${item.audience === "internal" ? "bg-muted/10" : ""}`}>
      <td className="px-3 py-2 align-top">
        <Link
          to={`/deliverables/${item.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {item.title}
        </Link>
        {item.originalFilename ? (
          <div className="font-mono text-[11px] text-muted-foreground">
            {item.originalFilename}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2 align-top">
        <AudienceBadge audience={item.audience} />
      </td>
      <td className="px-3 py-2 align-top">
        {item.sourceKind === "workflow" && item.workflow ? (
          <>
            <Link
              to={`/workflows/${item.workflow.id}`}
              className="hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {item.workflow.title}
            </Link>
            <div className="text-[11px] text-muted-foreground">
              Run {item.workflow.runId.slice(0, 8)}
            </div>
          </>
        ) : rootIssue ? (
          <>
            <Link
              to={issueUrl(rootIssue)}
              className="text-foreground hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {rootIssue.identifier ?? rootIssue.title}
            </Link>
            {showChildSeparately && item.childIssue ? (
              <div className="text-[11px] text-muted-foreground">
                from{" "}
                <Link
                  to={issueUrl(item.childIssue)}
                  className="hover:underline"
                  onClick={(event) => event.stopPropagation()}
                >
                  {item.childIssue.identifier ?? item.childIssue.title}
                </Link>
              </div>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">Unknown</span>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        {item.agent ? (
          <Link
            to={agentUrl(item.agent)}
            className="text-foreground hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {item.agent.name}
          </Link>
        ) : item.workflow ? (
          <span className="text-muted-foreground">Workflow</span>
        ) : (
          <span className="text-muted-foreground">Unknown</span>
        )}
      </td>
      <td className="px-3 py-2 text-right align-top tabular-nums text-muted-foreground">
        {formatFileSize(item.byteSize)}
      </td>
      <td
        className="px-3 py-2 align-top text-muted-foreground"
        title={formatDateTime(item.createdAt)}
      >
        {relativeTime(item.createdAt)}
      </td>
      <td className="px-3 py-2 text-right align-top">
        <a
          href={`/api/deliverables/${item.id}/content`}
          download={item.originalFilename ?? undefined}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Download ${item.title}`}
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </a>
      </td>
    </tr>
  );
}
