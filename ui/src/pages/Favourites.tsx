import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Star, Search as SearchIcon } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useIssueFavourites } from "../hooks/useIssueFavourites";
import { queryKeys } from "../lib/queryKeys";
import { formatDate } from "../lib/utils";
import { StatusIcon } from "../components/StatusIcon";
import { FavouriteButton } from "../components/FavouriteButton";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Input } from "@/components/ui/input";

export function Favourites() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [search, setSearch] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Favourites" }]);
  }, [setBreadcrumbs]);

  const { favouriteIds, isLoading: favouritesLoading } = useIssueFavourites(selectedCompanyId);

  const { data: issues, isLoading: issuesLoading } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const favouriteIssues = useMemo(
    () => (issues ?? []).filter((issue: Issue) => favouriteIds.has(issue.id)),
    [issues, favouriteIds],
  );

  const filteredIssues = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return favouriteIssues;
    return favouriteIssues.filter((issue: Issue) => {
      const haystack = `${issue.title} ${issue.identifier ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [favouriteIssues, search]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Star} message="Select a company to view your favourite tasks." />;
  }

  if (favouritesLoading || issuesLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (favouriteIssues.length === 0) {
    return (
      <EmptyState
        icon={Star}
        message="No favourite tasks yet. Tap the star on any task to add it here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search favourites..."
          className="pl-9"
          aria-label="Search favourite tasks"
        />
      </div>

      {filteredIssues.length === 0 ? (
        <EmptyState icon={SearchIcon} message="No favourite tasks match your search." />
      ) : (
        <div className="border border-border">
          {filteredIssues.map((issue: Issue) => (
            <EntityRow
              key={issue.id}
              identifier={issue.identifier ?? issue.id.slice(0, 8)}
              title={issue.title}
              to={`/issues/${issue.identifier ?? issue.id}`}
              leading={<StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />}
              trailing={
                <span className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{formatDate(issue.createdAt)}</span>
                  <FavouriteButton issueId={issue.id} />
                </span>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
