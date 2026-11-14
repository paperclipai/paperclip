import assert from 'node:assert/strict';
import { authUsers, companyMemberships, type Db } from '@paperclipai/db';
import { and, eq } from 'drizzle-orm';
import { cloudTenantPrimaryCompanyId } from '../../../services/cloud-instance.js';
import type { MaintenanceConfiguration, MaintenanceServerOptions, startMaintenanceServer } from './server-harness.js';

export const managedTenantActor = { userId: 'local-board', email: 'sleep-owner@example.test', name: 'Owned sleep operator' };
export function managedSleepConfiguration(collectorOrigin: string, serveUi: boolean): MaintenanceConfiguration {
  return { automaticBackups: { intervalMinutes: 60, idleCheckpoint: true }, announcements: true,
    telemetryOrigin: `${collectorOrigin}/telemetry`, otelOrigin: collectorOrigin, serveUi,
    managedInstance: true, deploymentMode: 'authenticated', storageProvider: 's3' };
}
export function managedSleepServerOptions(configuration: MaintenanceConfiguration, jwks: string, s3Origin: string,
  broker: { origin: string; variables: Record<string, string> }): MaintenanceServerOptions {
  return { configuration, controlJwks: jwks, cloud: { jwks, s3Origin, standby: false }, tenantActor: managedTenantActor,
    githubOrigin: broker.origin, connector: { origin: broker.origin,
      instanceId: broker.variables.PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID,
      signPrivateKey: broker.variables.PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY,
      sealPrivateKey: broker.variables.PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY } };
}
export async function provisionManagedSleepCompany(server: Awaited<ReturnType<typeof startMaintenanceServer>>, db: Db) {
  // This real request invokes resolveCloudTenantActor, never a table seed or a bypassed company-create route.
  const companies = await server.api<Array<{ id: string }>>('GET', '/companies');
  const id = cloudTenantPrimaryCompanyId('maintenance-stack');
  assert(companies.some(company => company.id === id), 'Actual managed primary company was not provisioned');
  const [authority] = await db.select({ userId: authUsers.id, status: companyMemberships.status, membershipRole: companyMemberships.membershipRole })
    .from(authUsers).innerJoin(companyMemberships, and(eq(companyMemberships.principalId, authUsers.id), eq(companyMemberships.principalType, 'user')))
    .where(and(eq(authUsers.id, managedTenantActor.userId), eq(companyMemberships.companyId, id)));
  assert.deepEqual(authority, { userId: managedTenantActor.userId, status: 'active', membershipRole: 'owner' });
  await server.api('PATCH', `/companies/${id}`, { defaultResponsibleUserId: managedTenantActor.userId });
  const observation = (await server.snapshot()).managed;
  assert(observation?.isCloudManaged && observation.deploymentMode === 'authenticated' && observation.storageProvider === 's3', 'Actual supported managed profile not active');
  return { id, authority, observation, boundary: 'Fixture Cloud front-door headers; actual resolver creates canonical company/user/member/default grants' };
}
