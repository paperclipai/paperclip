import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Repository } from "@paperclipai/shared";
import { AlertCircle, GitBranch, Plus } from "lucide-react";
import { Link, useParams } from "@/lib/router";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { repositoriesApi } from "../api/repositories";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";

function MetadataRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-left text-sm text-foreground sm:text-right">{value}</span>
    </div>
  );
}

function stateTone(repository: Repository): string {
  if (repository.state === "active") return "text-success";
  if (repository.state === "archived") return "text-muted-foreground";
  return "text-warning";
}

function SectionPicker({ label, options, onSelect }: {
  label: string;
  options: Array<{ id: string; label: string }>;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const filtered = options.filter((option) => option.label.toLowerCase().includes(search.trim().toLowerCase()));
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setSearch("");
  }
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="xs" disabled={options.length === 0}>
          <Plus className="mr-1 h-3 w-3" />{label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-2 p-2" align="end">
        <Input
          aria-label={`Search ${label.toLowerCase()} options`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search"
        />
        <div className="max-h-56 overflow-y-auto">
          {filtered.map((option) => (
            <button
              key={option.id}
              type="button"
              title={option.label}
              className="w-full break-words rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
              onClick={() => { onSelect(option.id); handleOpenChange(false); }}
            >
              {option.label}
            </button>
          ))}
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">No options match.</p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function RepositoryDetail() {
  const { repositoryId = "" } = useParams();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const repositoryQuery = useQuery({
    queryKey: queryKeys.repositories.detail(repositoryId),
    queryFn: () => repositoriesApi.get(repositoryId),
    enabled: Boolean(repositoryId),
  });
  const relationshipsQuery = useQuery({
    queryKey: queryKeys.repositories.relationships(repositoryId),
    queryFn: () => repositoriesApi.getRelationships(repositoryId),
    enabled: Boolean(repositoryId),
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? ""),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.repositories.relationships(repositoryId) });
    if (selectedCompanyId) queryClient.invalidateQueries({ queryKey: queryKeys.repositories.all(selectedCompanyId) });
  };
  const attachProject = useMutation({
    mutationFn: (projectId: string) => repositoriesApi.attachProjectRepository(projectId, repositoryId),
    onSuccess: refresh,
  });
  const detachProject = useMutation({
    mutationFn: (projectId: string) => repositoriesApi.detachProjectRepository(projectId, repositoryId),
    onSuccess: refresh,
  });
  const grantAgent = useMutation({
    mutationFn: (agentId: string) => repositoriesApi.grantAgentRepository(agentId, repositoryId),
    onSuccess: refresh,
  });
  const revokeAgent = useMutation({
    mutationFn: (agentId: string) => repositoriesApi.revokeAgentRepository(agentId, repositoryId),
    onSuccess: refresh,
  });
  const repository = repositoryQuery.data;
  const relationships = relationshipsQuery.data;

  useEffect(() => {
    setBreadcrumbs([
      { label: "Repositories", href: "/repositories" },
      { label: repository ? `${repository.owner}/${repository.name}` : "Repository" },
    ]);
    return () => setBreadcrumbs([]);
  }, [repository, setBreadcrumbs]);

  const projectOptions = useMemo(() => {
    const linked = new Set(relationships?.projects.map((project) => project.id) ?? []);
    return (projectsQuery.data ?? [])
      .filter((project) => !linked.has(project.id) && !project.archivedAt)
      .map((project) => ({ id: project.id, label: project.name }));
  }, [projectsQuery.data, relationships?.projects]);
  const directAgentIds = new Set(
    relationships?.agents.filter((agent) => agent.sources.direct).map((agent) => agent.id) ?? [],
  );
  const agentOptions = (agentsQuery.data ?? [])
    .filter((agent) => !directAgentIds.has(agent.id))
    .map((agent) => ({ id: agent.id, label: agent.name }));
  const directAgents = relationships?.agents.filter((agent) => agent.sources.direct) ?? [];
  const inheritedAgents = relationships?.agents.filter((agent) => !agent.sources.direct) ?? [];

  if (repositoryQuery.isLoading || relationshipsQuery.isLoading) return <PageSkeleton />;
  if (repositoryQuery.isError || relationshipsQuery.isError || !repository || !relationships) {
    return (
      <div className="p-6">
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> Repository not found.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <div className="flex min-w-0 items-start gap-3">
        <GitBranch className="h-5 w-5 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <h1 className="break-words text-lg font-semibold text-foreground">
            {repository.owner}/{repository.name}
          </h1>
          <p className="text-sm text-muted-foreground">{repository.host}</p>
        </div>
        <Badge variant="secondary" className="ml-auto">{repository.provider}</Badge>
      </div>

      <Card className="px-4 py-2">
        <MetadataRow label="State" value={<span className={stateTone(repository)}>{repository.state}</span>} />
        {repository.unavailableReason ? <MetadataRow label="Reason" value={repository.unavailableReason} /> : null}
        <MetadataRow label="Visibility" value={repository.visibility} />
        <MetadataRow label="Default branch" value={repository.defaultBranch ?? "—"} />
        <MetadataRow label="Clone URL" value={<code className="text-xs">{repository.cloneUrl}</code>} />
        <MetadataRow
          label="Web URL"
          value={repository.webUrl ? (
            <a href={repository.webUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
              {repository.webUrl}
            </a>
          ) : "—"}
        />
        <MetadataRow label="Source" value={repository.connectionId ? "Provider connection" : "Manual"} />
      </Card>

      <Separator />

      <section className="space-y-3">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h2 className="text-sm font-medium">Project hints</h2>
            <p className="text-xs text-muted-foreground">
              Attach this repository to every project likely to touch it. This is guidance, not a boundary.
            </p>
          </div>
          <SectionPicker label="Add to project" options={projectOptions} onSelect={(id) => attachProject.mutate(id)} />
        </div>
        {relationships.projects.length === 0 ? (
          <p className="text-xs text-muted-foreground">No projects currently hint at this repository.</p>
        ) : relationships.projects.map((project) => (
          <div key={project.id} className="flex flex-col items-start gap-2 border-b border-border py-2 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <Link to={`/projects/${project.id}/configuration`} className="break-words text-sm hover:underline">{project.name}</Link>
            <Button type="button" variant="ghost" size="xs" onClick={() => detachProject.mutate(project.id)}>
              Remove project hint
            </Button>
          </div>
        ))}
      </section>

      <Separator />

      <section className="space-y-3">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h2 className="text-sm font-medium">Direct agent access ({directAgents.length})</h2>
            <p className="text-xs text-muted-foreground">Explicit grants managed on this repository.</p>
          </div>
          <SectionPicker label="Grant agent" options={agentOptions} onSelect={(id) => grantAgent.mutate(id)} />
        </div>
        {directAgents.length === 0 ? (
          <p className="text-xs text-muted-foreground">No agents have a direct grant.</p>
        ) : directAgents.map((agent) => (
          <div key={agent.id} className="flex flex-col items-start gap-2 border-b border-border py-2 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="min-w-0">
              <Link to={`/agents/${agent.id}`} className="text-sm hover:underline">{agent.name}</Link>
              <p className="text-(length:--text-micro) text-muted-foreground">
                {agent.sources.projects.length > 0
                  ? `Direct grant · Also inherited through ${agent.sources.projects.map((project) => project.name).join(", ")}`
                  : "Direct grant"}
              </p>
            </div>
            <Button type="button" variant="ghost" size="xs" onClick={() => revokeAgent.mutate(agent.id)}>
              Revoke direct grant
            </Button>
          </div>
        ))}
        {inheritedAgents.length > 0 ? (
          <details className="border-t border-border pt-3">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Inherited through projects ({inheritedAgents.length})
            </summary>
            <div className="mt-2">
              {inheritedAgents.map((agent) => (
                <div key={agent.id} className="flex flex-col gap-1 border-b border-border py-2 last:border-b-0">
                  <Link to={`/agents/${agent.id}`} className="text-sm hover:underline">{agent.name}</Link>
                  <p className="text-(length:--text-micro) text-muted-foreground">
                    Inherited through {agent.sources.projects.map((project) => project.name).join(", ")} · managed on those projects
                  </p>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>
    </div>
  );
}
