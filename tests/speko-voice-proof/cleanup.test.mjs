import test from 'node:test';
import assert from 'node:assert/strict';
import { createCleanup } from './cleanup.mjs';

test('failed hangup preserves evidence and retries only the unconfirmed provider operation', async () => {
  let locals = 0, ends = 0;
  const failures = [], reports = [];
  const cleanup = createCleanup({
    local: async () => { locals++; },
    provider: async () => { if (++ends === 1) throw new Error('private failure'); },
    report: async () => { reports.push([...failures]); },
    failed: (operation) => failures.push(operation),
  });
  assert.equal(await cleanup.end(), false);
  assert.equal(cleanup.complete, false);
  assert.deepEqual(reports, [['session.end']]);
  assert.equal(await cleanup.end(), true);
  assert.equal(cleanup.complete, true);
  assert.equal(locals, 1);
  assert.equal(ends, 2);
  assert.equal(reports.length, 2);
});

test('media failures do not prevent hangup or final evidence; concurrent cleanup coalesces', async () => {
  let ends = 0, reports = 0;
  const failures = [];
  const cleanup = createCleanup({
    local: async (attempt) => {
      await attempt('sdk.end', async () => { throw new Error('sdk failure'); });
      await attempt('tracks.stop', async () => { throw new Error('media failure'); });
    },
    provider: async () => { ends++; },
    report: async () => { reports++; },
    failed: (operation) => failures.push(operation),
  });
  assert.deepEqual(await Promise.all([cleanup.end(), cleanup.end()]), [false, false]);
  assert.equal(ends, 1);
  assert.equal(reports, 1);
  assert.deepEqual(failures, ['sdk.end', 'tracks.stop']);
});

test('failed report can be retried without redialing or repeating a confirmed hangup', async () => {
  let ends = 0, reports = 0;
  const cleanup = createCleanup({ local: async () => {}, provider: async () => { ends++; },
    report: async () => { if (++reports === 1) throw new Error('disk failure'); }, failed: () => {} });
  assert.equal(await cleanup.end(), false);
  assert.equal(cleanup.complete, false);
  assert.equal(await cleanup.end(), true);
  assert.equal(ends, 1);
  assert.equal(reports, 2);
});
