import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, GitBranch, Plus, Search, X } from "lucide-react";
import type { RepositoryCatalogItem } from "@paperclipai/shared";
import { repositoriesApi } from "../api/repositories";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function repositoryLabel(repository: Pick<RepositoryCatalogItem, "host" | "owner" | "name">) {
  return `${repository.host}/${repository.owner}/${repository.name}`;
}

function repositoryName(repository: Pick<RepositoryCatalogItem, "owner" | "name">) {
  return `${repository.owner}/${repository.name}`;
}

export function RepositoryPicker({
  companyId,
  value,
  onChange,
  disabled = false,
}: {
  companyId: string;
  value: string[];
  onChange: (repositoryIds: string[]) => void;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [cloneUrl, setCloneUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const repositoriesQuery = useQuery({
    queryKey: queryKeys.repositories.list(companyId, { includeArchived: true }),
    queryFn: () => repositoriesApi.list(companyId, { includeArchived: true }),
    enabled: Boolean(companyId),
  });
  const repositories = repositoriesQuery.data ?? [];
  const selected = value
    .map((id) => repositories.find((repository) => repository.id === id))
    .filter((repository): repository is RepositoryCatalogItem => Boolean(repository));
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const selectable = repositories.filter((repository) => repository.state === "active" && !value.includes(repository.id));
    if (!needle) return selectable;
    return selectable.filter((repository) => repositoryLabel(repository).toLowerCase().includes(needle));
  }, [repositories, search, value]);
  const createRepository = useMutation({
    mutationFn: () => repositoriesApi.createManual(companyId, {
      cloneUrl: cloneUrl.trim(),
      defaultBranch: defaultBranch.trim() || null,
      visibility: "unknown",
    }),
    onSuccess: (repository) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repositories.all(companyId) });
      if (!value.includes(repository.id)) onChange([...value, repository.id]);
      setCloneUrl("");
      setDefaultBranch("");
      setAdding(false);
    },
  });

  const toggleRepository = (repositoryId: string) => {
    onChange(
      value.includes(repositoryId)
        ? value.filter((id) => id !== repositoryId)
        : [...value, repositoryId],
    );
  };

  return (
    <div className="space-y-2">
      {selected.length > 0 ? (
        <div className="space-y-1">
          {selected.map((repository) => (
            <div key={repository.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-2" title={repositoryLabel(repository)}>
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-xs">{repositoryName(repository)}</span>
                  <span className="block truncate text-(length:--text-micro) text-muted-foreground">{repository.host}</span>
                </span>
                {repository.state !== "active" ? (
                  <span className="text-(length:--text-micro) text-muted-foreground">{repository.state}</span>
                ) : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-6 px-2 text-muted-foreground"
                onClick={() => toggleRepository(repository.id)}
                disabled={disabled}
                aria-label={`Remove project hint ${repositoryLabel(repository)}`}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No repository hints. This project can still contain non-code work.</p>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="xs" disabled={disabled || !companyId}>
            <Plus className="mr-1 h-3 w-3" />
            Add repository
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-2" align="start">
          {adding ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">Add company repository</p>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => setAdding(false)} aria-label="Back to repositories">
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <Input value={cloneUrl} onChange={(event) => setCloneUrl(event.target.value)} placeholder="https://github.com/org/repo.git" />
              <Input value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} placeholder="Default branch (optional)" />
              {createRepository.isError ? <p className="text-xs text-destructive">Could not add this repository.</p> : null}
              <Button
                type="button"
                size="sm"
                className="w-full"
                disabled={!cloneUrl.trim() || createRepository.isPending}
                onClick={() => createRepository.mutate()}
              >
                {createRepository.isPending ? "Adding…" : "Add and select"}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-7" placeholder="Search company repositories" />
              </div>
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {filtered.map((repository) => {
                  const checked = value.includes(repository.id);
                  return (
                    <button
                      key={repository.id}
                      type="button"
                      className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent", checked && "bg-accent")}
                      onClick={() => toggleRepository(repository.id)}
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border">
                        {checked ? <Check className="h-3 w-3" /> : null}
                      </span>
                      <span className="min-w-0 flex-1" title={repositoryLabel(repository)}>
                        <span className="block truncate text-xs">{repositoryName(repository)}</span>
                        <span className="block truncate text-(length:--text-micro) text-muted-foreground">{repository.host}</span>
                      </span>
                      {repository.projectCount > 0 ? (
                        <span className="text-(length:--text-micro) text-muted-foreground">
                          {repository.projectCount} {repository.projectCount === 1 ? "project" : "projects"}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                {filtered.length === 0 ? <p className="px-2 py-3 text-center text-xs text-muted-foreground">No repositories match.</p> : null}
              </div>
              <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={() => setAdding(true)}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add new repository
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
