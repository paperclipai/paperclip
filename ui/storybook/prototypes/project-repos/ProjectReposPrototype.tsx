import { RepositoryEditor as ProductionRepositoryEditor } from "@/components/RepositoryEditor";
import { useEffect, useMemo, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CONNECTABLE_APP_DEFINITIONS } from "@paperclipai/shared";
import { Check, GitBranch, Link, LockKeyhole, Folder, Plus, X } from "lucide-react";
import { GithubIcon } from "@/components/icons/github-icon";
import { SearchableSelect } from "@/components/SearchableSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { queryKeys } from "@/lib/queryKeys";
import { availableRepositories, type Repository, type RepositoryState } from "./fixtures";

// Everything in this directory is a local, interactive design proposal.
// Production screens, persistence, authorization, and API contracts are unchanged.

function GitHubConnectionPreview({ onComplete, onCancel }: { onComplete: () => void; onCancel: () => void }) {
  const client = useMemo(() => {
    const c = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnMount: false } } });
    c.setQueryData(queryKeys.apps.gallery("company-storybook"), {
      // Mirror an enrolled instance's gallery response; raw catalog defaults
      // hide platform_shared OAuth and would otherwise show the PAT fallback.
      apps: CONNECTABLE_APP_DEFINITIONS.filter((app) => app.slug === "github").map((app) => ({
        ...app,
        ownershipAvailability: { platform_shared: true, platform_provisioned: false, customer: true, dcr: true },
      })),
      capabilities: { canSetCompanyInstall: true, canCreateOrganizationGrant: true, canConnectAsCurrentUser: true },
    });
    c.setQueryData(queryKeys.tools.applications("company-storybook"), { applications: [] });
    c.setQueryData(queryKeys.tools.connections("company-storybook"), { connections: [] });
    return c;
  }, []);
  return (
    <QueryClientProvider client={client}>
      <div onClickCapture={(event) => {
        // Use the exact existing connector UI. Only the provider handoff is
        // simulated: no popup, OAuth request, or connection mutation in stories.
        const button = (event.target as HTMLElement).closest("button");
        if (button?.textContent?.trim() === "Continue to GitHub") {
          event.preventDefault();
          event.stopPropagation();
          onComplete();
        }
      }}>
        <ConnectionSetupFlow host="dialog" serviceSlug="github" onComplete={onComplete} onCancel={onCancel} />
      </div>
    </QueryClientProvider>
  );
}

function RepositoryEditor({ selected, onChange, initialState = "ready", personalOnly = false, onConnect }: {
  selected: Repository[]; onChange: (repos: Repository[]) => void; initialState?: RepositoryState; personalOnly?: boolean; onConnect: () => void;
}) {
  const [state, setState] = useState(initialState);
  return <ProductionRepositoryEditor selected={selected} onChange={(repos) => onChange(repos.map((repo) => ({ ...repo, private: repo.private ?? false })))} state={state}
    available={state === "ready" ? availableRepositories(personalOnly) : []}
    onConnect={onConnect} onRetry={() => setState("ready")} />;
}

export interface PrototypeProps {
  initialName?: string;
  initialState?: RepositoryState;
  initialRepoIds?: string[];
  personalOnly?: boolean;
  legacyUrl?: string;
  startConnecting?: boolean;
}

function useRepoDraft(props: PrototypeProps) {
  const [repos, setRepos] = useState(() => availableRepositories().filter((repo) => props.initialRepoIds?.includes(repo.id)));
  const [connecting, setConnecting] = useState(props.startConnecting ?? false);
  const [connected, setConnected] = useState(false);
  const [revision, setRevision] = useState(0);
  return { repos, setRepos, connecting, setConnecting, revision,
    state: connected ? "ready" as const : props.initialState ?? "ready",
    finishConnection: () => { setConnected(true); setConnecting(false); setRevision((n) => n + 1); },
  };
}

export function NewProjectPrototype(props: PrototypeProps) {
  const draft = useRepoDraft(props);
  const [name, setName] = useState(props.initialName ?? "");
  const [open, setOpen] = useState(true);
  const [created, setCreated] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Button type="button" onClick={() => { setOpen(true); setCreated(false); }}>Open new project</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} aria-describedby={undefined}
          className="flex max-h-(--sz-calc-18) flex-col gap-0 overflow-hidden p-0 shadow-sm sm:max-w-lg"
          onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); input.current?.select(); }}>
          {(draft.connecting || created) && <DialogTitle className="sr-only">{draft.connecting ? "Connect GitHub" : "Create project"}</DialogTitle>}
          {draft.connecting ? <div className="min-h-0 overflow-y-auto p-5"><GitHubConnectionPreview onComplete={draft.finishConnection} onCancel={() => draft.setConnecting(false)} /></div> : created ? (
            <div className="flex flex-col items-center gap-4 p-8">
              <Check className="size-6" /><h2 className="text-xl font-bold">{name}</h2>
              <p role="status" className="text-sm text-muted-foreground">Project preview created with {draft.repos.length} {draft.repos.length === 1 ? "repo" : "repos"}.</p>
              <Button type="button" onClick={() => setCreated(false)}>Back to project draft</Button>
            </div>
          ) : (
            <form className="flex min-h-0 flex-col overflow-hidden" onSubmit={(event) => { event.preventDefault(); if (name.trim()) setCreated(true); }}>
              <div className="flex shrink-0 flex-col gap-4 px-5 pb-4 pt-5">
                <div className="flex items-center justify-between gap-3">
                  <DialogTitle className="text-lg font-semibold">Create project</DialogTitle>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Close new project" onClick={() => setOpen(false)}><X className="size-4" /></Button>
                </div>
                <div className="flex items-center gap-3 rounded-lg border border-input px-3 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
                  <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <input ref={input} aria-label="Project name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" required
                    className="h-10 w-full min-w-0 border-0 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm" />
                </div>
              </div>
              <div role="region" aria-label="Source repositories" tabIndex={0} className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
                <RepositoryEditor key={draft.revision} selected={draft.repos} onChange={draft.setRepos} initialState={draft.state} personalOnly={props.personalOnly} onConnect={() => draft.setConnecting(true)} />
              </div>
              <div className="flex shrink-0 justify-end gap-2 px-5 py-5">
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={!name.trim()}>Create project</Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function RepositoryConfigurationSection(props: PrototypeProps) {
  const draft = useRepoDraft(props);
  const [legacyUrl, setLegacyUrl] = useState(props.legacyUrl ?? "");
  const [editingLegacy, setEditingLegacy] = useState(false);
  const [saved, setSaved] = useState({ repos: draft.repos, legacyUrl });
  const [notice, setNotice] = useState("");
  const dirty = JSON.stringify(draft.repos) !== JSON.stringify(saved.repos) || legacyUrl !== saved.legacyUrl;
  return (
    <div>
      <section className="flex flex-col gap-4" aria-label="Repositories">
        <RepositoryEditor key={draft.revision} selected={draft.repos} onChange={(repos) => { draft.setRepos(repos); setNotice(""); }} initialState={draft.state} personalOnly={props.personalOnly} onConnect={() => draft.setConnecting(true)} />
        {props.legacyUrl && <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">Existing repo URL</span>
          {editingLegacy ? <div className="flex flex-col gap-2"><Input aria-label="Existing repo URL" type="url" value={legacyUrl} onChange={(event) => { setLegacyUrl(event.target.value); setNotice(""); }} /><Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => setEditingLegacy(false)}>Done</Button></div> : <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2"><Link className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 break-all text-sm">{legacyUrl || "No URL set"}</span><Button type="button" variant="ghost" size="sm" onClick={() => setEditingLegacy(true)}>Edit</Button></div>}
          <p className="text-xs text-muted-foreground">Your existing URL is preserved alongside selected GitHub repos.</p>
        </div>}
        <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
          {notice && <span role="status" className="mr-auto text-sm text-muted-foreground">{notice}</span>}
          {dirty && <Button type="button" variant="ghost" onClick={() => { draft.setRepos(saved.repos); setLegacyUrl(saved.legacyUrl); setNotice(""); }}>Discard changes</Button>}
          <Button type="button" disabled={!dirty || editingLegacy} onClick={() => { setSaved({ repos: draft.repos, legacyUrl }); setNotice("Changes saved in preview"); }}>Save changes</Button>
        </div>
      </section>
      <Dialog open={draft.connecting} onOpenChange={draft.setConnecting}><DialogContent showCloseButton={false} aria-describedby={undefined} className="max-h-dvh overflow-y-auto sm:max-w-2xl"><DialogTitle className="sr-only">Connect GitHub</DialogTitle><GitHubConnectionPreview onComplete={draft.finishConnection} onCancel={() => draft.setConnecting(false)} /></DialogContent></Dialog>
    </div>
  );
}
