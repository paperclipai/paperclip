import { useQuery } from "@tanstack/react-query";
import type { ProjectRepository } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { RepositoryEditor } from "./RepositoryEditor";
import { Button } from "./ui/button";
import { useQueryView } from "./QueryView";

export const repositoryOptionsKey = (companyId: string) => ["project-repositories", companyId] as const;

export function ProjectRepositoryInput({ companyId, selected, onChange, onConnect, disabled }: {
  companyId: string;
  selected: ProjectRepository[];
  onChange: (repos: ProjectRepository[]) => void;
  onConnect: () => void;
  disabled?: boolean;
}) {
  const query = useQuery({ queryKey: repositoryOptionsKey(companyId), queryFn: () => projectsApi.repositoryOptions(companyId), staleTime: 30_000 });
  // Read through the shared view so cached options stay visible while a transient
  // refetch fails; only a no-data failure lands in the error state with Retry.
  const view = useQueryView(query);
  const state = view.kind === "loading" || view.kind === "reconnecting" ? "loading"
    : view.kind === "error" ? "error"
    : !view.data?.connectionCount ? "disconnected"
    : view.data.failedConnectionCount && !view.data.repositories.length ? "error"
    : !view.data.repositories.length ? "empty" : "ready";
  return <div className="flex min-w-0 flex-col gap-3">
    <RepositoryEditor selected={selected.map((repo) => query.data?.repositories.find((available) => available.id === repo.id) ?? repo)} onChange={onChange} available={query.data?.repositories} state={state}
      onRetry={() => view.retry()} onConnect={onConnect} disabled={disabled} />
    {!!query.data?.failedConnectionCount && query.data.repositories.length > 0 && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
      Some GitHub connections could not load. Reconnect them in Apps or try again.
      <Button type="button" variant="ghost" size="sm" disabled={view.isFetching} onClick={() => view.retry()}>Try again</Button>
    </div>}
  </div>;
}
