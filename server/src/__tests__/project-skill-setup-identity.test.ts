import { beforeEach, expect, it, vi } from 'vitest';
import type { Db } from '@paperclipai/db';
import { projectSkillSetupIdentity } from '../services/project-skill-source-bindings.js';
const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../services/run-identity.js', () => ({ captureRunIdentity: capture }));
const db = {} as Db;
const actor = { type: 'agent' as const, source: 'agent_jwt' as const, companyId: 'company', agentId: 'agent', runId: 'run', onBehalfOfUserId: 'forged' };
beforeEach(() => capture.mockReset());
it('keeps responsibility without searching personal GitHub grants when the run has no selected credential', async () => {
  capture.mockResolvedValue({ run: { responsibleUserId: 'person' }, context: { github: null } });
  expect(await projectSkillSetupIdentity(db, 'company', actor)).toMatchObject({ refreshUserId: 'person', connectionId: null, refreshGrantId: null });
});
it('pins only the connection and grant already authorized for the active run', async () => {
  capture.mockResolvedValue({ run: { responsibleUserId: 'person' }, context: { github: { status: 'available', connectionId: 'selected', grantId: 'grant' } } });
  expect(await projectSkillSetupIdentity(db, 'company', actor)).toMatchObject({ refreshUserId: 'person', connectionId: 'selected', refreshGrantId: 'grant' });
  expect(capture).toHaveBeenCalledWith(db, { companyId: 'company', agentId: 'agent', runId: 'run' }, { readScope: 'identity' });
});
it('does not reuse an unavailable run credential', async () => {
  capture.mockResolvedValue({ run: { responsibleUserId: 'person' }, context: { github: { status: 'unavailable', connectionId: 'old', grantId: 'old' } } });
  expect(await projectSkillSetupIdentity(db, 'company', actor)).toMatchObject({ connectionId: null, refreshGrantId: null });
});
it('API keys do not obtain responsibility or a run credential', async () => {
  expect(await projectSkillSetupIdentity(db, 'company', { ...actor, source: 'agent_key' })).toMatchObject({ refreshUserId: null, connectionId: null, refreshGrantId: null });
  expect(capture).not.toHaveBeenCalled();
});
