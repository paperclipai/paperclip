import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@paperclipai/db';
import { readIdleSkillSourceSchedule, skillSourceIdleSchedule } from './skill-source-idle-schedule.js';
import { MAX_PROJECT_PENDING_SKILL_IMPORTS, SKILL_IMPORT_CAPACITY_WAIT } from './skill-source-import-queue.js';

const now = Date.UTC(2099, 0, 1);
const future = new Date(now + 300_000);
const source = { id: 'source', companyId: 'company', revision: 1, accessScope: 'company' as const,
  nextSyncAt: future, leaseToken: null, leaseExpiresAt: null };
const binding = { id: 'binding', companyId: 'company', projectId: 'project', workspaceId: 'workspace',
  active: true, status: 'pending' as const, lastError: null, nextSyncAt: future, leaseToken: null, leaseExpiresAt: null };

describe('skill source durable wake responsibility', () => {
  it('has no obligation for an absent feature and preserves a future configured check', () => {
    expect(skillSourceIdleSchedule([], [], now)).toMatchObject({ blocked: false, deadlines: [] });
    expect(skillSourceIdleSchedule([], [source], now)).toMatchObject({ blocked: false, deadlines: [future.getTime()] });
    expect(source.nextSyncAt).toBe(future);
  });
  it('does not postpone a due attempt merely by inspecting it', () => {
    expect(skillSourceIdleSchedule([binding], [], future.getTime()).blocked).toBe(true);
    expect(binding.nextSyncAt).toBe(future);
  });
  it('retains a coherent claim until its saved recovery time', () => {
    const expires = new Date(now + 600_000);
    expect(skillSourceIdleSchedule([], [{ ...source, leaseToken: 'claim', leaseExpiresAt: expires }], now))
      .toMatchObject({ blocked: false, deadlines: [expires.getTime()] });
    expect(skillSourceIdleSchedule([], [{ ...source, nextSyncAt: new Date(now - 1), leaseToken: 'claim', leaseExpiresAt: expires }], now))
      .toMatchObject({ blocked: false, deadlines: [expires.getTime()] });
  });
  it('blocks malformed claims, unknown state and invalid deadlines', () => {
    expect(skillSourceIdleSchedule([], [{ ...source, leaseToken: 'claim' }], now).blocked).toBe(true);
    expect(skillSourceIdleSchedule([], [{ ...source, leaseExpiresAt: future }], now).blocked).toBe(true);
    expect(skillSourceIdleSchedule([], [{ ...source, nextSyncAt: new Date(NaN) }], now).blocked).toBe(true);
    expect(skillSourceIdleSchedule([{ ...binding, status: 'ready' }], [], now).blocked).toBe(true);
    expect(skillSourceIdleSchedule([], [{ ...source, accessScope: 'unknown' as 'company' }], now).blocked).toBe(true);
  });
  it('cannot lose an inactive waiting admission behind a null or unrelated future deadline', () => {
    const waiting = { ...binding, active: false, lastError: SKILL_IMPORT_CAPACITY_WAIT };
    expect(skillSourceIdleSchedule([waiting], [], now).blocked).toBe(true);
    expect(skillSourceIdleSchedule([waiting], [source], now).blocked).toBe(true);
    expect(skillSourceIdleSchedule([{ ...waiting, workspaceId: null }], [], now).blocked).toBe(true);
  });
  it('hands a full project queue admission to the represented pending imports', () => {
    const peers = Array.from({ length: MAX_PROJECT_PENDING_SKILL_IMPORTS }, (_, i) => ({ ...binding, id: `peer-${i}` }));
    const waiting = { ...binding, active: false, lastError: SKILL_IMPORT_CAPACITY_WAIT };
    expect(skillSourceIdleSchedule([...peers, waiting], [], now).blocked).toBe(false);
    expect(skillSourceIdleSchedule([...peers.slice(1), waiting], [], now).blocked).toBe(true);
    expect(skillSourceIdleSchedule([...peers.map(peer => ({ ...peer, companyId: 'other' })), waiting], [], now).blocked).toBe(true);
  });
});

describe('skill source held reader', () => {
  function database() {
    const query = { from: () => query, innerJoin: () => query, where: () => query,
      orderBy: () => query, limit: async () => [] };
    const select = vi.fn(() => query);
    return { select, db: { select } as unknown as Pick<Db, 'select'> };
  }
  it('blocks unreconciled startup without adding passive SQL', async () => {
    const { select, db } = database();
    const snapshot = await readIdleSkillSourceSchedule(db, now, () => ({ revision: 'owner:0', reconciled: false }));
    expect(snapshot.blocked).toBe(true);
    expect(select).not.toHaveBeenCalled();
  });
  it('rejects an owner change during durable reads even when both reads are empty', async () => {
    const { db } = database();
    let revision = 0;
    const snapshot = await readIdleSkillSourceSchedule(db, now, () => ({ revision: `owner:${revision++}`, reconciled: true }));
    expect(snapshot.blocked).toBe(true);
  });
  it('binds settled empty durable state to its exact owner revision', async () => {
    const { db } = database();
    const snapshot = await readIdleSkillSourceSchedule(db, now, () => ({ revision: 'owner:1', reconciled: true }));
    expect(snapshot).toMatchObject({ blocked: false, deadlines: [], state: { reconciliation: { revision: 'owner:1' } } });
  });
});
