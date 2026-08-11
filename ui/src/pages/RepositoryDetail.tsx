import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Repository } from "@paperclipai/shared";
import { AlertCircle, GitBranch } from "lucide-react";
import { repositoriesApi } from "../api/repositories";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

function MetadataRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right text-sm text-foreground">{value}</span>
    </div>
  );
}

function stateTone(repository: Repository): string {
  if (repository.state === "active") return "text-success";
  if (repository.state === "archived") return "text-muted-foreground";
  return "text-warning";
}

export function RepositoryDetail() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();

  const repositoryQuery = useQuery({
    queryKey: queryKeys.repositories.detail(repositoryId!),
    queryFn: () => repositoriesApi.get(repositoryId!),
    enabled: !!repositoryId,
  });

  const repository = repositoryQuery.data;

  useEffect(() => {
    setBreadcrumbs([
      { label: "Repositories", href: "/repositories" },
      { label: repository ? `${repository.owner}/${repository.name}` : "Repository" },
    ]);
  }, [setBreadcrumbs, repository]);

  if (repositoryQuery.isLoading) return <PageSkeleton />;

  if (repositoryQuery.isError || !repository) {
    return (
      <div className="p-6">
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> Repository not found.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <GitBranch className="h-5 w-5 text-muted-foreground" aria-hidden />
        <div>
          <h1 className="text-lg font-semibold text-foreground">
            {repository.owner}/{repository.name}
          </h1>
          <p className="text-sm text-muted-foreground">{repository.host}</p>
        </div>
        <Badge variant="secondary" className="ml-auto">{repository.provider}</Badge>
      </div>

      <Card className="px-4 py-2">
        <MetadataRow label="State" value={<span className={stateTone(repository)}>{repository.state}</span>} />
        {repository.unavailableReason ? (
          <MetadataRow label="Reason" value={repository.unavailableReason} />
        ) : null}
        <MetadataRow label="Visibility" value={repository.visibility} />
        <MetadataRow label="Default branch" value={repository.defaultBranch ?? "—"} />
        <MetadataRow
          label="Clone URL"
          value={<code className="text-xs">{repository.cloneUrl}</code>}
        />
        <MetadataRow
          label="Web URL"
          value={
            repository.webUrl ? (
              <a href={repository.webUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                {repository.webUrl}
              </a>
            ) : (
              "—"
            )
          }
        />
        <MetadataRow
          label="Source"
          value={repository.connectionId ? "Provider connection" : "Manual"}
        />
      </Card>
    </div>
  );
}
