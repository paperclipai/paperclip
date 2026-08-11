import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RepositoryCatalogItem, RepositoryConnection } from "@paperclipai/shared";
import { AlertCircle, GitBranch, Github, Loader2, Plus, RefreshCw } from "lucide-react";
import { repositoriesApi } from "../api/repositories";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { GitHubConnectionDialog } from "../components/repositories/GitHubConnectionDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function connectionHealthTone(connection: RepositoryConnection): "success" | "warning" | "danger" | "neutral" {
  if (connection.status === "error" || connection.syncStatus === "failed") return "danger";
  if (connection.status === "disconnected") return "warning";
  if (connection.syncStatus === "syncing") return "neutral";
  return "success";
}

function connectionHealthLabel(connection: RepositoryConnection): string {
  if (connection.status === "disconnected") return "Disconnected";
  if (connection.status === "error" || connection.syncStatus === "failed") return "Sync failed";
  if (connection.syncStatus === "syncing") return "Syncing";
  if (connection.syncStatus === "succeeded") return "Healthy";
  return "Idle";
}

function toneClass(tone: "success" | "warning" | "danger" | "neutral"): string {
  switch (tone) {
    case "success":
      return "text-success";
    case "warning":
      return "text-warning";
    case "danger":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

export function Repositories() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [githubOpen, setGithubOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualUrl, setManualUrl] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Repositories" }]);
  }, [setBreadcrumbs]);

  const repositoriesQuery = useQuery({
    queryKey: queryKeys.repositories.list(selectedCompanyId!),
    queryFn: () => repositoriesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.repositories.connections(selectedCompanyId!),
    queryFn: () => repositoriesApi.listConnections(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const manualMutation = useMutation({
    mutationFn: (cloneUrl: string) =>
      repositoriesApi.createManual(selectedCompanyId!, { cloneUrl, visibility: "unknown" }),
    onSuccess: () => {
      setManualOpen(false);
      setManualUrl("");
      queryClient.invalidateQueries({ queryKey: queryKeys.repositories.list(selectedCompanyId!) });
    },
  });

  const syncMutation = useMutation({
    mutationFn: (connectionId: string) => repositoriesApi.syncConnection(connectionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repositories.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.repositories.connections(selectedCompanyId!) });
    },
  });

  const repositories = repositoriesQuery.data ?? [];
  const connections = connectionsQuery.data ?? [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return repositories;
    return repositories.filter((repo) =>
      `${repo.host}/${repo.owner}/${repo.name}`.toLowerCase().includes(term),
    );
  }, [repositories, search]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.repositories.list(selectedCompanyId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.repositories.connections(selectedCompanyId!) });
  };

  if (repositoriesQuery.isLoading) {
    return <PageSkeleton />;
  }

  if (repositoriesQuery.isError) {
    return (
      <div className="p-6">
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> Failed to load repositories.
        </div>
        <Button className="mt-4" variant="outline" onClick={refresh}>
          <RefreshCw className="h-4 w-4" /> Retry
        </Button>
      </div>
    );
  }

  const actions = (
    <div className="flex items-center gap-2">
      <Button variant="outline" onClick={() => setManualOpen(true)}>
        <Plus className="h-4 w-4" /> Add manually
      </Button>
      <Button onClick={() => setGithubOpen(true)}>
        <Github className="h-4 w-4" /> Connect GitHub
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Repositories</h1>
          <p className="text-sm text-muted-foreground">
            Reusable git repositories available to projects and agents in this company.
          </p>
        </div>
        {actions}
      </div>

      {connections.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Connections</h2>
          <div className="flex flex-col gap-2">
            {connections.map((connection) => {
              const tone = connectionHealthTone(connection);
              return (
                <Card key={connection.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Github className="h-4 w-4 text-muted-foreground" aria-hidden />
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {connection.accountName ?? connection.host}
                      </p>
                      <p className={`text-xs ${toneClass(tone)}`}>
                        {connectionHealthLabel(connection)}
                        {connection.syncError ? ` — ${connection.syncError}` : ""}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => syncMutation.mutate(connection.id)}
                    disabled={connection.status === "disconnected" || syncMutation.isPending}
                  >
                    {syncMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    Sync
                  </Button>
                </Card>
              );
            })}
          </div>
        </div>
      ) : null}

      {repositories.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title="No repositories yet"
          message="Connect GitHub to import repositories, or add one manually by its clone URL."
          action="Connect GitHub"
          hideActionIcon
          onAction={() => setGithubOpen(true)}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <Input
            aria-label="Search repositories"
            placeholder="Search repositories"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="max-w-sm"
          />
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No repositories match “{search}”.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {filtered.map((repo) => (
                <li key={repo.id}>
                  <Link
                    to={repo.id}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-muted/50"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {repo.owner}/{repo.name}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{repo.host}</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {repo.state !== "active" ? (
                        <Badge variant="outline" className="text-warning">{repo.state}</Badge>
                      ) : null}
                      <Badge variant="secondary">{repo.provider}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {repo.projectCount} project{repo.projectCount === 1 ? "" : "s"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {repo.directGrantCount} grant{repo.directGrantCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <GitHubConnectionDialog
        companyId={selectedCompanyId!}
        open={githubOpen}
        onOpenChange={setGithubOpen}
        onImported={() => refresh()}
      />

      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a repository manually</DialogTitle>
            <DialogDescription>
              Add a repository by its clone URL. This creates a reusable repository object only.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="manual-clone-url">Clone URL</Label>
            <Input
              id="manual-clone-url"
              value={manualUrl}
              onChange={(event) => setManualUrl(event.target.value)}
              placeholder="https://github.com/owner/repo.git"
            />
            {manualMutation.isError ? (
              <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {(manualMutation.error as { message?: string } | null)?.message ?? "Failed to add repository."}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              onClick={() => manualMutation.mutate(manualUrl.trim())}
              disabled={!manualUrl.trim() || manualMutation.isPending}
            >
              {manualMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Add repository
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
