import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { toolApplications, toolConnections, connectionGrants, type Db } from '@paperclipai/db';
import { writeConnectionCredential } from '../../../services/connection-credentials.js';
import { secretService } from '../../../services/secrets.js';
import { createOAuthCredentialStore } from '../../../services/tool-access/oauth/credential-store.js';
import { createOAuthRefreshLeases } from '../../../services/tool-access/oauth/refresh-leases.js';
import { createOAuthGrantRefresh } from '../../../services/tool-access/oauth/grant-refresh.js';
import { createGitHubGrantContinuity } from '../../../services/tool-access/github-grant-continuity.js';
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv } from '../../../services/paperclip-cloud-connector.js';

/** Bootstrap the named OAuth consent boundary, then use real vault, binding and continuity owners. */
export async function prepareGitHubConfiguration(db: Db, companyId: string) {
  const owner = 'local-board', now = Date.now();
  const [application] = await db.insert(toolApplications).values({ companyId, applicationKey: randomUUID(), name: 'GitHub qualification', type: 'mcp_http', status: 'active' }).returning();
  const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, uid: randomUUID(), name: 'Retained GitHub', status: 'active', enabled: false,
    transport: 'mcp_remote', authKind: 'oauth', credentialPolicy: 'per_user', credentialSource: 'paperclip_vault', transportConfig: {},
    config: { url: 'https://api.github.com/mcp', sourceTemplateKey: 'github', oauth: { strategy: 'paperclip_cloud_connector', connectorProfile: 'github.code' } } }).returning();
  const refs = [];
  for (const [configPath, value] of [['oauth.access_token', 'qualification-access'], ['oauth.refresh_token', 'qualification-refresh']] as const) {
    const saved = await writeConnectionCredential(db, { companyId, connectionName: 'GitHub', configPath, label: configPath, value, ownerUserId: owner });
    refs.push({ configPath, secretId: saved.secret.id, versionSelector: 'latest' as const, required: true });
  }
  const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId: connection.id, kind: 'user', subjectUserId: owner, status: 'active', credentialSecretRefs: refs,
    providerTenant: { oauth: { strategy: 'paperclip_cloud_connector', accessTokenExpiresAt: new Date(now + 8 * 3_600_000).toISOString(), refreshedAt: new Date(now).toISOString() } } }).returning();
  await createOAuthCredentialStore(db, secretService(db)).syncCredentialBindings(connection, refs);
  return { connectionId: connection.id, grantId: grant.id };
}

export async function settleGitHubConfiguration(db: Db, input: { connectionId: string; grantId: string }) {
  const getConnection = async () => (await db.select().from(toolConnections).where(eq(toolConnections.id, input.connectionId)))[0];
  const connection = await getConnection();
  const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, input.grantId));
  const config = paperclipCloudConnectorConfigFromEnv();
  if (!config) throw new Error('Owned qualification connector is not configured');
  const connector = createPaperclipCloudConnector({ config });
  const credentials = createOAuthCredentialStore(db, secretService(db));
  const leases = createOAuthRefreshLeases(db, () => new Date(), getConnection, credentials.getOAuthGrantRow);
  const refresh = createOAuthGrantRefresh(db, { now: () => new Date(), store: credentials, leases, getConnectionRow: getConnection,
    currentCloudConnector: () => connector, exchangeOAuthToken: async () => { throw new Error('Unexpected direct OAuth outside managed GitHub fixture'); } });
  const continuity = createGitHubGrantContinuity(db, { now: () => new Date(), currentCloudConnector: () => connector,
    refreshOAuthGrantCredentials: refresh, resolveOAuthGrantSecret: credentials.resolveOAuthGrantSecret });
  const settled = await continuity.refreshManagedGitHubGrantAccess(connection, grant, { actorType: 'system', actorId: 'qualification' });
  if (settled.providerTenant?.github?.bindingSync || settled.providerTenant?.github?.continuityRetry) throw new Error('Real GitHub binding debt did not settle');
  return { connectionId: connection.id, grantId: grant.id, credentialRefs: settled.credentialSecretRefs.map(ref => ref.configPath),
    boundary: 'Actual encrypted user credential/version/binding owners and GitHub authority refresh; real signed broker binding; named external GitHub HTTP only' };
}
