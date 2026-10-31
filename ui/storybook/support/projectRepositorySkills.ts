import type { QueryClient } from '@tanstack/react-query';
import type { ProjectSkillRepository, RoutineRunSummary, Issue } from '@paperclipai/shared';
import { buildSkillMentionHref } from '@paperclipai/shared';
import { skillSourcesApi } from '@/api/skillSources';
import { companySkillsApi } from '@/api/companySkills';
import { projectsApi } from '@/api/projects';
import { routinesApi } from '@/api/routines';
import { activityApi } from '@/api/activity';
import { heartbeatsApi } from '@/api/heartbeats';
import { emailApi } from '@/api/email';
import { ApiError } from '@/api/client';
import { issuesApi } from '@/api/issues';
import { queryKeys } from '@/lib/queryKeys';
import { baseRoutine } from '../fixtures/routineWebhooks';
import { storybookProjects, storybookIssues } from '../fixtures/paperclipData';
import { COMPANY_ID, SOURCE_ID, COMMIT, installFixtures, candidates, sourceFixture } from '../fixtures/githubSkillSources';

export type Scenario = 'new-project' | 'attach-repository' | 'legacy' | 'duplicate' | 'partial-adoption' | 'missing-branch' | 'ready' | 'refreshing' | 'error' | 'empty' | 'private' | 'shared' | 'shared-private' | 'long' | 'many' | 'paused' | 'removed' | 'validation' | 'repair' | 'repair-conflict' | 'automatic' | 'latest';
export const projectRepository: ProjectSkillRepository = {
  projectId: 'project-skills', projectName: 'Acme platform', projectVisibility: 'open',
  workspaceId: 'workspace-skills', repositoryUrl: 'https://github.com/acme/team-skills', trackingRef: 'main',
  bindingId: null, sourceId: null, status: 'available', lastError: null,
};
export const ROUTINE_ID = 'routine-project-skills';
const NEW_COMMIT = 'b'.repeat(40);

/** All mutations are scoped in-memory API fixtures. No provider calls or server writes. */
export function installProjectSkillFixtures(scenario: Scenario, client: QueryClient) {
  const cleanup = installFixtures(['new-project', 'legacy', 'duplicate'].includes(scenario), false, { journey: true, repositories: 'multiple' });
  const baseSources = { ...skillSourcesApi }, baseSkills = { ...companySkillsApi };
  const originalActivity = { ...activityApi }, originalHeartbeats = { ...heartbeatsApi };
  const originalEmailThread = emailApi.thread;
  const originalProjects = { ...projectsApi }, originalRoutines = { ...routinesApi }, originalIssues = { ...issuesApi };
  const timers: ReturnType<typeof setTimeout>[] = [];
  let projectCreated = scenario !== 'new-project';
  const updatedSources = new Set<string>();
  const sourcePreferences = new Map<string, { automaticUpdates?: boolean; importNewSkills?: boolean; connectionId?: string | null; trackingRef?: string }>();
  let live = true, automaticUpdates = scenario !== 'paused', failed = ['error', 'repair', 'repair-conflict', 'missing-branch'].includes(scenario);
  let sourceRevision = sourceFixture().revision, repairConflict = scenario === 'repair-conflict';
  const privateProject = scenario === 'private';
  let repository = { ...projectRepository, projectName: scenario === 'partial-adoption' ? 'Paperclip' : projectRepository.projectName,
    projectVisibility: privateProject ? 'private' as const : 'open' as const };
  if (!['new-project', 'legacy', 'duplicate'].includes(scenario)) repository = { ...repository, sourceId: SOURCE_ID, bindingId: 'binding-skills', status: 'ready' };
  let additionalRepositories: ProjectSkillRepository[] = scenario === 'duplicate' ? [{ ...repository, workspaceId: 'second-workspace', projectId: 'second-project', projectName: 'Sentry' }]
    : scenario === 'partial-adoption' ? [
      { ...repository, workspaceId: 'cloud-workspace', projectId: 'paperclip-cloud', projectName: 'Paperclip Cloud', sourceId: null, bindingId: null, status: 'available' },
      { ...repository, workspaceId: 'sentry-workspace', projectId: 'sentry', projectName: 'Sentry', sourceId: null, bindingId: null, status: 'available' },
    ] : [];
  let project = { ...storybookProjects[0]!, id: repository.projectId, urlKey: repository.projectId, name: repository.projectName, companyId: COMPANY_ID,
    workspaces: storybookProjects[0]!.workspaces.slice(0, 1).map(workspace => ({ ...workspace, id: repository.workspaceId, projectId: repository.projectId, repoUrl: repository.repositoryUrl, repoRef: 'main', defaultRef: 'main', name: 'acme/team-skills', metadata: { ...workspace.metadata, githubRepositoryId: '123456' } })) };
  const workspaceTemplate = project.workspaces[0]!;
  const invalidate = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.skillSources.all(COMPANY_ID) }),
      client.invalidateQueries({ queryKey: queryKeys.companySkills.list(COMPANY_ID) }),
      client.invalidateQueries({ queryKey: ['project-skill-repositories', COMPANY_ID] }),
      client.invalidateQueries({ queryKey: queryKeys.routines.detail(ROUTINE_ID) }),
    ]);
  };
  const delay = (ms: number) => new Promise<void>(resolve => timers.push(setTimeout(resolve, ms)));
  const available = () => candidates.filter(candidate => !candidate.error && !candidate.path.startsWith('experimental/')).map(candidate => candidate.path);
  function updateRepository(row: ProjectSkillRepository) {
    if (row.workspaceId === projectRepository.workspaceId) repository = row;
    else additionalRepositories = additionalRepositories.map(existing => existing.workspaceId === row.workspaceId ? row : existing);
  }
  async function adopt(row = repository) {
    const bindingId = `binding-${row.workspaceId}`;
    updateRepository({ ...row, status: 'pending', bindingId });
    await invalidate(); await delay(600);
    if (!live) return;
    const existing = (await baseSources.list(COMPANY_ID)).find(source => source.repositoryUrl === row.repositoryUrl && source.trackingRef === row.trackingRef);
    const source = existing ?? (await baseSources.create(COMPANY_ID, { repositoryUrl: row.repositoryUrl, trackingRef: row.trackingRef,
      commitSha: COMMIT, connectionId: 'github-storybook', packageMode: 'repository', selectedPaths: available(), excludedFolders: ['experimental'] })).source;
    updateRepository({ ...row, bindingId, sourceId: source.id, status: 'ready' });
    await invalidate();
  }
  async function refresh(_companyId = COMPANY_ID, requestedSourceId?: string) {
    await delay(450);
    if (failed) { failed = false; throw new Error('GitHub could not be reached. The installed skills were kept. Try again.'); }
    const sourceId = requestedSourceId ?? (await baseSources.list(COMPANY_ID))[0]!.id;
    const result = await baseSources.refresh(COMPANY_ID, sourceId);
    await baseSources.select(COMPANY_ID, sourceId, { revision: result.source.revision, selectedPaths: available(), excludedFolders: ['experimental'] });
    updatedSources.add(sourceId);
    return { ...result, source: (await skillSourcesApi.list(COMPANY_ID))[0]! };
  }
  skillSourcesApi.list = async companyId => (await baseSources.list(companyId)).map(source => ({ ...source,
    revision: Math.max(source.revision, sourceRevision),
    automaticUpdates, importNewSkills: true, ...sourcePreferences.get(source.id), accessScope: scenario === 'missing-branch' ? 'company' : 'projects',
    syncState: scenario === 'refreshing' ? 'refreshing' : failed ? 'error' : automaticUpdates ? 'ready' : 'paused',
    fullName: scenario === 'long' ? 'acme/platform-services-production-web-accessibility-improvements' : source.fullName,
    lastScanCommit: updatedSources.has(source.id) ? NEW_COMMIT : source.lastScanCommit,
    lastError: failed ? scenario === 'missing-branch' ? 'The tracked GitHub branch or revision is unavailable. Use the repository’s default branch or update its configured ref.' : scenario.startsWith('repair') ? 'The person who connected this source no longer has company access. Choose another GitHub connection.'
      : 'GitHub could not be reached. The installed skills were kept.' : null,
    repairAction: !failed ? null : scenario === 'missing-branch' ? 'branch' : scenario.startsWith('repair') ? 'connection' : 'retry',
    projects: scenario === 'missing-branch' ? [] : ['shared', 'shared-private'].includes(scenario) ? [{ id: project.id, name: 'Private research', visibility: 'private', active: true },
      { id: 'project-open', name: 'Engineering', visibility: scenario === 'shared' ? 'open' : 'private', active: true }]
      : scenario === 'partial-adoption' ? [repository, ...additionalRepositories].filter(row => row.sourceId === source.id && row.status === 'ready')
        .map(row => ({ id: row.projectId, name: row.projectName, visibility: row.projectVisibility, active: true }))
      : [{ id: project.id, name: project.name, visibility: repository.projectVisibility, active: true }],
    entries: scenario === 'empty' ? [] : scenario === 'many' ? Array.from({ length: 80 }, (_, index) => ({
      ...source.entries[0]!, id: 'entry-' + index, name: 'Project workflow ' + (index + 1), skillId: 'skill-' + index,
    })) : source.entries.map((entry, index) => index === 1 && scenario === 'removed' ? { ...entry, present: false }
      : index === 1 && scenario === 'validation' ? { ...entry, error: 'SKILL.md contains an invalid package reference. The installed version was kept.' } : entry),
  }));
  skillSourcesApi.projectRepositories = async () => !projectCreated || project.workspaces.length === 0 ? [] : structuredClone([repository, ...additionalRepositories]);
  skillSourcesApi.adoptProject = async (_companyId, workspaceId) => {
    const row = [repository, ...additionalRepositories].find(row => row.workspaceId === workspaceId)!;
    await adopt(row); return { bindingId: `binding-${workspaceId}` };
  };
  skillSourcesApi.refresh = refresh;
  skillSourcesApi.branches = async () => ({ defaultBranch: scenario === 'missing-branch' ? 'master' : 'main', branches: [
    { name: scenario === 'missing-branch' ? 'master' : 'main', isDefault: true }, { name: 'release/2026.10', isDefault: false },
  ], truncated: false });
  skillSourcesApi.settings = async (_companyId, id, input) => {
    if (input.connectionId !== undefined && repairConflict) {
      repairConflict = false; sourceRevision++;
      throw new ApiError('The source was updated while choosing a connection.', 409, { code: 'skill_source_settings_changed' });
    }
    if (input.revision !== undefined && input.revision < sourceRevision) {
      throw new ApiError('The source revision changed.', 409, { code: 'skill_source_settings_changed' });
    }
    sourcePreferences.set(id, { ...sourcePreferences.get(id),
      ...(input.automaticUpdates === undefined ? {} : { automaticUpdates: input.automaticUpdates }),
      ...(input.importNewSkills === undefined ? {} : { importNewSkills: input.importNewSkills }),
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      ...(input.trackingRef === undefined ? {} : { trackingRef: input.trackingRef }),
    });
    if (input.connectionId !== undefined || input.trackingRef !== undefined) failed = false;
    return (await skillSourcesApi.list(COMPANY_ID)).find(source => source.id === id)!;
  };
  companySkillsApi.detail = async (companyId, id) => {
    const skill = await baseSkills.detail(companyId, id);
    const hasUpdate = updatedSources.has(String(skill.metadata?.skillSourceId));
    return { ...skill, accessSourceId: String(skill.metadata?.skillSourceId), sourceRef: hasUpdate ? NEW_COMMIT : skill.sourceRef,
      markdown: hasUpdate ? `${skill.markdown}\nCheck the project access before publishing results.\n` : skill.markdown,
      currentVersionId: hasUpdate ? `${skill.currentVersionId}-updated` : skill.currentVersionId };
  };
  projectsApi.repositoryOptions = baseSources.repositories;
  projectsApi.get = async () => structuredClone(project);
  projectsApi.list = async () => !projectCreated ? [] : [structuredClone(project)];
  projectsApi.setRepositories = async (_id, repositoryIds) => {
    const options = await projectsApi.repositoryOptions(COMPANY_ID);
    const existingIds = new Set(project.workspaces.map(workspace => workspace.metadata?.githubRepositoryId));
    const template = workspaceTemplate;
    const workspaces = repositoryIds.map((id, index) => {
      const selected = options.repositories.find(option => option.id === id)!;
      return { ...template, id: index === 0 ? projectRepository.workspaceId : `workspace-${id}`, name: selected.fullName,
        repoUrl: selected.url, metadata: { ...template.metadata, githubRepositoryId: id }, isPrimary: index === 0 };
    });
    project = { ...project, workspaces, primaryWorkspace: workspaces[0] ?? null };
    for (const workspace of workspaces) {
      if (existingIds.has(workspace.metadata.githubRepositoryId)) continue;
      const row: ProjectSkillRepository = { ...projectRepository, projectName: project.name, workspaceId: workspace.id,
        repositoryUrl: workspace.repoUrl, status: 'pending', bindingId: `binding-${workspace.id}` };
      if (workspace.id === repository.workspaceId) repository = row;
      else additionalRepositories.push(row);
      void adopt(row);
    }
    return structuredClone(project);
  };
  projectsApi.create = async (_companyId, input) => {
    projectCreated = true;
    project = { ...project, name: String(input.name), workspaces: [], primaryWorkspace: null };
    repository = { ...repository, projectName: project.name };
    return projectsApi.setRepositories(project.id, (input.repositoryIds ?? []) as string[]);
  };
  const skillId = sourceFixture().entries[1]!.skillId!;
  let routine = { ...baseRoutine, id: ROUTINE_ID, title: 'Review project changes', projectId: project.id,
    project: { id: project.id, name: project.name, description: null, status: 'in_progress' },
    description: `Use [/code-review](${buildSkillMentionHref(skillId, 'code-review')}) to review the project changes and report your findings.`, triggers: [], recentRuns: [] as RoutineRunSummary[] };
  let executionIssues: Issue[] = [storybookIssues[0]!].map(issue => ({ ...issue, id: 'project-review-before', projectId: project.id,
    originKind: 'routine_execution' as const, originId: ROUTINE_ID, title: 'Review project changes', status: 'done' as const,
    executionWorkspaceId: null, projectWorkspaceId: null, currentExecutionWorkspace: null, labels: [],
    description: 'Completed using the installed code review checklist.' }));
  routinesApi.get = async () => structuredClone(routine);
  routinesApi.list = async () => [structuredClone({ ...routine, lastRun: routine.recentRuns[0] ?? null })];
  routinesApi.listRuns = async () => structuredClone(routine.recentRuns);
  routinesApi.activity = async () => [];
  routinesApi.listRevisions = async () => [];
  routinesApi.update = async (_id, input) => (routine = { ...routine, ...input });
  routinesApi.run = async () => {
    const now = new Date();
    const executionId = `project-review-${routine.recentRuns.length + 1}`;
    const resolvedSkill = await companySkillsApi.detail(COMPANY_ID, skillId);
    const run: RoutineRunSummary = { id: `review-run-${routine.recentRuns.length}`, companyId: COMPANY_ID, routineId: ROUTINE_ID,
      triggerId: null, source: 'manual', status: 'completed', idempotencyKey: null, triggerPayload: null, dispatchFingerprint: null,
      linkedIssueId: executionId, coalescedIntoRunId: null, failureReason: null, triggeredAt: now, completedAt: now, createdAt: now, updatedAt: now,
      trigger: null, linkedIssue: { id: executionId, identifier: `PAP-${124 + routine.recentRuns.length}`, title: 'Review project changes', status: 'done', priority: 'medium', updatedAt: now } };
    routine = { ...routine, recentRuns: [run, ...routine.recentRuns] };
    executionIssues = [{ ...executionIssues[0]!, id: executionId, identifier: run.linkedIssue!.identifier,
      description: `Completed using code review version ${resolvedSkill.currentVersionId} at commit ${resolvedSkill.sourceRef}.`,
    }, ...executionIssues];
    return run;
  };
  const isExecution = (id: string) => executionIssues.some(issue => issue.id === id || issue.identifier === id);
  emailApi.thread = async (companyId, id) => isExecution(id) ? null : originalEmailThread(companyId, id);
  activityApi.forIssue = async id => isExecution(id) ? [] : originalActivity.forIssue(id);
  activityApi.runsForIssue = async id => isExecution(id) ? [] : originalActivity.runsForIssue(id);
  heartbeatsApi.liveRunsForIssue = async id => isExecution(id) ? [] : originalHeartbeats.liveRunsForIssue(id);
  heartbeatsApi.activeRunForIssue = async id => isExecution(id) ? null : originalHeartbeats.activeRunForIssue(id);
  heartbeatsApi.executionForIssue = async id => isExecution(id) ? null : originalHeartbeats.executionForIssue(id);
  issuesApi.listComments = async (id, options) => isExecution(id) ? [] : originalIssues.listComments(id, options);
  issuesApi.listInteractions = async id => isExecution(id) ? [] : originalIssues.listInteractions(id);
  issuesApi.listAttachments = async id => isExecution(id) ? [] : originalIssues.listAttachments(id);
  issuesApi.listApprovals = async id => isExecution(id) ? [] : originalIssues.listApprovals(id);
  issuesApi.listWorkProducts = async (id, options) => isExecution(id) ? [] : originalIssues.listWorkProducts(id, options);
  issuesApi.listFeedbackVotes = async id => isExecution(id) ? [] : originalIssues.listFeedbackVotes(id);
  issuesApi.listTreeHolds = async (id, options) => isExecution(id) ? [] : originalIssues.listTreeHolds(id, options);
  issuesApi.listAcceptedPlanDecompositions = async id => isExecution(id) ? [] : originalIssues.listAcceptedPlanDecompositions(id);
  issuesApi.getQueuedComments = async id => isExecution(id) ? {
    issueId: id, queueId: null, state: null, targetRunId: null, revision: 'empty', protocol: 'legacy', steeringDisposition: 'unsupported', entries: [],
  } : originalIssues.getQueuedComments(id);
  issuesApi.getTreeControlState = async id => isExecution(id) ? { activePauseHold: null } : originalIssues.getTreeControlState(id);
  const originalList = originalIssues.list, originalCompact = originalIssues.listCompact;
  issuesApi.get = async (id, options) => {
    const issue = executionIssues.find(candidate => candidate.id === id || candidate.identifier === id);
    return issue ? structuredClone(issue) : originalIssues.get(id, options);
  };
  issuesApi.list = async (companyId, filters) => filters?.originId === ROUTINE_ID ? structuredClone(executionIssues) : originalList(companyId, filters);
  issuesApi.listCompact = async (companyId, filters, options) => filters?.originId === ROUTINE_ID ? structuredClone(executionIssues.map(issue => ({ ...issue, activeRecoveryAction: null, successfulRunHandoff: null }))) : originalCompact(companyId, filters, options);
  if (scenario === 'automatic') timers.push(setTimeout(() => { if (live) void refresh().then(invalidate); }, 1800));
  return () => {
    live = false; timers.forEach(clearTimeout);
    Object.assign(activityApi, originalActivity); Object.assign(heartbeatsApi, originalHeartbeats);
    emailApi.thread = originalEmailThread;
    Object.assign(projectsApi, originalProjects); Object.assign(routinesApi, originalRoutines); Object.assign(issuesApi, originalIssues);
    cleanup();
  };
}
