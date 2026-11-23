import type { QueryClient } from '@tanstack/react-query';
import { skillSourcesApi } from '@/api/skillSources';
import type { RepositoryBranch } from '@/components/RepositoryBranchSelect';
import { ApiError } from '@/api/client';
import { installProjectSkillFixtures } from './projectRepositorySkills';

export const repositoryBranches: RepositoryBranch[] = [
  { name: 'master', isDefault: true },
  { name: 'develop' },
  { name: 'release/2026.10' },
  { name: 'feature/project-skills' },
  { name: 'feature/branch-selection' },
  { name: 'feature/platform-services-repository-skill-refresh-and-accessibility-improvements' },
];
export type BranchSelectionScenario = 'ready' | 'loading' | 'load-error' | 'empty' | 'save-error' | 'many' | 'save-conflict' | 'connection-repair';

/** Production API boundary with scoped in-memory provider responses. */
export function installBranchSelectionFixtures(scenario: BranchSelectionScenario, client: QueryClient) {
  const cleanup = installProjectSkillFixtures(scenario === 'connection-repair' ? 'repair' : 'missing-branch', client);
  const originalList = skillSourcesApi.list;
  const originalBranches = skillSourcesApi.branches, originalSettings = skillSourcesApi.settings;
  const selections = new Map<string, { branch: string; connectionId?: string | null }>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const delay = (milliseconds: number) => new Promise<void>(resolve => { timers.push(setTimeout(resolve, milliseconds)); });
  let attempts = 0, revision = 0, conflict = scenario === 'save-conflict';
  skillSourcesApi.list = async companyId => (await originalList(companyId)).map(source => {
    const selection = selections.get(source.id);
    const visible = scenario === 'connection-repair' ? { ...source, accessScope: 'company' as const, projects: [] } : source;
    return selection === undefined ? { ...visible, revision: source.revision + revision,
      ...(scenario === 'connection-repair' ? {} : { lastError: 'The tracked branch is unavailable. Choose a new branch.' }) }
      : { ...visible, trackingRef: selection.branch, ...(selection.connectionId === undefined ? {} : { connectionId: selection.connectionId }), lastError: null, repairAction: null, syncState: 'ready', revision: source.revision + revision };
  });
  skillSourcesApi.branches = async () => {
      await delay(scenario === 'loading' ? 4000 : 350);
      if (scenario === 'load-error' && attempts++ === 0) throw new Error('Could not load branches from GitHub.');
      const branches: RepositoryBranch[] = scenario === 'empty' ? [] : scenario === 'many'
        ? [...repositoryBranches, ...Array.from({ length: 80 }, (_, index) => ({ name: `feature/workflow-${index + 1}` }))] : repositoryBranches;
      return { defaultBranch: 'master', branches: branches.map(branch => ({ ...branch, isDefault: Boolean(branch.isDefault) })), truncated: false };
  };
  skillSourcesApi.settings = async (companyId, sourceId, input) => {
      if (input.trackingRef === undefined) {
        if (scenario === 'connection-repair' && input.connectionId !== undefined) throw new ApiError('The tracked branch is unavailable.', 422, { code: 'skill_source_ref_unavailable' });
        return originalSettings(companyId, sourceId, input);
      }
      await delay(900);
      if (scenario === 'save-error' && input.trackingRef === 'feature/missing') throw new ApiError('The branch is unavailable.', 422, { code: 'skill_source_ref_unavailable' });
      const current = (await skillSourcesApi.list(companyId)).find(source => source.id === sourceId)!;
      if (input.revision !== current.revision) throw new ApiError('The source changed.', 409, { code: 'skill_source_settings_changed' });
      if (conflict) { conflict = false; revision++; throw new ApiError('The source changed.', 409, { code: 'skill_source_settings_changed' }); }
      await originalSettings(companyId, sourceId, input);
      selections.set(sourceId, { branch: input.trackingRef, connectionId: input.connectionId }); revision++;
      return (await skillSourcesApi.list(companyId)).find(source => source.id === sourceId)!;
  };
  return {
    cleanup() { timers.forEach(clearTimeout); skillSourcesApi.list = originalList; skillSourcesApi.branches = originalBranches; skillSourcesApi.settings = originalSettings; cleanup(); },
  };
}
