import { and, eq } from 'drizzle-orm';
import { connectionGrants, projectProviderAuthorizations, projectWorkspaces, type Db } from '@paperclipai/db';
import type { SkillSourceScanProgress } from '@paperclipai/shared';
import { forbidden } from '../errors.js';
import { resolveAzureDevOpsProjectGitCredentials } from './azure-project-git-credentials.js';
import { openGitSkillSnapshot } from './skill-source-git-snapshot.js';
import { scanGitSkillSnapshot, type SkillScanInput, type SkillScanOptions } from './github-skill-source.js';

/** Scan only a repository and project authorization that remain currently accessible. */
export async function scanAzureDevOpsProjectSkills(db: Db, input: SkillScanInput & { companyId: string; projectId: string }, options: SkillScanOptions = {}) {
  options.signal?.throwIfAborted();
  let remote: URL;
  try { remote = new URL(input.repositoryUrl); } catch { throw forbidden('Azure DevOps project authorization is unavailable'); }
  const org = remote.pathname.split('/')[1]?.toLowerCase();
  if (!org) throw forbidden('Azure DevOps project authorization is unavailable');
  const [workspace] = await db.select().from(projectWorkspaces).where(and(
    eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.projectId), eq(projectWorkspaces.repoUrl, input.repositoryUrl)));
  const [authority] = await db.select({ grantId: projectProviderAuthorizations.grantId, connectionId: connectionGrants.connectionId })
    .from(projectProviderAuthorizations).innerJoin(connectionGrants, and(eq(connectionGrants.id, projectProviderAuthorizations.grantId),
      eq(connectionGrants.companyId, input.companyId))).where(and(eq(projectProviderAuthorizations.companyId, input.companyId),
      eq(projectProviderAuthorizations.projectId, input.projectId), eq(projectProviderAuthorizations.provider, 'azure-devops'),
      eq(projectProviderAuthorizations.scopeKey, org)));
  if (!workspace || !authority || workspace.metadata?.repositoryProvider !== 'azure-devops' || typeof workspace.metadata.repositoryId !== 'string')
    throw forbidden('Azure DevOps project authorization is unavailable');
  const progress: SkillSourceScanProgress = { type: 'progress', phase: 'connecting', totalSkills: null, checkedSkills: 0, currentPath: null, checkedFiles: 0, totalFiles: null };
  const report = async () => { options.signal?.throwIfAborted(); await options.onProgress?.({ ...progress }); };
  await report();
  const auth = await resolveAzureDevOpsProjectGitCredentials(db, { companyId: input.companyId, projectId: input.projectId, repoUrl: input.repositoryUrl });
  options.signal?.throwIfAborted();
  progress.phase = 'downloading';
  await report();
  const trackingRef = input.trackingRef || 'HEAD';
  const snapshot = await openGitSkillSnapshot({ repositoryUrl: input.repositoryUrl, ref: trackingRef, commitSha: input.commitSha,
    token: '', providerAuth: auth, cacheScope: `${input.companyId}:${input.projectId}:${authority.grantId}` }, {
    signal: options.signal, onDownload: async download => { progress.download = download; await report(); },
  });
  try {
    // Provider access may change during fetch; cached snapshots are not authority.
    await resolveAzureDevOpsProjectGitCredentials(db, { companyId: input.companyId, projectId: input.projectId, repoUrl: input.repositoryUrl });
    const [current] = await db.select({ grantId: projectProviderAuthorizations.grantId, connectionId: connectionGrants.connectionId })
      .from(projectProviderAuthorizations).innerJoin(connectionGrants, and(eq(connectionGrants.id, projectProviderAuthorizations.grantId),
        eq(connectionGrants.companyId, input.companyId))).where(and(
      eq(projectProviderAuthorizations.companyId, input.companyId), eq(projectProviderAuthorizations.projectId, input.projectId),
      eq(projectProviderAuthorizations.provider, 'azure-devops'), eq(projectProviderAuthorizations.scopeKey, org)));
    if (current?.grantId !== authority.grantId || current.connectionId !== authority.connectionId) throw forbidden('Azure DevOps project authorization is unavailable');
  } catch (error) { await snapshot.release(); throw error; }
  const scan = await scanGitSkillSnapshot(input, { repo: { id: workspace.metadata.repositoryId, full_name: workspace.name,
    default_branch: trackingRef }, canonical: { repositoryUrl: input.repositoryUrl }, trackingRef,
    connectionId: authority.connectionId, progress, report, snapshot }, options);
  return { ...scan, grantId: authority.grantId, credentialSecretId: auth.credentialSecretId, credentialSecretVersion: auth.credentialSecretVersion };
}

export async function scanAzureDevOpsProjectSkillsWithPackageFallback(db: Db, input: SkillScanInput & { companyId: string; projectId: string }, options: SkillScanOptions = {}) {
  try { return await scanAzureDevOpsProjectSkills(db, input, options); }
  catch (error) {
    if (input.packageMode !== 'repository' || !(error instanceof Error) || !/^Repository package exceeds/.test(error.message)) throw error;
    options.signal?.throwIfAborted();
    try { return await scanAzureDevOpsProjectSkills(db, input, { ...options, repositorySubset: true }); }
    catch (subsetError) {
      if (!(subsetError instanceof Error) || !/^Repository package exceeds/.test(subsetError.message)) throw subsetError;
      const scan = await scanAzureDevOpsProjectSkills(db, { ...input, packageMode: 'skills' }, options);
      scan.warnings.push('Only skill folders were included because the repository and its referenced files exceed the supported package size. Missing references are listed below.');
      return scan;
    }
  }
}
