import { and, eq } from 'drizzle-orm';
import { projectSkillSources, projectWorkspaces, projectProviderAuthorizations, connectionGrants, toolConnections, toolConnectionInstalls,
  companyMemberships, companySecrets, userSecretDefinitions, connectionGrantMembers, type Db } from '@paperclipai/db';
import { conflict, forbidden } from '../errors.js';
import { resolveAzureDevOpsProjectGitCredentials } from './azure-project-git-credentials.js';
import { canBrowseProjectRepositoryGrant } from './project-repositories.js';
import { isAzureDevOpsConnection } from './connectors/azure-devops/index.js';

/** A shared skill source can update only while every active project retains access. */
export async function authorizeAzureSkillSourceBindings(db: Db, input: { companyId: string; sourceId: string; repositoryUrl: string; repositoryId: string }, signal?: AbortSignal) {
  const unavailable = () => forbidden('An Azure DevOps project authorization is unavailable. Reconnect every active project connection.');
  signal?.throwIfAborted();
  const rows = await db.select({ binding: projectSkillSources, workspace: projectWorkspaces }).from(projectSkillSources)
    .leftJoin(projectWorkspaces, and(eq(projectWorkspaces.id, projectSkillSources.workspaceId),
      eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, projectSkillSources.projectId)))
    .where(and(eq(projectSkillSources.companyId, input.companyId), eq(projectSkillSources.sourceId, input.sourceId)));
  if (!rows.length || rows.length > 100) throw unavailable();
  for (const { binding, workspace } of rows) {
    if (!binding.active || !workspace || binding.repositoryUrl !== input.repositoryUrl || workspace.repoUrl !== input.repositoryUrl ||
        workspace.metadata?.repositoryProvider !== 'azure-devops' || workspace.metadata.repositoryId !== input.repositoryId) throw unavailable();
  }
  const grants = new Map<string, { grantId: string; connectionId: string; credentialSecretId: string; credentialSecretVersion: number }>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (cursor < rows.length) {
      signal?.throwIfAborted();
      const { binding } = rows[cursor++]!;
      const auth = await resolveAzureDevOpsProjectGitCredentials(db, { companyId: input.companyId, projectId: binding.projectId, repoUrl: input.repositoryUrl });
      signal?.throwIfAborted();
      if (!auth.grantId || !auth.connectionId || !auth.credentialSecretId || !auth.credentialSecretVersion) throw unavailable();
      grants.set(binding.id, { grantId: auth.grantId, connectionId: auth.connectionId,
        credentialSecretId: auth.credentialSecretId, credentialSecretVersion: auth.credentialSecretVersion });
    }
  }));
  return rows.map(row => ({ ...row, ...grants.get(row.binding.id)! }));
}

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Serialize publication with consent, connection, membership and credential revocation. */
export async function lockAzureSkillAuthority(tx: Transaction, input: { companyId: string; projectId: string; organization: string;
  grantId: string; connectionId: string; credentialSecretId: string; credentialSecretVersion: number }) {
  const changed = () => conflict('Azure DevOps authorization changed during skill publication.');
  const [authority] = await tx.select({ consent: projectProviderAuthorizations, grant: connectionGrants, connection: toolConnections })
    .from(projectProviderAuthorizations)
    .innerJoin(connectionGrants, and(eq(connectionGrants.id, projectProviderAuthorizations.grantId), eq(connectionGrants.companyId, input.companyId)))
    .innerJoin(toolConnections, and(eq(toolConnections.id, connectionGrants.connectionId), eq(toolConnections.companyId, input.companyId)))
    .where(and(eq(projectProviderAuthorizations.companyId, input.companyId), eq(projectProviderAuthorizations.projectId, input.projectId),
      eq(projectProviderAuthorizations.provider, 'azure-devops'), eq(projectProviderAuthorizations.scopeKey, input.organization),
      eq(projectProviderAuthorizations.grantId, input.grantId))).for('share');
  if (!authority || authority.grant.status !== 'active' || authority.connection.id !== input.connectionId ||
      authority.connection.status !== 'active' || !authority.connection.enabled || authority.connection.credentialSource !== 'paperclip_vault' ||
      !isAzureDevOpsConnection(authority.connection) || String((authority.connection.config.methodConfig as Record<string, unknown> | undefined)?.organization ?? '').toLowerCase() !== input.organization ||
      !authority.grant.credentialSecretRefs.some(ref => ref.secretId === input.credentialSecretId &&
        (authority.connection.authKind === 'oauth' ? ref.configPath === 'oauth.access_token' : /authorization|token|api_key|apiKey/i.test(ref.configPath)))) throw changed();
  const [install] = await tx.select({ id: toolConnectionInstalls.id }).from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, input.companyId), eq(toolConnectionInstalls.connectionId, input.connectionId),
    eq(toolConnectionInstalls.targetType, 'company'), eq(toolConnectionInstalls.targetId, input.companyId))).for('share');
  const [member] = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, input.companyId),
    eq(companyMemberships.principalType, 'user'), eq(companyMemberships.principalId, authority.consent.authorizedByUserId),
    eq(companyMemberships.status, 'active'))).for('share');
  const audience = await tx.select({ subjectId: connectionGrantMembers.subjectId }).from(connectionGrantMembers).where(and(
    eq(connectionGrantMembers.companyId, input.companyId), eq(connectionGrantMembers.grantId, input.grantId))).for('share');
  if (!canBrowseProjectRepositoryGrant({ grant: authority.grant, userId: authority.consent.authorizedByUserId,
      activeMember: Boolean(member && member.membershipRole !== 'viewer'), audience: audience.map(row => row.subjectId) }) ||
      (authority.grant.kind === 'organization' && ['per_user', 'per_agent'].includes(authority.connection.credentialPolicy))) throw changed();
  const [secret] = await tx.select().from(companySecrets).where(and(eq(companySecrets.companyId, input.companyId),
    eq(companySecrets.id, input.credentialSecretId))).for('share');
  if (!install || !member || member.membershipRole === 'viewer' || !secret || secret.status !== 'active' || secret.deletedAt ||
      secret.latestVersion !== input.credentialSecretVersion || (authority.grant.kind === 'user'
        ? secret.scope !== 'user' || secret.ownerUserId !== authority.grant.subjectUserId || !secret.userSecretDefinitionId
        : secret.scope !== 'company')) throw changed();
  if (secret.userSecretDefinitionId) {
    const [definition] = await tx.select().from(userSecretDefinitions).where(and(eq(userSecretDefinitions.companyId, input.companyId),
      eq(userSecretDefinitions.id, secret.userSecretDefinitionId))).for('share');
    if (!definition || definition.status !== 'active' || definition.deletedAt) throw changed();
  }
}
