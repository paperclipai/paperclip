import { forbidden } from '../errors.js';
import { azureDevOpsGitInvocation } from './connectors/azure-devops/git-auth.js';

export type AzureProjectRepositoryBinding = { projectId: string; repositoryUrl: string };

/** Build only controller-derived, credential-free repository/project bindings. */
export function canonicalAzureProjectBindings(values: Array<{ projectId: string | null; repoUrl: string | null }>): AzureProjectRepositoryBinding[] {
  const result = new Map<string, AzureProjectRepositoryBinding>();
  for (const value of values) {
    if (!value.projectId || !value.repoUrl) continue;
    let url: URL;
    try { url = new URL(value.repoUrl); } catch { continue; }
    if (url.hostname.toLowerCase() !== 'dev.azure.com') continue;
    const repositoryUrl = azureDevOpsGitInvocation(value.repoUrl, { kind: 'pat', token: 'validation' }).repositoryAuthority!.url;
    result.set(`${value.projectId}:${repositoryUrl.toLowerCase()}`, { projectId: value.projectId, repositoryUrl });
  }
  return [...result.values()];
}

/** A URL is a selector only; project authority comes from the controller binding. */
export function projectForAzureRepository(repositoryUrl: string, bindings: AzureProjectRepositoryBinding[] | undefined): string | undefined {
  const canonical = azureDevOpsGitInvocation(repositoryUrl, { kind: 'pat', token: 'validation' }).repositoryAuthority!.url.toLowerCase();
  const projects = [...new Set((bindings ?? []).filter(binding => binding.repositoryUrl.toLowerCase() === canonical).map(binding => binding.projectId))];
  if (projects.length > 1) throw forbidden('Azure DevOps project authorization is ambiguous. Select one project workspace.');
  if (bindings && !projects.length) throw forbidden('Azure DevOps repository is not authorized for this run.');
  return projects[0];
}
