import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Package } from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { deliverablesApi } from "../api/deliverables";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Input } from "@/components/ui/input";
import { issueUrl, agentUrl, relativeTime, formatDateTime, formatFileSize } from "../lib/utils";
import type { DeliverableListItem } from "@paperclipai/shared";

export function Deliverables() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [search, setSearch] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Deliverables" }]);
  }, [setBreadcrumbs]);

  const searchTerm = search.trim();
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.deliverables.list(selectedCompanyId!, {
      q: searchTerm || undefined,
    }),
    queryFn: () =>
      deliverablesApi.list(selectedCompanyId!, {
        q: searchTerm || undefined,
      }),
    enabled: !!selectedCompanyId,
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
            Downloadable artifacts produced by agents while working on issues.
            {items.length > 0 ? ` (${items.length})` : null}
          </p>
        </div>
        {items.length > 0 ? (
          <div className="w-full max-w-xs">
            <Input
              type="search"
              placeholder="Search deliverables..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search deliverables"
            />
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
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Title</th>
                <th className="px-3 py-2 text-left font-medium">Issue</th>
                <th className="px-3 py-2 text-left font-medium">Agent</th>
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
  const rootIssue = item.rootIssue ?? item.childIssue;
  const showChildSeparately = item.rootIssue !== null && item.rootIssue.id !== item.childIssue.id;

  return (
    <tr className="border-t border-border hover:bg-muted/30">
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
        <Link
          to={issueUrl(rootIssue)}
          className="text-foreground hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {rootIssue.identifier ?? rootIssue.title}
        </Link>
        {showChildSeparately ? (
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
          href={item.contentPath}
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
