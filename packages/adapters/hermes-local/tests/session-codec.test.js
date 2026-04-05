
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionCodec } from '../src/server/index.js';

test('sessionCodec preserves cwd and repo metadata', () => {
  const raw = {
    sessionId: 's1',
    cwd: '/work',
    workspaceId: 'w1',
    repoUrl: 'https://example.com/repo.git',
    repoRef: 'main',
  };
  const parsed = sessionCodec.deserialize(raw);
  assert.deepEqual(parsed, raw);
  assert.deepEqual(sessionCodec.serialize(parsed), raw);
  assert.equal(sessionCodec.getDisplayId(parsed), 's1');
});
