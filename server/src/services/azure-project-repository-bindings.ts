import { forbidden } from '../errors.js';
import { and, eq } from 'drizzle-orm';
import { executionWorkspaceRepositories, heartbeatRuns, issues, type Db } from '@paperclipai/db';
import { boundRunIssueId } from './run-task-binding.js';
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

/** Revalidate an admitted task repository when it has no project repository binding. */
export async function projectForAzureRuntimeRepository(db: Db, input: {
  companyId: string; agentId: string; runId: string; repositoryUrl: string; bindings: AzureProjectRepositoryBinding[] | undefined;
}): Promise<{ projectId?: string; expectedRepositoryId?: string }> {
  const { repositoryUrl, bindings } = input;
  const canonical = azureDevOpsGitInvocation(repositoryUrl, { kind: 'pat', token: 'validation' }).repositoryAuthority!.url.toLowerCase();
  if (!bindings || bindings.some(binding => binding.repositoryUrl.toLowerCase() === canonical)) {
    return { projectId: projectForAzureRepository(repositoryUrl, bindings) };
  }
  const unavailable = () => forbidden('Azure DevOps repository is not authorized for this run.');
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.agentId, input.agentId)));
  const issueId = run && boundRunIssueId(run);
  if (!issueId) throw unavailable();
  const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, issueId)));
  if (!issue?.executionWorkspaceId) throw unavailable();
  const rows = await db.select().from(executionWorkspaceRepositories).where(and(
    eq(executionWorkspaceRepositories.companyId, input.companyId),
    eq(executionWorkspaceRepositories.executionWorkspaceId, issue.executionWorkspaceId),
    eq(executionWorkspaceRepositories.requestedByIssueId, issueId), eq(executionWorkspaceRepositories.state, 'ready')));
  const admitted = rows.filter(row => {
    if (!row.catalogRepositoryId?.startsWith('azure-devops:') || !row.pinnedCommit) return false;
    try { return azureDevOpsGitInvocation(row.repoUrl, { kind: 'pat', token: 'validation' }).repositoryAuthority!.url.toLowerCase() === canonical; }
    catch { return false; }
  });
  const ids = [...new Set(admitted.map(row => row.catalogRepositoryId!))];
  if (ids.length !== 1) throw unavailable();
  return { expectedRepositoryId: ids[0] };
}
