import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RepositoryCatalogItem, RepositoryConnection } from "@paperclipai/shared";
import { AlertCircle, GitBranch, Github, Loader2, Plus, RefreshCw } from "lucide-react";
import { repositoriesApi } from "../api/repositories";
import { ApiError } from "../api/client";
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

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.body && typeof error.body === "object") {
    const details = (error.body as { details?: unknown }).details;
    if (Array.isArray(details)) {
      const message = details.find(
        (detail): detail is { message: string } =>
          Boolean(detail && typeof detail === "object" && typeof (detail as { message?: unknown }).message === "string"),
      )?.message;
      if (message) return message;
    }
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message && message !== "Validation error") return message;
  }
  return fallback;
}

export function Repositories() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [githubOpen, setGithubOpen] = useState(false);
  const [githubHost, setGithubHost] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const githubTriggerRef = useRef<HTMLButtonElement | null>(null);
  const manualTriggerRef = useRef<HTMLButtonElement | null>(null);

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
  const providersQuery = useQuery({
    queryKey: queryKeys.repositories.providers(selectedCompanyId!),
    queryFn: () => repositoriesApi.listProviders(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // The `github` key can be served by several hosts once an extension registers
  // an enterprise install. The server refuses an ambiguous lookup, so the page
  // offers each identity separately and sends the host the operator picked.
  const githubProviders = (providersQuery.data ?? []).filter((entry) => entry.provider === "github");
  const defaultGithubHost = githubProviders.length === 1 ? githubProviders[0]!.host : null;

  function restoreTrigger(ref: React.RefObject<HTMLButtonElement | null>) {
    queueMicrotask(() => ref.current?.focus());
  }

  function openGithubDialog(host: string | null, trigger: HTMLButtonElement) {
    githubTriggerRef.current = trigger;
    setGithubHost(host);
    setGithubOpen(true);
  }

  function handleGithubOpenChange(next: boolean) {
    setGithubOpen(next);
    if (!next) restoreTrigger(githubTriggerRef);
  }

  function openManualDialog(trigger: HTMLButtonElement) {
    manualTriggerRef.current = trigger;
    setManualOpen(true);
  }

  function handleManualOpenChange(next: boolean) {
    setManualOpen(next);
    if (!next) restoreTrigger(manualTriggerRef);
  }

  const manualMutation = useMutation({
    mutationFn: (cloneUrl: string) =>
      repositoriesApi.createManual(selectedCompanyId!, { cloneUrl, visibility: "unknown" }),
    onSuccess: (repository) => {
      const alreadyPresent = repositories.some((entry) => entry.id === repository.id);
      setCatalogNotice(alreadyPresent
        ? `${repository.owner}/${repository.name} is already in the catalog.`
        : `Added ${repository.owner}/${repository.name} to the catalog.`);
      setManualOpen(false);
      setManualUrl("");
      queryClient.invalidateQueries({ queryKey: queryKeys.repositories.list(selectedCompanyId!) });
      restoreTrigger(manualTriggerRef);
    },
  });

  const syncMutation = useMutation({
    mutationFn: (connectionId: string) => repositoriesApi.syncConnection(connectionId),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.repositories.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.repositories.connections(selectedCompanyId!) }),
      ]);
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
    <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
      <Button variant="outline" onClick={(event) => openManualDialog(event.currentTarget)}>
        <Plus className="h-4 w-4" /> Add manually
      </Button>
      {githubProviders.length > 1 ? (
        githubProviders.map((entry) => (
          <Button key={entry.host} onClick={(event) => openGithubDialog(entry.host, event.currentTarget)}>
            <Github className="h-4 w-4" /> Connect {entry.host}
          </Button>
        ))
      ) : githubProviders.length === 1 ? (
        <Button onClick={(event) => openGithubDialog(defaultGithubHost, event.currentTarget)}>
          <Github className="h-4 w-4" /> Connect GitHub
        </Button>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
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
                <Card key={connection.id} className="flex flex-row items-start justify-between gap-3 px-4 py-3 sm:items-center">
                  <div className="flex min-w-0 items-center gap-3">
                    <Github className="h-4 w-4 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium text-foreground">
                        {connection.accountName ?? connection.host}
                      </p>
                      <p
                        role={syncMutation.isError && syncMutation.variables === connection.id ? "alert" : undefined}
                        className={`text-xs ${toneClass(tone)}`}
                      >
                        {syncMutation.isError && syncMutation.variables === connection.id
                          ? "Sync failed — status refreshed; try again"
                          : connectionHealthLabel(connection)}
                        {connection.syncError && !(syncMutation.isError && syncMutation.variables === connection.id)
                          ? ` — ${connection.syncError}`
                          : ""}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => syncMutation.mutate(connection.id)}
                    disabled={connection.status === "disconnected" || syncMutation.isPending}
                  >
                    {syncMutation.isPending && syncMutation.variables === connection.id ? (
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

      {catalogNotice ? <p role="status" className="text-sm text-muted-foreground">{catalogNotice}</p> : null}

      {repositories.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title="No repositories yet"
          message={githubProviders.length > 0
            ? "Add a repository by clone URL, or connect GitHub to import from a provider."
            : "Add a repository by clone URL. Provider connections appear here when configured."}
          action="Add manually"
          actionRef={manualTriggerRef}
          hideActionIcon
          onAction={() => setManualOpen(true)}
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
                    className="flex flex-col items-start gap-2 px-3 py-2.5 hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                  >
                    <div className="flex w-full max-w-full min-w-0 items-center gap-3">
                      <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0">
                        <p
                          className="truncate text-sm font-medium text-foreground"
                          title={`${repo.owner}/${repo.name}`}
                        >
                          {repo.owner}/{repo.name}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{repo.host}</p>
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-7 sm:shrink-0 sm:pl-0">
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
        host={githubHost}
        onOpenChange={handleGithubOpenChange}
        onImported={() => refresh()}
      />

      <Dialog open={manualOpen} onOpenChange={handleManualOpenChange}>
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
              aria-invalid={manualMutation.isError}
              aria-describedby={manualMutation.isError ? "manual-clone-url-error" : undefined}
              value={manualUrl}
              onChange={(event) => {
                setManualUrl(event.target.value);
                if (manualMutation.isError) manualMutation.reset();
              }}
              placeholder="https://github.com/owner/repo.git"
            />
            {manualMutation.isError ? (
              <p id="manual-clone-url-error" role="alert" className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {apiErrorMessage(manualMutation.error, "Failed to add repository.")}
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
