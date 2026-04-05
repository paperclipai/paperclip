
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { onHireApproved } from '../src/server/hire-approved.js';

test('onHireApproved writes a durable local notification file', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-hire-'));
  try {
    const result = await onHireApproved(
      {
        companyId: 'co-1',
        agentId: 'a-1',
        agentName: 'Analyst',
        adapterType: 'hermes_local',
        source: 'approval',
        sourceId: 'apr-1',
        approvedAt: '2026-01-01T00:00:00.000Z',
        message: 'approved',
      },
      { env: { HERMES_HOME: tmp } }
    );
    assert.equal(result.ok, true);
    const dir = path.join(tmp, 'paperclip-notifications', 'hire-approved');
    const items = await fs.readdir(dir);
    assert.equal(items.length, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
