import { GithubIcon } from "@/components/icons/github-icon";
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Plus, ExternalLink, Check, Lock, GitBranch, FileText, MoreVertical } from 'lucide-react';
import { parseGitHubSkillRepositoryUrl, type SkillSource, type SkillSourceDiscovery, type SkillSourceRefreshResult, type SkillSourceScanProgress } from '@paperclipai/shared';
import { Link, useNavigate, useParams } from '@/lib/router';
import { useCompany } from '@/context/CompanyContext';
import { useBreadcrumbs } from '@/context/BreadcrumbContext';
import { queryKeys } from '@/lib/queryKeys';
import { skillSourcesApi } from '@/api/skillSources';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import { appSourceConnectHref } from './apps/app-connect-policy';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SkillImportProgress, type FoundSkill } from './skills/SkillImportProgress';
import { SkillPackagePreview } from './skills/SkillPackagePreview';
import { SkillSourceTree, type SkillTreeCandidate } from './skills/SkillSourceTree';
import { timeAgo } from '@/lib/timeAgo';
import { skillRoute } from '@/lib/company-skill-routes';
import { consumeSkillSourceReturn, rememberSkillSourceReturn } from '@/lib/skill-source-connect-return';

const sourceKey = (companyId: string) => queryKeys.skillSources.all(companyId);
export function SkillSources() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { sourceId } = useParams<{ sourceId: string }>();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [results, setResults] = useState<Record<string, string>>({});
  const companyId = selectedCompanyId ?? '';
  useEffect(() => { setBreadcrumbs([{ label: 'Skills', href: '/skills' }, { label: 'Sources' }]); }, [setBreadcrumbs]);
  const query = useQuery({ queryKey: sourceKey(companyId), queryFn: () => skillSourcesApi.list(companyId), enabled: Boolean(companyId) });
  async function invalidate() {
    await Promise.all([client.invalidateQueries({ queryKey: sourceKey(companyId) }), client.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) })]);
  }
  const refresh = useMutation({ mutationFn: (id: string) => skillSourcesApi.refresh(companyId, id), onSuccess: async result => {
    setResults(prev => ({ ...prev, [result.source.id]: result.warnings.join(' · ') })); await invalidate();
  }, onError: (error, id) => { setResults(prev => ({ ...prev, [id]: error.message })); void invalidate(); } });
  const disconnect = useMutation({ mutationFn: (id: string) => skillSourcesApi.disconnect(companyId, id), onSuccess: invalidate });
  const activeSource = query.data?.find(source => source.id === sourceId);
  if (!companyId) return <p className="p-6 text-sm text-muted-foreground">Select a company to manage skill sources.</p>;
  return <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-xl font-semibold">Skill sources</h1><p className="mt-1 text-sm text-muted-foreground">Import skills from GitHub and refresh them when you’re ready.</p></div>
      <Button onClick={() => navigate('/skills/sources/new')}><Plus className="size-4" />Import from GitHub</Button>
    </header>
    <Link to="/skills" className="text-sm text-muted-foreground hover:text-foreground">Installed skills</Link>
    {query.isPending && <p role="status" className="text-sm text-muted-foreground">Loading sources…</p>}
    {query.error && <p role="alert" className="text-sm text-destructive">{query.error.message} <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>Try again</Button></p>}
    {disconnect.error && <p role="alert" className="text-sm text-destructive">{disconnect.error.message}</p>}
    {query.data?.length === 0 && <div className="flex flex-col items-start gap-3 py-8"><p className="text-sm text-muted-foreground">No repositories added yet. Import your skills to make them available in {selectedCompany?.name ?? 'this company'}.</p><Button variant="outline" onClick={() => navigate('/skills/sources/new')}>Import from GitHub</Button></div>}
    <div className="divide-y divide-border">
      {query.data?.map(source => {
        const installed = source.entries.filter(entry => entry.skillId);
        const newCount = source.entries.filter(entry => entry.selection === 'new' && entry.present).length;
        return <section key={source.id} className="@container flex flex-col gap-3 py-4" aria-label={source.fullName}>
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-3"><GithubIcon className="mt-1 size-5 shrink-0 text-muted-foreground" /><div className="min-w-0">
              <a href={source.repositoryUrl} target="_blank" rel="noreferrer" title={source.fullName} className="block truncate rounded-sm text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{source.fullName}</a>
              <p className="text-xs text-muted-foreground"><span className="break-all font-mono">{source.trackingRef === 'HEAD' ? 'Default branch' : source.trackingRef}</span> · <span className="inline-block">{installed.length} imported</span> · <span className="inline-block">{source.enabled ? source.lastSuccessAt ? `Refreshed ${timeAgo(source.lastSuccessAt)}` : 'Not refreshed yet' : 'Disconnected'}</span></p>
              {newCount > 0 && <Link to={`/skills/sources/${source.id}`} className="text-xs underline">{newCount} new {newCount === 1 ? 'skill' : 'skills'} available</Link>}
            </div></div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="outline" aria-label={refresh.isPending && refresh.variables === source.id ? 'Refreshing…' : 'Refresh'} title="Refresh source" disabled={!source.enabled || refresh.isPending} onClick={() => refresh.mutate(source.id)}><RefreshCw className={refresh.isPending && refresh.variables === source.id ? 'size-4 motion-safe:animate-spin' : 'size-4'} /><span className="hidden @sm:inline">{refresh.isPending && refresh.variables === source.id ? 'Refreshing…' : 'Refresh'}</span></Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${source.fullName}`}><MoreVertical className="size-4" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => navigate(`/skills/sources/${source.id}`)}>Select skills</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" disabled={!source.enabled || disconnect.isPending} onSelect={() => disconnect.mutate(source.id)}>Disconnect source</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {installed.length > 0 && <ul className="ml-8 min-w-0" aria-label={`Installed skills from ${source.fullName}`}>
            {installed.map(entry => <li key={entry.id}>
              <Link to={skillRoute(entry.skillId!)} title={entry.path} className="group flex min-w-0 items-center gap-2 rounded-sm py-1 text-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium group-hover:underline">{entry.name}</span>
                {entry.description && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{entry.description}</span>}
              </Link>
            </li>)}
          </ul>}
          {results[source.id] && <p role="status" className="text-xs text-muted-foreground">{results[source.id]}</p>}
          {source.lastError && source.lastAttemptAt && <p className="text-xs text-muted-foreground">Last attempt {timeAgo(source.lastAttemptAt)}</p>}
          {source.lastError && <p role="alert" className="text-sm text-destructive">{source.lastError} <Link to={`/skills/sources/${source.id}`} className="underline">Review source</Link></p>}
          {source.connectionId && <Link to={`/apps/${source.connectionId}/permissions`} className="text-xs text-muted-foreground hover:text-foreground">Manage GitHub connection</Link>}
        </section>;
      })}
    </div>
    {sourceId && (sourceId === 'new' || activeSource) && <SourceDialog key={`${companyId}:${sourceId}`} companyId={companyId} source={activeSource} onClose={() => navigate('/skills/sources')} onSaved={async result => {
      setResults(prev => ({ ...prev, [result.source.id]: result.warnings.join(' · ') })); await invalidate(); navigate('/skills/sources');
    }} />}
    {sourceId && sourceId !== 'new' && query.isSuccess && !activeSource && <p role="alert" className="text-sm text-destructive">Source not found.</p>}
  </div>;
}

function SourceDialog({ companyId, source, onClose, onSaved }: {
  companyId: string; source?: SkillSource; onClose: () => void; onSaved: (result: SkillSourceRefreshResult) => Promise<void>;
}) {
  const draftKey = `paperclip.skill-source-draft:${companyId}:${source?.id ?? 'new'}`;
  const [selectionRevision] = useState(source?.revision);
  const [draft] = useState(() => { try { const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? '{}'); return !source || saved.revision === source.revision ? saved : {}; } catch { return {}; } });
  const [repositoryUrl, setRepositoryUrl] = useState<string>(draft.repositoryUrl ?? source?.repositoryUrl ?? '');
  const [showRepositoryUrl, setShowRepositoryUrl] = useState<boolean>(draft.showRepositoryUrl ?? Boolean(draft.repositoryUrl));
  const [connectionId, setConnectionId] = useState<string | null>('connectionId' in draft ? draft.connectionId : source?.connectionId ?? null);
  const [preview, setPreview] = useState<{ skill: SkillTreeCandidate; filePath?: string } | null>(null);
  const [discovery, setDiscovery] = useState<SkillSourceDiscovery | null>(draft.discovery ?? null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(draft.selectedPaths ?? (source ? source.entries.filter(entry => entry.selection !== 'excluded').map(entry => entry.path) : [])));
  const [excludedFolders, setExcludedFolders] = useState<string[]>(draft.excludedFolders ?? source?.excludedFolders ?? []);
  const repositories = useQuery({ queryKey: queryKeys.skillSources.repositories(companyId), queryFn: () => skillSourcesApi.repositories(companyId), refetchOnMount: 'always', retry: false });
  const availableRepositories = repositories.data?.repositories ?? [];
  const parsedRepository = parseGitHubSkillRepositoryUrl(repositoryUrl);
  const matchingRepository = availableRepositories.find(repo => parseGitHubSkillRepositoryUrl(repo.url)?.repositoryUrl === parsedRepository?.repositoryUrl);
  // Only choose from the current caller's authorized repository inventory. The
  // server reauthorizes the chosen connection on every GitHub request.
  const matchingConnectionIds = matchingRepository?.connectionIds ?? [];
  const availableConnectionId = connectionId && matchingConnectionIds.includes(connectionId) ? connectionId : matchingConnectionIds[0] ?? null;
  const sourceConnectionId = availableConnectionId ?? source?.connectionId ?? null;
  const connectHref = appSourceConnectHref('github');
  const rememberReturn = () => rememberSkillSourceReturn(companyId, source?.id ?? 'new');
  useEffect(() => { consumeSkillSourceReturn(companyId); }, [companyId]);
  useEffect(() => { sessionStorage.setItem(draftKey, JSON.stringify({ revision: selectionRevision, repositoryUrl, showRepositoryUrl, connectionId, discovery, selectedPaths: [...selected], excludedFolders })); }, [draftKey, selectionRevision, repositoryUrl, showRepositoryUrl, connectionId, discovery, selected, excludedFolders]);
  const scanController = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<SkillSourceScanProgress | null>(null);
  const [found, setFound] = useState<FoundSkill[]>([]);
  useEffect(() => () => { scanController.current?.abort(); }, []);
  const scan = useMutation({ mutationFn: async () => {
    const controller = new AbortController();
    scanController.current?.abort();
    scanController.current = controller;
    setProgress(null); setFound([]);
    const result = await skillSourcesApi.discoverStream(companyId, { repositoryUrl, connectionId: availableConnectionId }, event => {
      if (controller.signal.aborted || scanController.current !== controller) return;
      if (event.type === 'progress') setProgress(event);
      else setFound(previous => [...previous.filter(skill => skill.path !== event.candidate.path), event.candidate].slice(-5));
    }, controller.signal);
    return { discovery: result, connectionId: result.connectionId === undefined ? availableConnectionId : result.connectionId, controller };
  }, onSuccess: result => {
    if (result.controller.signal.aborted || scanController.current !== result.controller) return;
    setDiscovery(result.discovery); setConnectionId(result.connectionId); setSelected(new Set(result.discovery.candidates.map(candidate => candidate.path))); setExcludedFolders([]);
  } });
  const save = useMutation({ mutationFn: () => source
    ? skillSourcesApi.select(companyId, source.id, { revision: selectionRevision!, selectedPaths: [...selected], excludedFolders, connectionId: sourceConnectionId })
    : skillSourcesApi.create(companyId, { repositoryUrl: discovery!.repositoryUrl, trackingRef: discovery!.trackingRef, commitSha: discovery!.commitSha, connectionId, selectedPaths: [...selected], excludedFolders }),
    onSuccess: async result => { sessionStorage.removeItem(draftKey); await onSaved(result); },
  });
  const candidates: SkillTreeCandidate[] = source ? source.entries.map(entry => ({ ...entry,
    note: !entry.present ? 'Removed from source · installed copy retained' : entry.selection === 'new' ? 'New skill' : entry.skillId ? 'Already imported' : undefined,
  })) : discovery?.candidates ?? [];
  const ready = Boolean(source || discovery);
  const eligibleCount = candidates.filter(candidate => selected.has(candidate.path) && !candidate.error).length;
  const skippedCount = candidates.filter(candidate => selected.has(candidate.path) && candidate.error).length;
  const busy = scan.isPending || save.isPending;
  const error = (scan.error?.name === 'AbortError' ? null : scan.error) ?? save.error;
  function stopScan() { scanController.current?.abort(); scanController.current = null; scan.reset(); setProgress(null); setFound([]); }
  function clearScan() { setDiscovery(null); scan.reset(); save.reset(); }
  function dismiss() { stopScan(); sessionStorage.removeItem(draftKey); onClose(); }
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) dismiss(); }}><DialogContent className="flex max-h-(--sz-calc-18) flex-col overflow-y-auto p-4 sm:max-w-2xl sm:p-6" aria-describedby={source ? 'source-description' : undefined}>
    <DialogHeader><DialogTitle>{source ? source.fullName : 'Import from GitHub'}</DialogTitle>{source && <DialogDescription id="source-description">Choose the skills to keep synced. Unchecked skills stay installed.</DialogDescription>}</DialogHeader>
      {!ready && !scan.isPending && <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          {availableRepositories.length > 0 && <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{availableRepositories.length} {availableRepositories.length === 1 ? 'repository' : 'repositories'}</span>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Refresh repositories" title="Refresh repositories" disabled={busy || repositories.isFetching} onClick={() => void repositories.refetch()}><RefreshCw className={repositories.isFetching ? 'size-3 animate-spin' : 'size-3'} /></Button>
            </div>
            <Button asChild variant="outline" size="sm"><Link onClick={rememberReturn} to={connectHref}><Plus className="size-4" />Add repos</Link></Button>
          </div>}
          {repositories.isPending && <p role="status" className="text-sm text-muted-foreground">Loading your GitHub repositories…</p>}
          {availableRepositories.length > 0 && <Command className="h-auto border border-border" label="Source repositories">
              <CommandInput placeholder="Search repositories…" aria-label="Search repositories" disabled={busy} />
              <CommandList className="max-h-48">
                <CommandEmpty>No matching repositories.</CommandEmpty>
                <CommandGroup>
                  {availableRepositories.map(repo => <CommandItem key={repo.id} value={repo.fullName} keywords={repo.connections} disabled={busy} onSelect={() => { setRepositoryUrl(repo.url); clearScan(); }}>
                    <GithubIcon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{repo.fullName}</span>
                      <span className="block truncate text-xs text-muted-foreground">{repo.connections.join(' · ')}</span>
                    </span>
                    {repo.private && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private repository" />}
                    {matchingRepository?.id === repo.id && <Check className="size-4 shrink-0" aria-label="Selected repository" />}
                  </CommandItem>)}
                </CommandGroup>
              </CommandList>
          </Command>}
          {(repositories.error || Boolean(repositories.data?.failedConnectionCount)) && <p role="alert" className="text-xs text-destructive">
            {availableRepositories.length ? 'Some GitHub connections could not load repositories.' : 'Could not load GitHub repositories.'}{' '}
            <Button variant="ghost" size="sm" disabled={repositories.isFetching} onClick={() => void repositories.refetch()}>Try again</Button>
            <Link to="/apps" className="underline">Manage connections</Link>
          </p>}
          {!repositories.isPending && availableRepositories.length === 0 && <Button asChild variant="outline" className="h-28 w-full flex-col gap-3 whitespace-normal text-center">
            <Link onClick={rememberReturn} to={connectHref}><GithubIcon className="size-6" />Connect GitHub to see your repos</Link>
          </Button>}
          <Button type="button" variant="link" size="sm" className="h-auto self-end p-0 text-xs font-normal text-muted-foreground underline" disabled={busy} aria-expanded={showRepositoryUrl} aria-controls="source-repository-url" onClick={() => setShowRepositoryUrl(true)}>... or add public repo by URL</Button>
        </div>
        {showRepositoryUrl && <label id="source-repository-url" className="flex flex-col gap-2 text-sm">Repository URL<Input autoFocus value={repositoryUrl} onChange={event => { setRepositoryUrl(event.target.value); clearScan(); }} placeholder="https://github.com/owner/repository" disabled={busy} /></label>}
      </div>}
      {ready && !save.isPending && <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {!source && <span className="break-all">{discovery?.fullName}</span>}
        <span className="inline-flex items-center gap-1.5"><GitBranch className="size-3.5" /><span className="font-mono">{source?.trackingRef === 'HEAD' ? 'Default branch' : source?.trackingRef ?? discovery?.trackingRef}</span></span>
        <a href={source?.repositoryUrl ?? discovery?.repositoryUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">View on GitHub<ExternalLink className="size-3" /></a>
      </div>}
      {source?.lastError && <p role="alert" className="text-sm text-destructive">{source.lastError}{' '}<Link onClick={rememberReturn} to={source.connectionId ? `/apps/${source.connectionId}/permissions` : connectHref} className="underline">Manage GitHub connection</Link></p>}
      {ready && !save.isPending && <SkillSourceTree onPreview={(skill, filePath) => setPreview({ skill, filePath })} candidates={candidates} selected={selected} excludedFolders={excludedFolders} onChange={(paths, folders) => { setSelected(paths); setExcludedFolders(folders); }} disabled={busy} />}
      {discovery?.warnings.map(warning => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
      {skippedCount > 0 && <p className="text-sm text-muted-foreground">{skippedCount} selected {skippedCount === 1 ? 'skill has' : 'skills have'} validation errors and will be skipped.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error.message}{' '}<Link onClick={rememberReturn} to={connectHref} className="underline">Connect a GitHub account</Link></p>}
      {scan.isPending && <SkillImportProgress repository={parsedRepository?.fullName ?? repositoryUrl} progress={progress} found={found} />}
      {save.isPending && <SkillImportProgress importing repository={source?.fullName ?? discovery!.fullName} count={eligibleCount}
        found={candidates.filter(candidate => selected.has(candidate.path) && !candidate.error).map(candidate => ({ ...candidate, fileCount: candidate.inspection?.files.length ?? 1 }))} />}
      <footer className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <Button variant="ghost" disabled={save.isPending} onClick={() => { if (scan.isPending) stopScan(); else if (discovery && !source) clearScan(); else dismiss(); }}>{scan.isPending ? 'Cancel scan' : discovery && !source ? 'Back' : 'Cancel'}</Button>
        {ready ? <Button disabled={busy || (!source && selected.size === 0)} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : source ? 'Save selection' : `Import ${eligibleCount} ${eligibleCount === 1 ? "skill" : "skills"}`}</Button>
          : <Button disabled={busy || repositories.isPending || !repositoryUrl.trim()} onClick={() => scan.mutate()}>{scan.isPending ? 'Scanning…' : 'Find skills'}</Button>}
      </footer>
    {preview && <SkillPackagePreview key={`${preview.skill.path}:${preview.filePath ?? ''}`} companyId={companyId}
      repository={{ repositoryUrl: source?.repositoryUrl ?? discovery!.repositoryUrl, connectionId: source ? sourceConnectionId : connectionId }}
      commitSha={preview.skill.inspection?.commitSha ?? source?.lastScanCommit ?? discovery?.commitSha ?? null} skill={preview.skill} initialFile={preview.filePath} onClose={() => setPreview(null)} />}
  </DialogContent></Dialog>;
}
