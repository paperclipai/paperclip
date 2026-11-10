import { and, eq } from 'drizzle-orm';
import { projectWorkspaces, type Db } from '@paperclipai/db';
import type { Request } from 'express';
import type { CompanyPortabilityFileEntry } from '@paperclipai/shared';
import { forbidden, unprocessable } from '../errors.js';
import { assertTaskWorkspaceSourceProjectAccess } from './task-workspace-access.js';
import { projectSkillRepository } from './project-skill-source-bindings.js';
import { projectProviderAuthorizationService } from './project-provider-authorization.js';
import { resolveAzureDevOpsProjectGitCredentials } from './azure-project-git-credentials.js';
import { resolveAzureDevOpsRunGitCredentials } from './azure-devops-run-git-credentials.js';
import { openGitSkillSnapshot } from './skill-source-git-snapshot.js';
import { assertSkillSnapshotPath } from './skill-snapshot.js';
import { assertProjectGitConnection } from './project-git-connection-policy.js';
import { MAX_REPOSITORY_BYTES, MAX_REPOSITORY_FILES } from './skill-repository-package.js';

/** Materialize a company package only from an authorized, company-scoped workspace. */
export async function resolveCompanyProjectRepository(db: Db, actor: Request['actor'], source: {
  companyId: string; workspaceId: string; ref?: string;
}) {
  const denied = () => forbidden('Project repository access is unavailable. Reconnect the project authorization and try again.');
  const currentWorkspace = async () => {
    const [workspace] = await db.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.companyId, source.companyId), eq(projectWorkspaces.id, source.workspaceId)));
    if (!workspace || !workspace.repoUrl || actor.type === 'none' || (actor.type === 'agent' && actor.companyId !== source.companyId)) throw denied();
    await assertTaskWorkspaceSourceProjectAccess(db, actor, source.companyId, workspace.projectId);
    const repository = projectSkillRepository(workspace);
    if (!repository || workspace.metadata?.repositoryProvider !== 'azure-devops') throw unprocessable('Select an authorized Azure DevOps project repository.');
    return { workspace, repository };
  };
  const original = await currentWorkspace();
  const { workspace, repository } = original;
  const authorize = async () => {
    // Project authorization establishes the recorded repository identity. An agent
    // must additionally use credentials belonging to its own active run.
    const projectAuth = await resolveAzureDevOpsProjectGitCredentials(db, { companyId: source.companyId, projectId: workspace.projectId, repoUrl: repository.repositoryUrl });
    if (projectAuth.repositoryId !== workspace.metadata?.repositoryId) throw denied();
    if (actor.type === 'board') {
      if (!actor.userId) throw denied();
      const org = new URL(repository.repositoryUrl).pathname.split('/')[1]!.toLowerCase();
      const eligible = await projectProviderAuthorizationService(db).read(source.companyId, workspace.projectId, actor.userId, 'azure-devops', org);
      if (!projectAuth.grantId || !eligible.options.some(option => option.grantId === projectAuth.grantId)) throw denied();
      return projectAuth;
    }
    if (actor.type !== 'agent') throw denied();
    if (!actor.agentId || !actor.runId) throw denied();
    return resolveAzureDevOpsRunGitCredentials(db, { companyId: source.companyId, agentId: actor.agentId, runId: actor.runId, repoUrl: repository.repositoryUrl });
  };
  const auth = await authorize();
  await assertProjectGitConnection(repository.repositoryUrl, async () => auth);
  const ref = source.ref || repository.trackingRef;
  const snapshot = await openGitSkillSnapshot({ repositoryUrl: repository.repositoryUrl, ref, token: '', providerAuth: auth,
    cacheScope: `company-import:${source.companyId}:${source.workspaceId}:${actor.type === 'agent' ? actor.runId : actor.userId ?? actor.source}` });
  try {
    const blobs = snapshot.entries.filter(entry => entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755') &&
      (entry.path.endsWith('.md') || entry.path.startsWith('skills/') || entry.path.startsWith('blobs/') ||
        /\.(?:ya?ml|png|jpe?g|gif|webp|svg)$/i.test(entry.path)) &&
      !/(?:^|\/)(?:pnpm-lock|yarn\.lock|package-lock)\.ya?ml$/i.test(entry.path));
    if (blobs.length > MAX_REPOSITORY_FILES || blobs.some(entry => entry.size === undefined) ||
        blobs.reduce((sum, entry) => sum + (entry.size ?? 0), 0) > MAX_REPOSITORY_BYTES) throw unprocessable('Repository package exceeds the supported size.');
    const files: Record<string, CompanyPortabilityFileEntry> = Object.create(null);
    let total = 0;
    const batch = snapshot.readBlobs ? await snapshot.readBlobs(blobs) : null;
    for (const entry of blobs) {
      const path = assertSkillSnapshotPath(entry.path);
      const bytes = batch ? batch.get(entry.sha) : await snapshot.readBlob(entry);
      if (!bytes) throw unprocessable('Repository file is unavailable.');
      total += bytes.length;
      if (total > MAX_REPOSITORY_BYTES) throw unprocessable('Repository package exceeds the supported size.');
      const content = bytes.toString('utf8');
      files[path] = bytes.includes(0) || !Buffer.from(content).equals(bytes) ? { encoding: 'base64', data: bytes.toString('base64') } : content;
    }
    const current = await currentWorkspace();
    if (current.workspace.projectId !== workspace.projectId || current.repository.repositoryUrl !== repository.repositoryUrl ||
        current.workspace.metadata?.repositoryId !== workspace.metadata?.repositoryId) throw denied();
    await assertProjectGitConnection(repository.repositoryUrl, authorize);
    return { type: 'inline' as const, files, expectedFileCount: Object.keys(files).length };
  } finally { await snapshot.release(); }
}
