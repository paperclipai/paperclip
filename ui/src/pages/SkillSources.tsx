import { t as finalPagesT } from "@/i18n";
import { useTranslation } from "@/i18n";
import { ProjectSkillRepositoryRow } from "@/components/skill-studio/ProjectSkillRepositoryRow";
import { SkillSourceConnectionRepair } from "@/components/skill-studio/SkillSourceConnectionRepair";
import { SkillSourceBranchRepair } from "@/components/skill-studio/SkillSourceBranchRepair";
import { SkillSourceSyncControls } from "@/components/skill-studio/SkillSourceSyncControls";
import { SkillsPageNavigation } from "@/components/skill-studio/SkillsNavigationTabs";
import { GithubIcon } from "@/components/icons/github-icon";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Plus, ExternalLink, Check, Lock, GitBranch, FileText, MoreVertical, CircleAlert } from 'lucide-react';
import { parseGitHubSkillRepositoryUrl, type SkillSourceDisconnectRequest, type SkillSource, type SkillSourceDiscovery, type SkillSourceRefreshResult, type SkillSourceScanProgress } from '@paperclipai/shared';
import { Link, useNavigate, useParams } from '@/lib/router';
import { useCompany } from '@/context/CompanyContext';
import { useBreadcrumbs } from '@/context/BreadcrumbContext';
import { queryKeys } from '@/lib/queryKeys';
import { skillSourcesApi } from '@/api/skillSources';
import { ApiError } from '@/api/client';
import { describeError } from '@/api/errors';
import { QueryErrorState, useQueryView } from '@/components/QueryView';
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
import { groupProjectSkillRepositories } from '@/lib/project-skill-repositories';

const sourceKey = (companyId: string) => queryKeys.skillSources.all(companyId);
export function SkillSources() {
  const { t: translateAgentPage } = useTranslation("agents");
  const sourceActionButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { sourceId } = useParams<{ sourceId: string }>();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [results, setResults] = useState<Record<string, { message: string; failedAt: number; operation: 'refresh' | 'settings' } | null>>({});
  const [repairSourceId, setRepairSourceId] = useState<string | null>(null);
  const [branchSourceId, setBranchSourceId] = useState<string | null>(null);
  const [disconnectSource, setDisconnectSource] = useState<SkillSource | null>(null);
  const companyId = selectedCompanyId ?? '';
  useEffect(() => { setBreadcrumbs([{ label: translateAgentPage("agents:skills"), href: '/skills' }, { label: translateAgentPage("agents:sources") }]); }, [setBreadcrumbs, translateAgentPage]);
  const query = useQuery({ queryKey: sourceKey(companyId), queryFn: () => skillSourcesApi.list(companyId), enabled: Boolean(companyId), refetchInterval: 5000 });
  const repairSource = query.data?.find(source => source.id === repairSourceId);
  const branchSource = query.data?.find(source => source.id === branchSourceId);
  const projectRepositories = useQuery({ queryKey: queryKeys.skillSources.projects(companyId), queryFn: () => skillSourcesApi.projectRepositories(companyId), enabled: Boolean(companyId), refetchInterval: 5000 });
  const view = useQueryView(query);
  const projectsView = useQueryView(projectRepositories);
  async function invalidate() {
    await Promise.all([client.invalidateQueries({ queryKey: queryKeys.skillSources.projects(companyId) }), client.invalidateQueries({ queryKey: sourceKey(companyId) }), client.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) })]);
  }
  const refresh = useMutation({ mutationFn: (id: string) => skillSourcesApi.refresh(companyId, id), onSuccess: async result => {
    setResults(prev => ({ ...prev, [result.source.id]: null })); await invalidate();
  }, onError: (error, id) => { setResults(prev => ({ ...prev, [id]: { message: describeError(error).body, failedAt: Date.now(), operation: 'refresh' } })); void invalidate(); } });
  const adopt = useMutation({ mutationFn: async (group: ReturnType<typeof groupProjectSkillRepositories>[number]) => {
    for (const workspace of group.importableWorkspaces) await skillSourcesApi.adoptProject(companyId, workspace.workspaceId);
  }, onSuccess: invalidate, onError: () => { void invalidate(); } });
  const settings = useMutation({ mutationFn: ({ source, enabled }: { source: SkillSource; enabled: boolean }) => skillSourcesApi.settings(companyId, source.id, { revision: source.revision, automaticUpdates: enabled }),
    onSuccess: async (_result, variables) => { setResults(prev => ({ ...prev, [variables.source.id]: null })); await invalidate(); },
    onError: (error, variables) => setResults(prev => ({ ...prev, [variables.source.id]: { message: describeError(error).body, failedAt: Date.now(), operation: 'settings' } })) });
  const availableProjects = groupProjectSkillRepositories(Array.isArray(projectRepositories.data) ? projectRepositories.data.filter(repo => !repo.sourceId) : []);
  const groupSource = (group: typeof availableProjects[number]) => query.data?.find(source => source.repositoryUrl.toLowerCase() === group.repository.repositoryUrl.toLowerCase() && source.trackingRef === group.repository.trackingRef);
  const uninstalledProjects = availableProjects.filter(group => !groupSource(group));
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
  if (!companyId) return <p className="p-6 text-sm text-muted-foreground">{translateAgentPage("agents:select_a_company_to_manage_skill_sources")}</p>;
  return <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-xl font-semibold">{translateAgentPage("agents:skill_sources")}</h1><p className="mt-1 text-sm text-muted-foreground">{translateAgentPage("agents:skills_from_your_repositories_stay_up_to_date")}</p></div>
      <div className="flex items-center gap-2">
        <Button onClick={() => navigate('/skills/sources/new')}><Plus className="size-4" />{translateAgentPage("agents:import_from_github")}</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label={translateAgentPage("agents:more_source_actions")}><MoreVertical className="size-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild><Link to="/apps">{translateAgentPage("agents:manage_github_connection")}</Link></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
    <SkillsPageNavigation activeView="sources" />
    {(view.kind === 'loading' || view.kind === 'reconnecting') && <p role="status" className="text-sm text-muted-foreground">{translateAgentPage("agents:loading_sources")}</p>}
    {view.kind === 'error' && <QueryErrorState error={query.error} action={translateAgentPage("agents:load_skill_sources")} onRetry={view.retry} retrying={view.isFetching} />}
    {query.data?.length === 0 && availableProjects.length === 0 && <div className="flex flex-col items-start gap-3 py-8"><p className="text-sm text-muted-foreground">{translateAgentPage("agents:no_repositories_added_yet_import_your_skills_to")}{" "}{selectedCompany?.name ?? translateAgentPage("agents:this_company")}.</p><Button variant="outline" onClick={() => navigate('/skills/sources/new')}>{translateAgentPage("agents:import_from_github")}</Button></div>}
    {projectsView.kind === 'error' && <p role="alert" className="text-sm text-destructive">{describeError(projectRepositories.error).body} <Button variant="ghost" size="sm" onClick={() => void projectRepositories.refetch()}>{translateAgentPage("agents:try_again")}</Button></p>}
    {adopt.error && <p role="alert" className="text-sm text-destructive">{describeError(adopt.error).body}</p>}
    {uninstalledProjects.length > 0 && <div className="divide-y divide-border" aria-label={translateAgentPage("agents:project_repositories")}>
      {uninstalledProjects.map(group => <ProjectSkillRepositoryRow key={group.key} repository={group.repository} backgroundPending={group.hasPending} disabled={adopt.isPending}
        pending={adopt.isPending && adopt.variables?.key === group.key} onImport={() => adopt.mutate(group)} />)}
    </div>}
    <div className="divide-y divide-border">
      {query.data?.map(source => {
        const installed = source.entries.filter(entry => entry.skillId);
        const newCount = source.entries.filter(entry => entry.selection === 'new' && entry.present).length;
        const result = results[source.id];
        const projectGroup = availableProjects.find(group => groupSource(group)?.id === source.id);
        const importingProjectSkills = projectGroup && (projectGroup.hasPending || (adopt.isPending && adopt.variables?.key === projectGroup.key));
        const localError = result && result.message !== source.lastError
          && (result.operation === 'settings' || !source.lastSuccessAt || new Date(source.lastSuccessAt).getTime() < result.failedAt)
          ? result.message : null;
        return <section key={source.id} className="flex flex-col gap-3 py-4" aria-label={source.fullName}>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-0 basis-full items-start gap-3 sm:flex-1 sm:basis-auto"><GithubIcon className="size-5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1">
              <a href={source.repositoryUrl} target="_blank" rel="noreferrer" title={source.fullName} className="block truncate rounded-sm text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{source.fullName}</a>
              <p className="truncate text-xs text-muted-foreground">{source.trackingRef === 'HEAD' ? translateAgentPage("agents:default_branch") : source.trackingRef}{source.lastSuccessAt ? translateAgentPage("agents:updated", { value1: timeAgo(source.lastSuccessAt) }) : ''}{source.accessScope === 'projects' ? translateAgentPage("agents:project_access") : ''}{importingProjectSkills && <span role="status">{" "}{translateAgentPage("agents:importing_skills_13a86c")}</span>}</p>
              {source.enabled && source.automaticUpdates === false && <p className="text-xs text-muted-foreground">{translateAgentPage("agents:automatic_updates_paused")}</p>}
              {source.trackingActive === false && <p className="text-xs text-muted-foreground">{translateAgentPage("agents:repository_tracking_stopped_installed_skills_kept")}</p>}
              {!source.enabled && <p className="text-xs text-muted-foreground">{translateAgentPage("agents:disconnected")}</p>}
              {refresh.isPending && refresh.variables === source.id && <p role="status" className="text-xs text-muted-foreground">{translateAgentPage("agents:refreshing")}</p>}
              {newCount > 0 && <Link to={`/skills/sources/${source.id}`} className="text-xs underline">{finalPagesT("final-pages:newSkills", { count: newCount })}</Link>}
            </div></div>
            <SkillSourceSyncControls showPreference={false} automaticUpdates={source.automaticUpdates ?? true}
              refreshing={source.syncState === 'refreshing' || (refresh.isPending && refresh.variables === source.id)}
              disabled={!source.enabled || settings.isPending} onRefresh={() => refresh.mutate(source.id)}
              onAutomaticUpdates={enabled => settings.mutate({ source, enabled })} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button ref={button => { sourceActionButtons.current[source.id] = button; }} size="icon-sm" variant="ghost" className="shrink-0" aria-label={translateAgentPage("agents:more_actions_for", { value1: source.fullName })}><MoreVertical className="size-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem checked={source.automaticUpdates ?? true} disabled={!source.enabled || settings.isPending}
                  onCheckedChange={enabled => settings.mutate({ source, enabled })}>{translateAgentPage("agents:automatic_updates")}</DropdownMenuCheckboxItem>
                <DropdownMenuItem onSelect={() => navigate(`/skills/sources/${source.id}`)}>{translateAgentPage("agents:select_skills")}</DropdownMenuItem>
                {projectGroup && projectGroup.importableWorkspaces.length > 0 && <DropdownMenuItem disabled={adopt.isPending} onSelect={() => adopt.mutate(projectGroup)}>
                  {projectGroup.repository.status === 'error' ? translateAgentPage("agents:retry_project_import") : projectGroup.hasPending ? translateAgentPage("agents:import_remaining_project_skills") : translateAgentPage("agents:import_project_skills")}
                </DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => setRepairSourceId(source.id)}>{translateAgentPage("agents:choose_connection")}</DropdownMenuItem>
                {source.accessScope !== 'projects' && !source.projects?.some(project => project.active) && <DropdownMenuItem onSelect={() => setBranchSourceId(source.id)}>{translateAgentPage("agents:choose_a_new_branch")}</DropdownMenuItem>}
                <DropdownMenuItem variant="destructive" disabled={disconnect.isPending} onSelect={() => { disconnect.reset(); reloadRemoval.reset(); setDisconnectSource(source); }}>{source.enabled ? translateAgentPage("agents:disconnect_source") : translateAgentPage("agents:remove_source")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {projectGroup?.repository.lastError && <SourceErrorNotice message={projectGroup.repository.lastError} />}
          {installed.length > 0 && <ul className="ml-8 min-w-0" aria-label={translateAgentPage("agents:installed_skills_from", { value1: source.fullName })}>
            {installed.map(entry => <li key={entry.id}>
              <Link to={skillRoute(entry.skillId!)} title={entry.path} className="group flex min-w-0 items-center gap-2 rounded-sm py-1 text-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium group-hover:underline">{entry.name}</span>
                {entry.description && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{entry.description}</span>}
                {!entry.present && <span className="text-xs text-muted-foreground">{translateAgentPage("agents:removed_from_source_installed_copy_kept")}</span>}
              </Link>
            </li>)}
          </ul>}
          {installed.length === 0 && source.entries.length === 0 && source.syncState !== 'refreshing' && !source.lastError && <p className="ml-8 text-sm text-muted-foreground">{translateAgentPage("agents:no_skills_found_yet")}{source.enabled && source.automaticUpdates && source.importNewSkills ? translateAgentPage("agents:new_skills_will_be_imported_automatically") : ''}
          </p>}
          {localError && <SourceErrorNotice message={localError} />}
          <SkillImportWarnings warnings={skillImportWarnings(source.entries.filter(entry => entry.selection === 'selected'), source.repositoryPackage)} />
          {source.lastError && <SourceErrorNotice message={source.lastError}
            detail={source.lastAttemptAt ? translateAgentPage("agents:last_attempt", { value1: timeAgo(source.lastAttemptAt) }) : undefined}
            action={<Link to={`/skills/sources/${source.id}`} className="font-medium text-destructive underline underline-offset-2">{translateAgentPage("agents:review_source")}</Link>} />}
          {source.lastError && (source.repairAction === 'connection' || (!source.repairAction && !source.connectionId)) && <Button variant="outline" size="sm" className="self-start" onClick={() => setRepairSourceId(source.id)}>{translateAgentPage("agents:choose_connection")}</Button>}
          {source.lastError && source.repairAction === 'branch' && (source.accessScope === 'projects' || source.projects?.some(project => project.active)
            ? <div className="flex flex-wrap gap-3">{source.projects?.filter(project => project.active).map(project => <Link key={project.id} to={`/projects/${project.id}`} className="text-sm underline">{translateAgentPage("agents:update")}{" "}{project.name}{" "}{translateAgentPage("agents:repository")}</Link>)}</div>
            : <Button variant="outline" size="sm" className="self-start" onClick={() => setBranchSourceId(source.id)}>{translateAgentPage("agents:choose_a_new_branch")}</Button>)}
        </section>;
      })}
    </div>
    {branchSource && <SkillSourceBranchRepair companyId={companyId} source={branchSource} onClose={() => setBranchSourceId(null)}
      onReturnFocus={() => sourceActionButtons.current[branchSource.id]?.focus()} onSaved={async () => { setResults(prev => ({ ...prev, [branchSource.id]: null })); await invalidate(); }} />}
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
    {sourceId && sourceId !== 'new' && query.isSuccess && !activeSource && <p role="alert" className="text-sm text-destructive">{translateAgentPage("agents:source_not_found")}</p>}
  </div>;
}

function SourceErrorNotice({ message, detail, action }: { message: string; detail?: string; action?: ReactNode }) {
  return <div role="alert" className="ml-8 flex min-w-0 items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
    <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <p className="break-words text-foreground">{message}</p>
      {(detail || action) && <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {detail && <span className="text-muted-foreground">{detail}</span>}
        {action}
      </div>}
    </div>
  </div>;
}

function DisconnectSourceDialog({ source, pending, error, stale, onReload, onClose, onConfirm, onChoiceChange }: {
  source: SkillSource; pending: boolean; error?: string; stale: boolean; onReload: () => void; onClose: () => void;
  onConfirm: (skills: SkillSourceDisconnectRequest['skills']) => void; onChoiceChange: () => void;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  const count = new Set(source.entries.flatMap(entry => entry.skillId ? [entry.skillId] : [])).size;
  const [choice, setChoice] = useState<SkillSourceDisconnectRequest['skills'] | ''>('');
  const action = source.enabled ? translateAgentPage("agents:disconnect_source") : translateAgentPage("agents:remove_source");
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{source.enabled ? translateAgentPage("agents:disconnect") : translateAgentPage("agents:remove")} {source.fullName}?</DialogTitle>
        <DialogDescription>{count ? translateAgentPage("agents:remove_this_repository_from_sources_what_should_happen", { value1: count, value2: count === 1 ? translateAgentPage("agents:skill") : 'skills' }) : translateAgentPage("agents:remove_this_repository_from_sources")}</DialogDescription>
      </DialogHeader>
      {count > 0 && <RadioCardGroup ariaLabel={translateAgentPage("agents:imported_skills")} value={choice}
        onValueChange={value => { setChoice(value as SkillSourceDisconnectRequest['skills']); onChoiceChange(); }} disabled={pending}
        options={[
          { value: 'copy', title: translateAgentPage("agents:keep_editable_copies"), description: source.accessScope === 'projects' ? translateAgentPage("agents:move_them_to_my_skills_keeping_project_access") : translateAgentPage("agents:move_them_to_my_skills_assigned_agents_keep") },
          { value: 'delete', title: translateAgentPage("agents:delete_skills"), description: translateAgentPage("agents:remove_them_from_the_library_detach_skills_used") },
        ]} />}

      {error && <div role="alert" className="text-sm text-destructive">{error}
        {stale && <Button variant="ghost" size="sm" disabled={pending} onClick={onReload}>{translateAgentPage("agents:reload_source")}</Button>}
      </div>}
      <div className="flex items-center justify-between gap-3">
        <Button variant="outline" disabled={pending} onClick={onClose}>{translateAgentPage("agents:cancel")}</Button>
        <Button variant={choice === 'delete' ? 'destructive' : 'default'} disabled={pending || stale || Boolean(count && !choice)} onClick={() => onConfirm(choice || 'copy')}>
          {pending ? translateAgentPage("agents:removing") : action}
        </Button>
      </div>
    </DialogContent>
  </Dialog>;
}

function SourceDialog({ companyId, source, onClose, onSaved }: {
  companyId: string; source?: SkillSource; onClose: () => void; onSaved: (result: SkillSourceRefreshResult) => Promise<void>;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
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
  const repositories = useQuery({ queryKey: queryKeys.skillSources.repositories(companyId), queryFn: () => skillSourcesApi.repositories(companyId), refetchOnMount: 'always' });
  const repositoriesView = useQueryView(repositories);
  const repositoriesLoading = repositories.isPending || repositoriesView.kind === 'reconnecting';
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
    note: !entry.present ? translateAgentPage("agents:removed_from_source_installed_copy_retained") : entry.selection === 'new' ? translateAgentPage("agents:new_skill_a7b490") : entry.skillId ? translateAgentPage("agents:already_imported") : undefined,
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
      <div className="min-w-0"><DialogTitle>{source ? source.fullName : translateAgentPage("agents:import_from_github")}</DialogTitle>{source && <DialogDescription id="source-description">{translateAgentPage("agents:unchecked_skills_stay_installed")}</DialogDescription>}</div>
    </DialogHeader>
    <div className="min-h-0 space-y-4 overflow-y-auto">
      {!ready && !scan.isPending && <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          {availableRepositories.length > 0 && <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{availableRepositories.length} {availableRepositories.length === 1 ? translateAgentPage("agents:repository") : translateAgentPage("agents:repositories")}</span>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={translateAgentPage("agents:refresh_repositories")} title={translateAgentPage("agents:refresh_repositories")} disabled={busy || repositories.isFetching} onClick={() => void repositories.refetch()}><RefreshCw className={repositories.isFetching ? 'size-3 animate-spin' : 'size-3'} /></Button>
            </div>
            <Button asChild variant="outline" size="sm"><Link onClick={rememberReturn} to={connectHref}><Plus className="size-4" />{translateAgentPage("agents:add_repos")}</Link></Button>
          </div>}
          {repositoriesLoading && <p role="status" className="text-sm text-muted-foreground">{translateAgentPage("agents:loading_your_github_repositories")}</p>}
          {availableRepositories.length > 0 && <Command className="h-auto border border-border" label={translateAgentPage("agents:source_repositories")}>
              <CommandInput placeholder={translateAgentPage("agents:search_repositories")} aria-label={translateAgentPage("agents:search_repositories_22ea13")} disabled={busy} />
              <CommandList className="max-h-48">
                <CommandEmpty>{translateAgentPage("agents:no_matching_repositories")}</CommandEmpty>
                <CommandGroup>
                  {availableRepositories.map(repo => <CommandItem key={repo.id} value={repo.fullName} keywords={repo.connections} disabled={busy} onSelect={() => { setRepositoryUrl(repo.url); clearScan(); }}>
                    <GithubIcon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{repo.fullName}</span>
                      <span className="block truncate text-xs text-muted-foreground">{repo.connections.join(' · ')}</span>
                    </span>
                    {repo.private && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label={translateAgentPage("agents:private_repository")} />}
                    {matchingRepository?.id === repo.id && <Check className="size-4 shrink-0" aria-label={translateAgentPage("agents:selected_repository")} />}
                  </CommandItem>)}
                </CommandGroup>
              </CommandList>
          </Command>}
          {(repositoriesView.kind === 'error' || Boolean(repositories.data?.failedConnectionCount)) && <p role="alert" className="text-xs text-destructive">
            {availableRepositories.length ? translateAgentPage("agents:some_github_connections_could_not_load_repositories") : translateAgentPage("agents:could_not_load_github_repositories")}{' '}
            <Button variant="ghost" size="sm" disabled={repositories.isFetching} onClick={() => void repositories.refetch()}>{translateAgentPage("agents:try_again")}</Button>
            <Link to="/apps" className="underline">{translateAgentPage("agents:manage_connections")}</Link>
          </p>}
          {!repositoriesLoading && availableRepositories.length === 0 && <Button asChild variant="outline" className="h-28 w-full flex-col gap-3 whitespace-normal text-center">
            <Link onClick={rememberReturn} to={connectHref}><GithubIcon className="size-6" />{translateAgentPage("agents:connect_github_to_see_your_repos")}</Link>
          </Button>}
          <Button type="button" variant="link" size="sm" className="h-auto self-end p-0 text-xs font-normal text-muted-foreground underline" disabled={busy} aria-expanded={showRepositoryUrl} aria-controls="source-repository-url" onClick={() => setShowRepositoryUrl(true)}>{translateAgentPage("agents:or_add_public_repo_by_url")}</Button>
        </div>
        {showRepositoryUrl && <label id="source-repository-url" className="flex flex-col gap-2 text-sm">{translateAgentPage("agents:repository_url")}<Input autoFocus value={repositoryUrl} onChange={event => { setRepositoryUrl(event.target.value); clearScan(); }} placeholder="https://github.com/owner/repository" disabled={busy} /></label>}
      </div>}
      {ready && !save.isPending && <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {!source && <span className="break-all">{discovery?.fullName}</span>}
        <span className="inline-flex items-center gap-1.5"><GitBranch className="size-3.5" /><span className="font-mono">{source?.trackingRef === 'HEAD' ? translateAgentPage("agents:default_branch") : source?.trackingRef ?? discovery?.trackingRef}</span></span>
        <a href={source?.repositoryUrl ?? discovery?.repositoryUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">{translateAgentPage("agents:view_on_github")}<ExternalLink className="size-3" /></a>
      </div>}
      {source?.lastError && <p role="alert" className="text-sm text-destructive">{source.lastError}{' '}<Link onClick={rememberReturn} to={source.connectionId ? `/apps/${source.connectionId}/permissions` : connectHref} className="underline">{translateAgentPage("agents:manage_github_connection")}</Link></p>}
      {ready && !save.isPending && !scan.isPending && <div className="space-y-3">
        {packageMode === 'repository' ? <>
          {candidates[0] && <Button variant="outline" size="sm" onClick={() => setPreview({ skill: candidates[0]!, repository: true })}><FileText className="size-4" />{finalPagesT("final-pages:viewFiles", { count: repositoryPackage?.files.length ?? 0 })}</Button>}
        </> : null}
        {selectionTree}
        <SkillImportWarnings warnings={warnings} />
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{describeError(error).body}{' '}<Link onClick={rememberReturn} to={connectHref} className="underline">{translateAgentPage("agents:connect_a_github_account")}</Link></p>}
      {scan.isPending && <SkillImportProgress repository={parsedRepository?.fullName ?? repositoryUrl} progress={progress} found={found} />}
      {save.isPending && <SkillImportProgress importing repository={source?.fullName ?? discovery!.fullName} count={selectedCount}
        found={candidates.filter(candidate => selected.has(candidate.path) && !candidate.error).map(candidate => ({ ...candidate, fileCount: candidate.inspection?.files.length ?? 1 }))} />}
    </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border pt-4">
        <Button variant="ghost" disabled={save.isPending} onClick={() => { if (scan.isPending) stopScan(); else if (discovery && !source) clearScan(); else dismiss(); }}>{scan.isPending ? translateAgentPage("agents:cancel_scan") : discovery && !source ? translateAgentPage("agents:back") : translateAgentPage("agents:cancel")}</Button>
        {ready ? <Button disabled={busy || (!source && packageMode === 'skills' && selectedCount === 0)} onClick={() => save.mutate()}>{save.isPending ? translateAgentPage("agents:saving") : source ? translateAgentPage("agents:save_selection") : packageMode === 'repository' ? translateAgentPage("agents:import_repository") : translateAgentPage("agents:import_be75b5", { value1: selectedCount, value2: selectedCount === 1 ? translateAgentPage("agents:skill") : "skills" })}</Button>
          : <Button disabled={busy || repositories.isPending || !repositoryUrl.trim()} onClick={() => scan.mutate(packageMode)}>{scan.isPending ? translateAgentPage("agents:scanning") : translateAgentPage("agents:find_skills")}</Button>}
      </footer>
    {preview && <SkillPackagePreview key={`${packageMode}:${preview.repository}:${preview.skill.path}:${preview.filePath ?? ''}`} companyId={companyId}
      repositoryPackage={preview.repository ? repositoryPackage ?? undefined : undefined}
      repository={{ packageMode, repositoryUrl: source?.repositoryUrl ?? discovery!.repositoryUrl, connectionId: source ? sourceConnectionId : connectionId }}
      commitSha={preview.skill.inspection?.commitSha ?? source?.lastScanCommit ?? discovery?.commitSha ?? null} skill={preview.skill} initialFile={preview.filePath} onClose={() => setPreview(null)} />}
  </DialogContent></Dialog>;
}
