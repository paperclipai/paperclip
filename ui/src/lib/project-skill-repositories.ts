import type { ProjectSkillRepository } from '@paperclipai/shared';

export function groupProjectSkillRepositories(repositories: ProjectSkillRepository[]) {
  const groups = new Map<string, ProjectSkillRepository[]>();
  for (const repository of repositories) {
    const key = JSON.stringify([repository.repositoryUrl.toLowerCase(), repository.trackingRef]);
    const group = groups.get(key) ?? [];
    group.push(repository);
    groups.set(key, group);
  }
  return [...groups].map(([key, workspaces]) => {
    const pending = workspaces.find(repository => repository.status === 'pending');
    const failed = workspaces.find(repository => repository.status === 'error');
    const importableWorkspaces = workspaces.filter(repository => repository.status === 'available' || repository.status === 'error');
    const repository: ProjectSkillRepository = { ...workspaces[0]!,
      projectName: [...new Set(workspaces.map(repository => repository.projectName))].join(', '),
      status: importableWorkspaces.length ? failed?.status ?? 'available' : pending?.status ?? workspaces[0]!.status,
      lastError: failed?.lastError ?? workspaces[0]!.lastError,
      importState: workspaces.some(repository => repository.importState === 'importing') ? 'importing' : 'queued',
    };
    return { key, repository, workspaces, importableWorkspaces, hasPending: Boolean(pending) };
  });
}
