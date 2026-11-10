import assert from 'node:assert/strict';
import type { Db } from '@paperclipai/db';
import { githubIngressFixture } from '../github-webhook-ingress.js';
import { chatChannelService } from '../../../services/chat-channels.js';

/** The fixture supplies the named external signed-webhook boundary; domain owners write receipts. */
export async function produceChatHistory(db: Db) {
  const fixture = await githubIngressFixture(db);
  const action = await fixture.insertAction();
  await fixture.service.processGitHubWebhookIngress(action.id);
  const finished = await fixture.readAction(action.id);
  assert.equal(fixture.calls.length, 1);
  assert.equal(finished.status, 'processed');
  const service = chatChannelService(db, { heartbeat: { wakeup: async () => { throw new Error('Unexpected chat turn'); } },
    fetch: async () => { throw new Error('Unexpected provider HTTP outside signed-webhook fixture'); } });
  try {
    await service.configure(fixture.endpoint.id, { action: 'remove' }, 'local-board');
  } finally { await service.shutdown(); }
  return { companyId: fixture.companyId, actionId: action.id, endpointId: fixture.endpoint.id,
    boundary: 'Existing signed webhook fixture input; actual chat ingress completion and ordinary endpoint removal preserve history' };
}
