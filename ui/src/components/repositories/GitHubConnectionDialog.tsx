import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  RepositoryConnection,
  RepositoryDiscoveryItem,
  RepositoryDiscoveryPage,
} from "@paperclipai/shared";
import { AlertCircle, ExternalLink, Github, Loader2, X } from "lucide-react";
import { repositoriesApi } from "../../api/repositories";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Step = "authorize" | "select" | "done";

const DISCOVERY_PAGE_SIZE = 20;

interface GitHubConnectionDialogProps {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Host of the GitHub provider identity to connect. The `github` provider key
   * can be served by more than one host once an extension registers an
   * enterprise install, and the server refuses an ambiguous lookup, so the
   * caller passes the host it offered. Omitted when only one host serves the key.
   */
  host?: string | null;
  /** Called after repositories are imported so the catalog can refresh. */
  onImported?: (importedCount: number) => void;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Something went wrong. Please try again.";
}

export function GitHubConnectionDialog({
  companyId,
  open,
  onOpenChange,
  host = null,
  onImported,
}: GitHubConnectionDialogProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("authorize");
  const [state, setState] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState("");
  const [connection, setConnection] = useState<RepositoryConnection | null>(null);
  const [items, setItems] = useState<RepositoryDiscoveryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const lastSearchRef = useRef("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importedCount, setImportedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);

  function resetAll() {
    setStep("authorize");
    setState(null);
    setInstallationId("");
    setConnection(null);
    setItems([]);
    setNextCursor(null);
    setSearch("");
    lastSearchRef.current = "";
    setSelected(new Set());
    setImportedCount(0);
    setSkippedCount(0);
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetAll();
    onOpenChange(next);
  }

  const beginMutation = useMutation({
    mutationFn: () => repositoriesApi.beginConnection(companyId, "github", {}, host),
    onSuccess: (result) => {
      setState(result.state);
      window.open(result.installUrl, "_blank", "noopener,noreferrer");
    },
  });

  const applyDiscoveryPage = (page: RepositoryDiscoveryPage, append: boolean) => {
    setItems((prev) => (append ? [...prev, ...page.items] : page.items));
    setNextCursor(page.nextCursor);
  };

  const discoverMutation = useMutation({
    mutationFn: (input: { connectionId: string; cursor: string | null; query: string }) =>
      repositoriesApi.discoverConnectionRepositories(input.connectionId, {
        query: input.query || null,
        cursor: input.cursor,
        pageSize: DISCOVERY_PAGE_SIZE,
      }),
    onSuccess: (page, variables) => applyDiscoveryPage(page, Boolean(variables.cursor)),
  });

  const completeMutation = useMutation({
    mutationFn: () => {
      if (!state) throw new Error("Start the connection before confirming installation");
      return repositoriesApi.completeConnection(
        companyId,
        "github",
        {
          state,
          installationId: installationId.trim(),
        },
        host,
      );
    },
    onSuccess: async (result) => {
      setConnection(result.connection);
      setStep("select");
      lastSearchRef.current = "";
      queryClient.invalidateQueries({ queryKey: queryKeys.repositories.connections(companyId) });
      await discoverMutation.mutateAsync({ connectionId: result.connection.id, cursor: null, query: "" });
    },
  });

  const importMutation = useMutation({
    mutationFn: (input: { connectionId: string; providerRepositoryIds: string[] }) =>
      repositoriesApi.importConnectionRepositories(input.connectionId, input.providerRepositoryIds),
    onSuccess: (result) => {
      setImportedCount(result.imported);
      setSkippedCount(result.skipped.length);
      setStep("done");
      queryClient.invalidateQueries({ queryKey: queryKeys.repositories.list(companyId) });
      onImported?.(result.imported);
    },
  });

  const toggle = (item: RepositoryDiscoveryItem) => {
    if (item.imported) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.providerRepositoryId)) next.delete(item.providerRepositoryId);
      else next.add(item.providerRepositoryId);
      return next;
    });
  };

  useEffect(() => {
    if (!open || step !== "select" || !connection) return;
    const query = deferredSearch.trim();
    if (query === lastSearchRef.current) return;
    lastSearchRef.current = query;
    discoverMutation.mutate({ connectionId: connection.id, cursor: null, query });
  }, [connection, deferredSearch, open, step]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Github className="h-4 w-4" aria-hidden />
            Connect GitHub
          </DialogTitle>
          <DialogDescription>
            Import repositories your GitHub App installation can access. Importing creates reusable
            repository objects only — it never attaches projects, grants agents, or creates workspaces.
          </DialogDescription>
        </DialogHeader>

        {step === "authorize" ? (
          <div className="flex flex-col gap-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => beginMutation.mutate()}
              disabled={beginMutation.isPending}
            >
              {beginMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
              Authorize on GitHub
            </Button>
            {beginMutation.isError ? (
              <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" /> {errorMessage(beginMutation.error)}
              </p>
            ) : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor="github-installation-id">Installation ID</Label>
              <Input
                id="github-installation-id"
                value={installationId}
                onChange={(event) => setInstallationId(event.target.value)}
                placeholder="From the GitHub redirect (installation_id)"
                disabled={!state}
              />
              <p className="text-xs text-muted-foreground">
                After authorizing, paste the installation id from the GitHub redirect to finish connecting.
              </p>
            </div>
            {completeMutation.isError ? (
              <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" /> {errorMessage(completeMutation.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                onClick={() => completeMutation.mutate()}
                disabled={!state || !installationId.trim() || completeMutation.isPending}
              >
                {completeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Continue
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === "select" ? (
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Input
                aria-label="Search repositories"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search repositories"
                className={search ? "pr-8" : undefined}
              />
              {search ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  onClick={() => setSearch("")}
                  aria-label="Clear repository search"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>

            {discoverMutation.isError ? (
              <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" /> {errorMessage(discoverMutation.error)}
              </p>
            ) : null}

            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {items.length === 0 && !discoverMutation.isPending ? (
                <li className="py-6 text-center text-sm text-muted-foreground">No repositories found.</li>
              ) : null}
              {items.map((item) => (
                <li key={item.providerRepositoryId}>
                  <label
                    className={`flex items-center gap-3 px-2 py-2 text-sm ${item.imported ? "opacity-60" : "cursor-pointer hover:bg-muted/50"}`}
                  >
                    <Checkbox
                      checked={item.imported || selected.has(item.providerRepositoryId)}
                      disabled={item.imported}
                      onCheckedChange={() => toggle(item)}
                      aria-label={`Select ${item.owner}/${item.name}`}
                    />
                    <span className="flex-1 truncate">
                      <span className="font-medium text-foreground">{item.owner}/{item.name}</span>
                      {item.imported ? (
                        <span className="ml-2 text-xs text-muted-foreground">Imported</span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            {nextCursor ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  connection && discoverMutation.mutate({
                    connectionId: connection.id,
                    cursor: nextCursor,
                    query: lastSearchRef.current,
                  })
                }
                disabled={discoverMutation.isPending}
              >
                {discoverMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Load more
              </Button>
            ) : null}

            {importMutation.isError ? (
              <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" /> {errorMessage(importMutation.error)}
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                onClick={() =>
                  connection &&
                  importMutation.mutate({ connectionId: connection.id, providerRepositoryIds: [...selected] })
                }
                disabled={selected.size === 0 || importMutation.isPending}
              >
                {importMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Import {selected.size > 0 ? `${selected.size} ` : ""}selected
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === "done" ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-foreground">
              Imported {importedCount} {importedCount === 1 ? "repository" : "repositories"}
              {skippedCount > 0 ? `, skipped ${skippedCount}` : ""}.
            </p>
            <DialogFooter>
              <Button type="button" onClick={() => handleOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
