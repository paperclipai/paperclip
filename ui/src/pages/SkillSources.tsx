import { ProjectSkillRepositoryRow } from "@/components/skill-studio/ProjectSkillRepositoryRow";
import { SkillSourceConnectionRepair } from "@/components/skill-studio/SkillSourceConnectionRepair";
import { SkillSourceSyncControls } from "@/components/skill-studio/SkillSourceSyncControls";
import { GithubIcon } from "@/components/icons/github-icon";
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Plus, ExternalLink, Check, Lock, GitBranch, FileText, MoreVertical } from 'lucide-react';
import { parseGitHubSkillRepositoryUrl, type SkillSourceDisconnectRequest, type SkillSource, type SkillSourceDiscovery, type SkillSourceRefreshResult, type SkillSourceScanProgress } from '@paperclipai/shared';
import { Link, useNavigate, useParams } from '@/lib/router';
import { useCompany } from '@/context/CompanyContext';
import { useBreadcrumbs } from '@/context/BreadcrumbContext';
import { queryKeys } from '@/lib/queryKeys';
import { skillSourcesApi } from '@/api/skillSources';
import { ApiError } from '@/api/client';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import { appSourceConnectHref } from './apps/app-connect-policy';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RadioCardGroup } from '@/components/ui/radio-card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SkillImportProgress, type FoundSkill } from './skills/SkillImportProgress';
import { SkillPackagePreview } from './skills/SkillPackagePreview';
import { SkillSourceTree, type SkillTreeCandidate } from './skills/SkillSourceTree';
import { SkillImportWarnings, skillImportWarnings } from './skills/SkillImportWarnings';
import { timeAgo } from '@/lib/timeAgo';
import { skillRoute } from '@/lib/company-skill-routes';
import { consumeSkillSourceReturn, rememberSkillSourceReturn } from '@/lib/skill-source-connect-return';

const sourceKey = (companyId: string) => queryKeys.skillSources.all(companyId);
export function SkillSources() {
  const sourceActionButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { sourceId } = useParams<{ sourceId: string }>();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [results, setResults] = useState<Record<string, { message: string; failedAt: number; operation: 'refresh' | 'settings' } | null>>({});
  const [repairSourceId, setRepairSourceId] = useState<string | null>(null);
  const [disconnectSource, setDisconnectSource] = useState<SkillSource | null>(null);
  const companyId = selectedCompanyId ?? '';
  useEffect(() => { setBreadcrumbs([{ label: 'Skills', href: '/skills' }, { label: 'Sources' }]); }, [setBreadcrumbs]);
  const query = useQuery({ queryKey: sourceKey(companyId), queryFn: () => skillSourcesApi.list(companyId), enabled: Boolean(companyId), refetchInterval: 5000 });
  const repairSource = query.data?.find(source => source.id === repairSourceId);
  const projectRepositories = useQuery({ queryKey: queryKeys.skillSources.projects(companyId), queryFn: () => skillSourcesApi.projectRepositories(companyId), enabled: Boolean(companyId), refetchInterval: 5000 });
  async function invalidate() {
    await Promise.all([client.invalidateQueries({ queryKey: queryKeys.skillSources.projects(companyId) }), client.invalidateQueries({ queryKey: sourceKey(companyId) }), client.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) })]);
  }
  const refresh = useMutation({ mutationFn: (id: string) => skillSourcesApi.refresh(companyId, id), onSuccess: async result => {
    setResults(prev => ({ ...prev, [result.source.id]: null })); await invalidate();
  }, onError: (error, id) => { setResults(prev => ({ ...prev, [id]: { message: error.message, failedAt: Date.now(), operation: 'refresh' } })); void invalidate(); } });
  const adopt = useMutation({ mutationFn: (workspaceId: string) => skillSourcesApi.adoptProject(companyId, workspaceId), onSuccess: invalidate });
  const settings = useMutation({ mutationFn: ({ source, enabled }: { source: SkillSource; enabled: boolean }) => skillSourcesApi.settings(companyId, source.id, { revision: source.revision, automaticUpdates: enabled }),
    onSuccess: async (_result, variables) => { setResults(prev => ({ ...prev, [variables.source.id]: null })); await invalidate(); },
    onError: (error, variables) => setResults(prev => ({ ...prev, [variables.source.id]: { message: error.message, failedAt: Date.now(), operation: 'settings' } })) });
  const availableProjects = Array.isArray(projectRepositories.data) ? projectRepositories.data.filter(repo => !repo.sourceId) : [];
  const disconnect = useMutation({
    mutationFn: ({ source, skills }: { source: SkillSource; skills: SkillSourceDisconnectRequest['skills'] }) =>
      skillSourcesApi.disconnect(companyId, source.id, { revision: source.revision, skills }),
    onSuccess: async result => {
      client.setQueryData<SkillSource[]>(sourceKey(companyId), previous => previous?.filter(source => source.id !== result.id));
      await invalidate();
      await client.invalidateQueries({ queryKey: queryKeys.folders.list(companyId, 'skill') });
      setDisconnectSource(null);
    },
  });
  const reloadRemoval = useMutation({
    mutationFn: async () => {
      const result = await query.refetch({ throwOnError: true });
      return result.data?.find(source => source.id === disconnectSource?.id) ?? null;
    },
    onSuccess: source => { setDisconnectSource(source); disconnect.reset(); },
  });
  const staleRemoval = disconnect.error instanceof ApiError && disconnect.error.status === 409;
  const activeSource = query.data?.find(source => source.id === sourceId);
  if (!companyId) return <p className="p-6 text-sm text-muted-foreground">Select a company to manage skill sources.</p>;
  return <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-xl font-semibold">Skill sources</h1><p className="mt-1 text-sm text-muted-foreground">Skills from your repositories stay up to date automatically.</p></div>
      <Button onClick={() => navigate('/skills/sources/new')}><Plus className="size-4" />Import from GitHub</Button>
    </header>
    <Link to="/skills" className="text-sm text-muted-foreground hover:text-foreground">Installed skills</Link>
    {query.isPending && <p role="status" className="text-sm text-muted-foreground">Loading sources…</p>}
    {query.error && <p role="alert" className="text-sm text-destructive">{query.error.message} <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>Try again</Button></p>}
    {query.data?.length === 0 && availableProjects.length === 0 && <div className="flex flex-col items-start gap-3 py-8"><p className="text-sm text-muted-foreground">No repositories added yet. Import your skills to make them available in {selectedCompany?.name ?? 'this company'}.</p><Button variant="outline" onClick={() => navigate('/skills/sources/new')}>Import from GitHub</Button></div>}
    {projectRepositories.error && <p role="alert" className="text-sm text-destructive">{projectRepositories.error.message} <Button variant="ghost" size="sm" onClick={() => void projectRepositories.refetch()}>Try again</Button></p>}
    {adopt.error && <p role="alert" className="text-sm text-destructive">{adopt.error.message}</p>}
    {availableProjects.length > 0 && <div className="divide-y divide-border" aria-label="Project repositories">
      {availableProjects.map(repository => <ProjectSkillRepositoryRow key={repository.workspaceId} repository={repository}
        pending={adopt.isPending && adopt.variables === repository.workspaceId} onImport={() => adopt.mutate(repository.workspaceId)} />)}
    </div>}
    <div className="divide-y divide-border">
      {query.data?.map(source => {
        const installed = source.entries.filter(entry => entry.skillId);
        const newCount = source.entries.filter(entry => entry.selection === 'new' && entry.present).length;
        const result = results[source.id];
        const localError = result && result.message !== source.lastError
          && (result.operation === 'settings' || !source.lastSuccessAt || new Date(source.lastSuccessAt).getTime() < result.failedAt)
          ? result.message : null;
        return <section key={source.id} className="flex flex-col gap-3 py-4" aria-label={source.fullName}>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-0 basis-full items-start gap-3 sm:flex-1 sm:basis-auto"><GithubIcon className="size-5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1">
              <a href={source.repositoryUrl} target="_blank" rel="noreferrer" title={source.fullName} className="block truncate rounded-sm text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{source.fullName}</a>
              <p className="truncate text-xs text-muted-foreground">{source.trackingRef === 'HEAD' ? 'Default branch' : source.trackingRef}{source.lastSuccessAt ? ` · Updated ${timeAgo(source.lastSuccessAt)}` : ''}{source.accessScope === 'projects' ? ' · Project access' : ''}</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1">{source.projects?.map(project => <Link key={project.id} to={`/projects/${project.id}`} className="break-words text-xs text-muted-foreground hover:underline">{project.name}</Link>)}</div>
              {source.enabled && source.automaticUpdates === false && <p className="text-xs text-muted-foreground">Automatic updates paused</p>}
              {source.trackingActive === false && <p className="text-xs text-muted-foreground">Repository tracking stopped · installed skills kept</p>}
              {!source.enabled && <p className="text-xs text-muted-foreground">Disconnected</p>}
              {refresh.isPending && refresh.variables === source.id && <p role="status" className="text-xs text-muted-foreground">Refreshing…</p>}
              {newCount > 0 && <Link to={`/skills/sources/${source.id}`} className="text-xs underline">{newCount} new {newCount === 1 ? 'skill' : 'skills'} available</Link>}
            </div></div>
            <SkillSourceSyncControls showPreference={false} automaticUpdates={source.automaticUpdates ?? true}
              refreshing={source.syncState === 'refreshing' || (refresh.isPending && refresh.variables === source.id)}
              disabled={!source.enabled || settings.isPending} onRefresh={() => refresh.mutate(source.id)}
              onAutomaticUpdates={enabled => settings.mutate({ source, enabled })} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button ref={button => { sourceActionButtons.current[source.id] = button; }} size="icon-sm" variant="ghost" className="shrink-0" aria-label={`More actions for ${source.fullName}`}><MoreVertical className="size-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem checked={source.automaticUpdates ?? true} disabled={!source.enabled || settings.isPending}
                  onCheckedChange={enabled => settings.mutate({ source, enabled })}>Automatic updates</DropdownMenuCheckboxItem>
                <DropdownMenuItem onSelect={() => navigate(`/skills/sources/${source.id}`)}>Select skills</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setRepairSourceId(source.id)}>Choose connection</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" disabled={disconnect.isPending} onSelect={() => { disconnect.reset(); reloadRemoval.reset(); setDisconnectSource(source); }}>{source.enabled ? 'Disconnect source' : 'Remove source'}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {installed.length > 0 && <ul className="ml-8 min-w-0" aria-label={`Installed skills from ${source.fullName}`}>
            {installed.map(entry => <li key={entry.id}>
              <Link to={skillRoute(entry.skillId!)} title={entry.path} className="group flex min-w-0 items-center gap-2 rounded-sm py-1 text-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium group-hover:underline">{entry.name}</span>
                {entry.description && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{entry.description}</span>}
                {!entry.present && <span className="text-xs text-muted-foreground">Removed from source · installed copy kept</span>}
              </Link>
            </li>)}
          </ul>}
          {installed.length === 0 && source.entries.length === 0 && source.syncState !== 'refreshing' && !source.lastError && <p className="ml-8 text-sm text-muted-foreground">
            No skills found yet.{source.enabled && source.automaticUpdates && source.importNewSkills ? ' New skills will be imported automatically.' : ''}
          </p>}
          {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
          <SkillImportWarnings warnings={skillImportWarnings(source.entries.filter(entry => entry.selection === 'selected'), source.repositoryPackage)} />
          {source.lastError && source.lastAttemptAt && <p className="text-xs text-muted-foreground">Last attempt {timeAgo(source.lastAttemptAt)}</p>}
          {source.lastError && <p role="alert" className="text-sm text-destructive">{source.lastError} <Link to={`/skills/sources/${source.id}`} className="underline">Review source</Link></p>}
          {source.lastError && <Button variant="outline" size="sm" className="self-start" onClick={() => setRepairSourceId(source.id)}>Choose connection</Button>}
          {source.connectionId && <Link to={`/apps/${source.connectionId}/permissions`} className="text-xs text-muted-foreground hover:text-foreground">Manage GitHub connection</Link>}
        </section>;
      })}
    </div>
    {repairSource && <SkillSourceConnectionRepair companyId={companyId} source={repairSource} onClose={() => setRepairSourceId(null)} onReturnFocus={() => sourceActionButtons.current[repairSource.id]?.focus()} onSaved={async () => {
      setResults(prev => ({ ...prev, [repairSource.id]: null })); await invalidate();
    }} />}
    {disconnectSource && <DisconnectSourceDialog key={`${disconnectSource.id}:${disconnectSource.revision}`} source={disconnectSource}
      pending={disconnect.isPending || reloadRemoval.isPending} error={reloadRemoval.error?.message ?? disconnect.error?.message}
      stale={staleRemoval} onReload={() => reloadRemoval.mutate()} onChoiceChange={() => { if (!staleRemoval) disconnect.reset(); }}
      onClose={() => setDisconnectSource(null)}
      onConfirm={skills => disconnect.mutate({ source: disconnectSource, skills })} />}
    {sourceId && (sourceId === 'new' || activeSource) && <SourceDialog key={`${companyId}:${sourceId}`} companyId={companyId} source={activeSource} onClose={() => navigate('/skills/sources')} onSaved={async result => {
      setResults(prev => ({ ...prev, [result.source.id]: null })); await invalidate(); navigate('/skills/sources');
    }} />}
    {sourceId && sourceId !== 'new' && query.isSuccess && !activeSource && <p role="alert" className="text-sm text-destructive">Source not found.</p>}
  </div>;
}

function DisconnectSourceDialog({ source, pending, error, stale, onReload, onClose, onConfirm, onChoiceChange }: {
  source: SkillSource; pending: boolean; error?: string; stale: boolean; onReload: () => void; onClose: () => void;
  onConfirm: (skills: SkillSourceDisconnectRequest['skills']) => void; onChoiceChange: () => void;
}) {
  const count = new Set(source.entries.flatMap(entry => entry.skillId ? [entry.skillId] : [])).size;
  const [choice, setChoice] = useState<SkillSourceDisconnectRequest['skills'] | ''>('');
  const action = source.enabled ? 'Disconnect source' : 'Remove source';
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{source.enabled ? 'Disconnect' : 'Remove'} {source.fullName}?</DialogTitle>
        <DialogDescription>{count ? `Remove this repository from Sources. What should happen to its ${count} imported ${count === 1 ? 'skill' : 'skills'}?` : 'Remove this repository from Sources.'}</DialogDescription>
      </DialogHeader>
      {count > 0 && <RadioCardGroup ariaLabel="Imported skills" value={choice}
        onValueChange={value => { setChoice(value as SkillSourceDisconnectRequest['skills']); onChoiceChange(); }} disabled={pending}
        options={[
          { value: 'copy', title: 'Keep editable copies', description: source.accessScope === 'projects' ? 'Move them to My Skills, keeping project access restrictions. Assigned agents keep using them.' : 'Move them to My Skills. Assigned agents keep using them.' },
          { value: 'delete', title: 'Delete skills', description: 'Remove them from the library. Detach skills used by agents first.' },
        ]} />}

      {error && <div role="alert" className="text-sm text-destructive">{error}
        {stale && <Button variant="ghost" size="sm" disabled={pending} onClick={onReload}>Reload source</Button>}
      </div>}
      <div className="flex items-center justify-between gap-3">
        <Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button variant={choice === 'delete' ? 'destructive' : 'default'} disabled={pending || stale || Boolean(count && !choice)} onClick={() => onConfirm(choice || 'copy')}>
          {pending ? 'Removing…' : action}
        </Button>
      </div>
    </DialogContent>
  </Dialog>;
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
  const [preview, setPreview] = useState<{ skill: SkillTreeCandidate; filePath?: string; repository?: boolean } | null>(null);
  const [packageMode, setPackageMode] = useState<'skills' | 'repository'>(source ? draft.packageMode ?? source.packageMode : 'repository');
  const [discovery, setDiscovery] = useState<SkillSourceDiscovery | null>(!source && draft.packageMode === 'skills' ? null : draft.discovery ?? null);
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
  useEffect(() => { sessionStorage.setItem(draftKey, JSON.stringify({ revision: selectionRevision, packageMode, repositoryUrl, showRepositoryUrl, connectionId, discovery, selectedPaths: [...selected], excludedFolders })); }, [draftKey, selectionRevision, packageMode, repositoryUrl, showRepositoryUrl, connectionId, discovery, selected, excludedFolders]);
  const scanController = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<SkillSourceScanProgress | null>(null);
  const [found, setFound] = useState<FoundSkill[]>([]);
  useEffect(() => () => { scanController.current?.abort(); }, []);
  const scan = useMutation({ mutationFn: async (nextMode: 'skills' | 'repository' = packageMode) => {
    const controller = new AbortController();
    scanController.current?.abort();
    scanController.current = controller;
    setProgress(null); setFound([]);
    const discover = (mode: 'skills' | 'repository') => skillSourcesApi.discoverStream(companyId, { repositoryUrl, trackingRef: source?.trackingRef, packageMode: mode, connectionId: source ? sourceConnectionId : availableConnectionId }, event => {
      if (controller.signal.aborted || scanController.current !== controller) return;
      if (event.type === 'progress') setProgress(event);
      else setFound(previous => [...previous.filter(skill => skill.path !== event.candidate.path), event.candidate].slice(-5));
    }, controller.signal);
    let result = await discover(nextMode);
    // Shared dependencies need their original repository layout. Include that
    // layout automatically instead of asking the person to repair the package.
    if (nextMode === 'skills' && result.candidates.some(candidate => candidate.inspection?.references.some(reference => reference.kind === 'outside_package'))) {
      setFound([]);
      result = await discover('repository');
    }
    return { discovery: result, connectionId: result.connectionId === undefined ? availableConnectionId : result.connectionId, controller };
  }, onSuccess: result => {
    if (result.controller.signal.aborted || scanController.current !== result.controller) return;
    setDiscovery(result.discovery); setPackageMode(result.discovery.packageMode ?? packageMode); setConnectionId(result.connectionId);
    if (!source) { setSelected(new Set(result.discovery.candidates.map(candidate => candidate.path))); setExcludedFolders([]); }
  } });
  const save = useMutation({ mutationFn: () => source
    ? skillSourcesApi.select(companyId, source.id, { revision: selectionRevision!, packageMode, selectedPaths: [...selected], excludedFolders, connectionId: sourceConnectionId })
    : skillSourcesApi.create(companyId, { repositoryUrl: discovery!.repositoryUrl, trackingRef: discovery!.trackingRef, commitSha: discovery!.commitSha, packageMode, connectionId, selectedPaths: [...selected], excludedFolders }),
    onSuccess: async result => { sessionStorage.removeItem(draftKey); await onSaved(result); },
  });
  const candidates: SkillTreeCandidate[] = discovery?.candidates ?? (source ? source.entries.map(entry => ({ ...entry,
    note: !entry.present ? 'Removed from source · installed copy retained' : entry.selection === 'new' ? 'New skill' : entry.skillId ? 'Already imported' : undefined,
  })) : []);
  const ready = Boolean(source || discovery);
  const repositoryPackage = discovery?.repositoryPackage ?? source?.repositoryPackage;
  const warnings = skillImportWarnings(candidates.filter(candidate => selected.has(candidate.path)), packageMode === 'repository' ? repositoryPackage : null, discovery?.warnings);
  const selectionTree = <SkillSourceTree packageMode={packageMode} onPreview={(skill, filePath) => setPreview({ skill, filePath })} candidates={candidates} selected={selected} excludedFolders={excludedFolders} onChange={(paths, folders) => { setSelected(paths); setExcludedFolders(folders); }} disabled={scan.isPending || save.isPending} />;
  const selectedCount = candidates.filter(candidate => selected.has(candidate.path)).length;
  const busy = scan.isPending || save.isPending;
  const error = (scan.error?.name === 'AbortError' ? null : scan.error) ?? save.error;
  function stopScan() { scanController.current?.abort(); scanController.current = null; scan.reset(); setProgress(null); setFound([]); }
  function clearScan() { setDiscovery(null); scan.reset(); save.reset(); }
  function dismiss() { stopScan(); sessionStorage.removeItem(draftKey); onClose(); }
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) dismiss(); }}><DialogContent className="flex max-h-(--sz-calc-18) flex-col overflow-hidden p-4 sm:max-w-2xl sm:p-6" aria-describedby={source ? 'source-description' : undefined}>
    <DialogHeader className="shrink-0 flex-row items-start justify-between gap-3 pr-6">
      <div className="min-w-0"><DialogTitle>{source ? source.fullName : 'Import from GitHub'}</DialogTitle>{source && <DialogDescription id="source-description">Unchecked skills stay installed.</DialogDescription>}</div>
    </DialogHeader>
    <div className="min-h-0 space-y-4 overflow-y-auto">
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
      {ready && !save.isPending && !scan.isPending && <div className="space-y-3">
        {packageMode === 'repository' ? <>
          {candidates[0] && <Button variant="outline" size="sm" onClick={() => setPreview({ skill: candidates[0]!, repository: true })}><FileText className="size-4" />View {repositoryPackage?.files.length ?? 0} {repositoryPackage?.files.length === 1 ? 'file' : 'files'}</Button>}
        </> : null}
        {selectionTree}
        <SkillImportWarnings warnings={warnings} />
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error.message}{' '}<Link onClick={rememberReturn} to={connectHref} className="underline">Connect a GitHub account</Link></p>}
      {scan.isPending && <SkillImportProgress repository={parsedRepository?.fullName ?? repositoryUrl} progress={progress} found={found} />}
      {save.isPending && <SkillImportProgress importing repository={source?.fullName ?? discovery!.fullName} count={selectedCount}
        found={candidates.filter(candidate => selected.has(candidate.path) && !candidate.error).map(candidate => ({ ...candidate, fileCount: candidate.inspection?.files.length ?? 1 }))} />}
    </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border pt-4">
        <Button variant="ghost" disabled={save.isPending} onClick={() => { if (scan.isPending) stopScan(); else if (discovery && !source) clearScan(); else dismiss(); }}>{scan.isPending ? 'Cancel scan' : discovery && !source ? 'Back' : 'Cancel'}</Button>
        {ready ? <Button disabled={busy || (!source && packageMode === 'skills' && selectedCount === 0)} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : source ? 'Save selection' : packageMode === 'repository' ? 'Import repository' : `Import ${selectedCount} ${selectedCount === 1 ? "skill" : "skills"}`}</Button>
          : <Button disabled={busy || repositories.isPending || !repositoryUrl.trim()} onClick={() => scan.mutate(packageMode)}>{scan.isPending ? 'Scanning…' : 'Find skills'}</Button>}
      </footer>
    {preview && <SkillPackagePreview key={`${packageMode}:${preview.repository}:${preview.skill.path}:${preview.filePath ?? ''}`} companyId={companyId}
      repositoryPackage={preview.repository ? repositoryPackage ?? undefined : undefined}
      repository={{ packageMode, repositoryUrl: source?.repositoryUrl ?? discovery!.repositoryUrl, connectionId: source ? sourceConnectionId : connectionId }}
      commitSha={preview.skill.inspection?.commitSha ?? source?.lastScanCommit ?? discovery?.commitSha ?? null} skill={preview.skill} initialFile={preview.filePath} onClose={() => setPreview(null)} />}
  </DialogContent></Dialog>;
}
