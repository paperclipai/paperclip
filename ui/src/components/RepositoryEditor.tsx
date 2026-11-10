import { useEffect, useRef, useState } from "react";
import type { ProjectRepository } from "@paperclipai/shared";
import { GitBranch, LockKeyhole, X } from "lucide-react";
import { Link } from "@/lib/router";
import { repositoryProviderLabel, repositoryProviders, type RepositoryProvider } from "./repository-providers";
import { SearchableSelect } from "./SearchableSelect";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

function RepoRow({ repo, onRemove }: { repo: ProjectRepository; onRemove: () => void }) {
  const provider = repo.provider ?? "github";
  const Icon = repositoryProviders.find((item) => item.id === provider)?.icon ?? GitBranch;
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium" title={repo.fullName}>{repo.fullName}</span>
        <span className="text-xs text-muted-foreground">{repositoryProviderLabel(provider)}</span>
        {repo.connections.length > 0 && <span className="truncate text-xs text-muted-foreground" title={repo.connections.join(" · ")}>
          {repo.connections.join(" · ")}
        </span>}
      </div>
      {repo.private && <LockKeyhole className="size-3 shrink-0 text-muted-foreground" aria-label="Private repository" />}
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${repo.fullName}`} onClick={onRemove}><X className="size-4" /></Button>
    </div>
  );
}

/** Shared by both review surfaces, ready to extract after design approval. */
export function RepositoryEditor({ selected, onChange, state = "ready", available = [], onRetry, onConnect, disabled = false }: {
  selected: ProjectRepository[];
  onChange: (repos: ProjectRepository[]) => void;
  state?: "ready" | "loading" | "disconnected" | "empty" | "error";
  available?: ProjectRepository[];
  onRetry: () => void;
  disabled?: boolean;
  onConnect: (provider: RepositoryProvider) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showPicker) picker.current?.querySelector<HTMLButtonElement>('[role="combobox"]')?.focus();
  }, [showPicker]);
  const options = available.filter((repo) => !selected.some((item) => item.id === repo.id)).map((repo) => ({
    key: repo.id, value: repo.id, label: repo.fullName,
    searchText: repo.connections.join(" "), repo,
  }));
  const addClassName = selected.length ? "self-start" : "h-24 w-full flex-col gap-2";
  const providers = [...new Set(available.map((repo) => repo.provider ?? "github"))];
  const catalogLoaded = state === "ready" || state === "empty" || state === "disconnected";
  const unavailableSelected = catalogLoaded
    ? selected.filter((repo) => !available.some((item) => item.id === repo.id))
    : [];
  const addLabel = selected.length ? "Add another repo" : "Add repository";
  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3">
      <div className="flex items-baseline gap-2"><span className="text-sm font-medium">Source repos</span><span className="text-xs text-muted-foreground">optional</span></div>
      {selected.map((repo) => <RepoRow key={repo.id} repo={repo} onRemove={() => onChange(selected.filter((item) => item.id !== repo.id))} />)}
      {unavailableSelected.map((repo) => <p key={`unavailable-${repo.id}`} role="status" className="text-xs text-muted-foreground">
        {repo.fullName} is no longer available in the connected provider catalog. Restore the provider connection or repository access to manage this selection.
      </p>)}
      {state === "disconnected" ? (
        <Popover>
          <PopoverTrigger asChild><Button type="button" variant="outline" className={addClassName}><GitBranch className="size-4" />{addLabel}</Button></PopoverTrigger>
          <PopoverContent align="start" className="w-72">
            <div className="flex flex-col gap-3">
              <GitBranch className="size-5" />
              <div className="flex flex-col gap-1"><p className="text-sm font-medium">Connect a provider to pick a repo</p><p className="text-xs text-muted-foreground">Choose a provider to connect your repositories.</p></div>
              {repositoryProviders.map((provider) => <Button key={provider.id} type="button" onClick={() => onConnect(provider)}><provider.icon className="size-4" />Connect {provider.label}</Button>)}
            </div>
          </PopoverContent>
        </Popover>
      ) : showPicker ? (
        <div ref={picker} className="flex flex-col gap-2">
          <SearchableSelect<string, (typeof options)[number]>
            value="" groups={providers.map((provider) => ({ id: provider, label: `Available ${repositoryProviderLabel(provider)} repositories`, options: options.filter((option) => (option.repo.provider ?? "github") === provider) }))}
            placeholder={addLabel} searchPlaceholder="Search repositories…"
            contentClassName="max-h-(--radix-popover-content-available-height) overflow-hidden [&_[data-slot=command]]:max-h-(--radix-popover-content-available-height) [&_[data-slot=command-list]]:min-h-0 [&_[data-slot=command-list]]:flex-1 [&_[data-slot=command-input-wrapper]]:shrink-0"
            loading={state === "loading"} loadingMessage="Loading repositories…"
            emptyMessage={state === "error" ? "Couldn’t load repositories. Try again." : state === "empty" ? "No repositories available. Connect an account with repository access." : "No matching repositories. Try another search or connection."}
            renderValue={() => <span className="flex items-center gap-2 text-foreground"><GitBranch className="size-4" />{addLabel}</span>}
            renderOption={({ repo }) => <><GitBranch className="size-4 shrink-0 text-muted-foreground" /><span className="flex min-w-0 flex-1 flex-col gap-1"><span className="truncate">{repo.fullName}</span><span className="truncate text-xs text-muted-foreground">{repositoryProviderLabel(repo.provider ?? "github")} · {repo.connections.join(" · ")}</span></span>{repo.private && <LockKeyhole className="size-3 shrink-0 text-muted-foreground" />}</>}
            onValueChange={(_, option) => { onChange([...selected, option.repo]); setShowPicker(false); }}
            createItem={state === "error" ? { render: () => <>Try again</>, onSelect: () => { onRetry(); } } : undefined}
          />
          <div className="flex flex-wrap gap-2">
            {repositoryProviders.map((provider) => <Button key={provider.id} type="button" variant="outline" size="sm" onClick={() => onConnect(provider)}><provider.icon className="size-4" />Connect {provider.label}</Button>)}
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Repositories from connected providers. <Link to="/apps" className="text-primary underline">Manage connections</Link></p>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowPicker(false)}>Cancel</Button>
          </div>
        </div>
      ) : <Button type="button" variant="outline" className={addClassName} onClick={() => setShowPicker(true)}><GitBranch className="size-4" />{addLabel}</Button>}
    </fieldset>
  );
}

