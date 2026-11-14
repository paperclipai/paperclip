import test from 'node:test';
import assert from 'node:assert/strict';
import { createCleanup, createAudioSave, createReportSaver } from './cleanup.mjs';

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

test('final report waits for an older write and preserves its cleanup failures', async () => {
  let release;
  const writes = [], stored = [];
  const save = createReportSaver(async report => {
    writes.push(report);
    if (writes.length === 1) await new Promise(resolve => { release = resolve; });
    stored.push(report);
  });
  const earlier = {events: ['working'], cleanupFailures: []};
  const oldSave = save(earlier);
  await Promise.resolve();
  earlier.events.push('mutated after enqueue');
  const finalSave = save({events: ['ended'], cleanupFailures: ['session.end']});
  await Promise.resolve();
  assert.equal(writes.length, 1);
  release();
  await Promise.all([oldSave, finalSave]);
  assert.deepEqual(stored, [{events: ['working'], cleanupFailures: []}, {events: ['ended'], cleanupFailures: ['session.end']}]);
});

test('a failed periodic write does not prevent storing final cleanup evidence', async () => {
  let writes = 0;
  const save = createReportSaver(async report => { if (++writes === 1) throw new Error('failed'); return report; });
  await assert.rejects(save({events: []}));
  assert.deepEqual(await save({events: ['ended']}), {events: ['ended']});
});


test('stalled periodic transport is aborted and final evidence advances behind its late server write', async () => {
  let release, calls = 0;
  const stored = [];
  const serverSave = createReportSaver(async report => {
    if (!stored.length && report.phase === 'periodic') await new Promise(resolve => { release = resolve; });
    stored.push(report);
    return report;
  });
  const clientSave = createReportSaver((report, signal) => {
    const response = serverSave(report);
    if (++calls !== 1) { release(); return response; }
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      response.then(resolve, reject);
    });
  }, {timeoutMs: 20});
  const first = clientSave({phase: 'periodic'});
  const final = clientSave({phase: 'ended', cleanupFailures: ['session.end']});
  await assert.rejects(first, /Report save timed out/);
  assert.deepEqual(await final, {phase: 'ended', cleanupFailures: ['session.end']});
  assert.deepEqual(stored, [{phase: 'periodic'}, {phase: 'ended', cleanupFailures: ['session.end']}]);
});
