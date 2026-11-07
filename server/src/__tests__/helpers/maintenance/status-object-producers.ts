import assert from 'node:assert/strict';
import { INSTANCE_FEATURE_CATALOG, PAPERCLIP_CLOUD_MANAGED_BY, type InstanceExperimentalSettingsWithManaged } from '@paperclipai/shared';
import { createServer } from 'node:http';
import { writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { startMaintenanceServer } from './server-harness.js';
type Server = Awaited<ReturnType<typeof startMaintenanceServer>>;
async function assertManagedOwnerFeature(server: Server, chosen: 'enableStatusCards' | 'enableExternalObjects') {
  const settings = await server.api<InstanceExperimentalSettingsWithManaged>('GET', '/instance/settings/experimental');
  assert.equal(settings[chosen], true);
  assert.deepEqual(settings.managedKeys?.[chosen], { managed: true, managedBy: PAPERCLIP_CLOUD_MANAGED_BY });
  const unchosen = chosen === 'enableStatusCards' ? 'enableExternalObjects' : 'enableStatusCards';
  assert.equal(settings[unchosen], INSTANCE_FEATURE_CATALOG[unchosen].cloudDefault);
  assert.equal(settings.managedKeys?.[unchosen], undefined);
}
export async function prepareStatusInterval(server: Server, companyId: string, statePath: string) {
  const writeState = async (value: { cardId?: string; revision: number }) => {
    await writeFile(statePath + '.pending', JSON.stringify(value), { mode: 0o600 });
    await rename(statePath + '.pending', statePath);
  };
  const originPath = statePath + '.api-origin';
  const writeExpectedApiOrigin = async (currentServer: Server) => {
    await writeFile(originPath + '.pending', `http://127.0.0.1:${currentServer.port}`, { mode: 0o600 });
    await rename(originPath + '.pending', originPath);
  };
  await writeExpectedApiOrigin(server);
  await writeState({ revision: 1 });
  await assertManagedOwnerFeature(server, 'enableStatusCards');
  const agent = await server.api<{ id: string }>('POST', `/companies/${companyId}/agents`, {
    name: 'Controlled interval summarizer', adapterType: 'process', runner: 'legacy',
    adapterConfig: { env: { STATUS_OBJECT_EXPECTED_API_ORIGIN_FILE: originPath, DATABASE_URL: '', PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG: process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG }, command: process.execPath, args: ['--require',
      fileURLToPath(new URL('../../../../../scripts/fixtures/skill-default-cadence-network-guard.cjs', import.meta.url)),
      fileURLToPath(new URL('./status-interval-agent.mjs', import.meta.url)), statePath], timeoutSec: 30, graceSec: 5 },
  });
  const blocker = await server.api<{ id: string }>('POST', `/companies/${companyId}/issues`, { title: 'A real persisted blocker', status: 'blocked', priority: 'medium' });
  const card = await server.api<{ id: string }>('POST', `/companies/${companyId}/status-cards`, {
    interestPrompt: 'Summarize current blocked issues', agentId: agent.id,
    refreshPolicy: { mode: 'interval', intervalMinutes: 15 },
  });
  const revision = (value: number) => {
    assert(Number.isSafeInteger(value) && value > 0);
    return writeState({ cardId: card.id, revision: value });
  };
  await revision(1);
  return { agentId: agent.id, cardId: card.id, blockerId: blocker.id, revision, writeExpectedApiOrigin };
}
export function statusObjectGitHubBoundary() {
  let revision = 1;
  const requests: Array<{ at: number; path: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ at: Date.now(), path: request.url ?? '' });
    const body = request.url === '/repos/acme/sleep-object'
      ? { id: 731, full_name: 'acme/sleep-object', private: false, owner: { login: 'acme' } }
      : request.url === '/repos/acme/sleep-object/issues/7'
        ? { id: 732, number: 7, title: `Useful GitHub object revision ${revision}`, state: 'open',
          html_url: 'https://github.com/acme/sleep-object/issues/7', updated_at: new Date().toISOString(), labels: [] }
        : undefined;
    response.setHeader('Content-Type', 'application/json');
    response.statusCode = body ? 200 : 404;
    response.end(JSON.stringify(body ?? { message: 'Unexpected owned GitHub path' }));
  });
  return { server, requests, revision(value: number) { assert(Number.isSafeInteger(value) && value > revision); revision = value; } };
}
export async function prepareGitHubObject(server: Server, companyId: string) {
  await assertManagedOwnerFeature(server, 'enableExternalObjects');
  const issue = await server.api<{ id: string; companyId: string; description: string | null }>('POST', `/companies/${companyId}/issues`, {
    title: 'Track the ordinary supported GitHub issue', status: 'todo', priority: 'medium',
  });
  assert.equal(issue.companyId, companyId);
  assert(!issue.description?.includes('https://github.com/acme/sleep-object/issues/7'));
  return { issueId: issue.id, async addReference() {
    const description = 'Reference https://github.com/acme/sleep-object/issues/7';
    const updated = await server.api<{ id: string; companyId: string; description: string }>('PATCH', `/issues/${issue.id}`, { description });
    assert.equal(updated.id, issue.id);
    assert.equal(updated.companyId, companyId);
    assert.equal(updated.description, description);
    return updated;
  } };
}
