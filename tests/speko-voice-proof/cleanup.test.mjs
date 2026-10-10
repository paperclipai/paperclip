import test from 'node:test';
import assert from 'node:assert/strict';
import { createCleanup, createAudioSave } from './cleanup.mjs';

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


test('retries failed local operations and keeps End available until all media cleanup succeeds', async () => {
  let tracks = 0, sdk = 0, ends = 0, reports = 0;
  const cleanup = createCleanup({
    local: async attempt => {
      await attempt('tracks.stop', async () => { tracks++; });
      await attempt('sdk.end', async () => { if (++sdk === 1) throw new Error('temporary failure'); });
    },
    provider: async () => { ends++; }, report: async () => { reports++; }, failed: () => {},
  });
  assert.equal(await cleanup.end(), false);
  assert.equal(cleanup.complete, false);
  assert.equal(await cleanup.end(), true);
  assert.equal(cleanup.complete, true);
  assert.deepEqual({tracks, sdk, ends, reports}, {tracks: 1, sdk: 2, ends: 1, reports: 2});
});


test('failed audio upload is retryable with the same finalized recording and blocks cleanup completion', async () => {
  const blob = new Blob(['synthetic-audio']);
  let stops = 0, uploads = 0, ends = 0;
  const evidence = createAudioSave({stop: async () => { stops++; return blob; }, upload: async value => {
    assert.equal(value, blob); if (++uploads === 1) throw new Error('HTTP failure');
  }});
  const failures = [];
  const cleanup = createCleanup({local: async attempt => { await attempt('recording.save', () => evidence.save()); },
    provider: async () => { ends++; }, report: async () => {}, failed: operation => failures.push(operation)});
  assert.equal(await cleanup.end(), false);
  assert.equal(cleanup.complete, false);
  assert.deepEqual(failures, ['recording.save']);
  assert.equal(await cleanup.end(), true);
  assert.equal(cleanup.complete, true);
  assert.deepEqual({stops, uploads, ends}, {stops: 1, uploads: 2, ends: 1});
});

test('audio evidence waits for final recording data before upload and coalesces concurrent saves', async () => {
  let finish, uploads = 0;
  const stopped = new Promise(resolve => { finish = resolve; });
  const evidence = createAudioSave({stop: () => stopped, upload: async () => { uploads++; }});
  const first = evidence.save(), second = evidence.save();
  assert.equal(first, second);
  await Promise.resolve(); assert.equal(uploads, 0);
  finish(new Blob(['synthetic-audio']));
  await first; await evidence.save();
  assert.equal(uploads, 1);
});
