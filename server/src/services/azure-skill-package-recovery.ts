import { and, eq } from 'drizzle-orm';
import { projectSkillSources, projectWorkspaces, type Db, type SkillPackageRestoreRecipe } from '@paperclipai/db';
import { forbidden } from '../errors.js';
import type { GitHubRead } from './github-skill-source.js';
import { resolveAzureDevOpsProjectGitCredentials } from './azure-project-git-credentials.js';
import { openGitSkillSnapshot } from './skill-source-git-snapshot.js';
import { authorizeAzureSkillSourceBindings } from './azure-project-skill-bindings.js';

/** Restoring an evicted package never adopts another project's credentials. */
export async function azureSkillPackageRecoveryReader(db: Db, companyId: string, recipe: SkillPackageRestoreRecipe): Promise<GitHubRead> {
  const unavailable = () => forbidden('The original Azure DevOps project authorization is unavailable. Reconnect it to restore this skill.');
  const authorizeBindings = (signal?: AbortSignal) => authorizeAzureSkillSourceBindings(db, { companyId, sourceId: recipe.sourceId,
    repositoryUrl: recipe.repositoryUrl, repositoryId: recipe.repositoryId }, signal);
  const initial = await authorizeBindings();
  const authorityFingerprint = (rows: typeof initial) => JSON.stringify(rows.map(row => [row.binding.id, row.grantId,
    row.connectionId, row.credentialSecretId, row.credentialSecretVersion]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const candidates = await db.select({ binding: projectSkillSources, workspace: projectWorkspaces }).from(projectSkillSources)
    .innerJoin(projectWorkspaces, and(eq(projectWorkspaces.id, projectSkillSources.workspaceId),
      eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.projectId, projectSkillSources.projectId)))
    .where(and(eq(projectSkillSources.companyId, companyId), eq(projectSkillSources.sourceId, recipe.sourceId), eq(projectSkillSources.active, true)));
  const eligible = candidates.filter(({ binding, workspace }) => initial.some(row => row.binding.id === binding.id) && binding.repositoryUrl === recipe.repositoryUrl &&
    workspace.repoUrl === recipe.repositoryUrl && workspace.metadata?.repositoryProvider === 'azure-devops' &&
    workspace.metadata.repositoryId === recipe.repositoryId);
  if (!eligible.length) throw unavailable();
  const reader = (async () => { throw unavailable(); }) as unknown as GitHubRead;
  Object.defineProperty(reader, 'provider', { value: 'azure-devops' });
  reader.openSnapshot = async (input, options = {}) => {
    if (input.repositoryUrl !== recipe.repositoryUrl || input.commitSha !== recipe.commitSha || input.ref !== recipe.commitSha) throw unavailable();
    const before = await authorizeBindings(options.signal);
    if (authorityFingerprint(before) !== authorityFingerprint(initial)) throw unavailable();
    for (const { binding } of eligible) {
      options.signal?.throwIfAborted();
      let snapshot: Awaited<ReturnType<typeof openGitSkillSnapshot>> | undefined;
      try {
        const auth = await resolveAzureDevOpsProjectGitCredentials(db, { companyId, projectId: binding.projectId, repoUrl: recipe.repositoryUrl });
        snapshot = await openGitSkillSnapshot({ repositoryUrl: recipe.repositoryUrl, ref: recipe.commitSha,
          commitSha: recipe.commitSha, token: '', providerAuth: auth, cacheScope: `${companyId}:${binding.projectId}:${recipe.sourceId}` }, options);
        await resolveAzureDevOpsProjectGitCredentials(db, { companyId, projectId: binding.projectId, repoUrl: recipe.repositoryUrl });
        const currentBindings = await authorizeBindings(options.signal);
        if (authorityFingerprint(currentBindings) !== authorityFingerprint(initial)) throw unavailable();
        const [current] = await db.select({ binding: projectSkillSources, workspace: projectWorkspaces }).from(projectSkillSources)
          .innerJoin(projectWorkspaces, and(eq(projectWorkspaces.id, projectSkillSources.workspaceId),
            eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.projectId, binding.projectId)))
          .where(and(eq(projectSkillSources.id, binding.id), eq(projectSkillSources.companyId, companyId),
            eq(projectSkillSources.sourceId, recipe.sourceId), eq(projectSkillSources.active, true)));
        if (!current || current.binding.repositoryUrl !== recipe.repositoryUrl || current.workspace.repoUrl !== recipe.repositoryUrl ||
            current.workspace.metadata?.repositoryProvider !== 'azure-devops' || current.workspace.metadata.repositoryId !== recipe.repositoryId) throw unavailable();
        return snapshot;
      } catch (error) {
        if (snapshot) await snapshot.release();
        options.signal?.throwIfAborted();
      }
    }
    throw unavailable();
  };
  return reader;
}
