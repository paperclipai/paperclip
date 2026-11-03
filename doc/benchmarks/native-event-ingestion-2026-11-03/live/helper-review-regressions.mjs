import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = process.argv[2];
const archived = process.argv[3];
const output = process.argv[4];
assert.ok(root && archived && output, 'Pass after-helper directory, before-helper directory and owned output JSON path');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const source = async (dir, name) => readFile(`${dir}/${name}`, 'utf8');
const digest = text => createHash('sha256').update(text).digest('hex');
const before = { launcher: await source(archived, 'live-launch.mjs'), browser: await source(archived, 'live-browser.mjs') };
const after = { launcher: await source(root, 'live-launch.mjs'), browser: await source(root, 'live-browser.mjs') };
const cases = [];
async function checkoutContract(text, linkedWorktree, instanceId = 'default') {
  const setup = text.match(/(?:const \{ linkedWorktree \} = )?await prepareTestDriveEnvironment\(options, repository\);/)?.[0];
  const start = text.indexOf('  const fixture = await bootstrapTestDrive(');
  const end = text.indexOf(';\n', start) + 1;
  assert.ok(setup && start >= 0 && end > start, 'Exact helper contract statements must exist');
  const execute = new AsyncFunction('prepareTestDriveEnvironment', 'bootstrapTestDrive', 'options', 'repository', 'api', 'process',
    `${setup}\n${text.slice(start, end)}\nreturn fixture;`);
  const env = { PAPERCLIP_INSTANCE_ID: instanceId };
  return execute(async () => ({ dataDir: '/owned/data', linkedWorktree }), async input => {
    assert.equal(input.linkedWorktree, linkedWorktree, 'Forward the detected checkout mode');
    assert.equal(input.instanceId, instanceId, 'Forward the prepared instance identity');
    assert.equal(input.env, env);
    return { linkedWorktree: input.linkedWorktree, instanceId: input.instanceId };
  }, {}, '/owned/repository', {}, { env });
}
await assert.rejects(checkoutContract(before.launcher, false), /Forward the detected checkout mode/);
cases.push({ name: 'original launcher rejects ordinary-checkout contract', outcome: 'expected failure reproduced' });
for (const linkedWorktree of [false, true]) {
  await checkoutContract(after.launcher, linkedWorktree);
  cases.push({ name: `fixed launcher forwards linkedWorktree=${linkedWorktree}`, outcome: 'passed' });
}
await checkoutContract(after.launcher, false, 'prepared-instance');
cases.push({ name: 'fixed launcher forwards the prepared instance identity', outcome: 'passed' });

async function streamingContract(text, { afterVisibleStatus = 'running', visible = true, ordinaryDelta = true } = {}) {
  const start = text.indexOf('  const streaming = await poll(');
  const end = text.indexOf('  await page.screenshot(', start);
  const normalizer = text.split('\n').find(line => line.startsWith('const normalizeVisible = '));
  const summaryStart = text.indexOf('const runSummary = '), summaryEnd = text.indexOf('async function taskRuns(', summaryStart);
  assert.ok(start >= 0 && end > start && normalizer && summaryStart >= 0 && summaryEnd > summaryStart);
  const execute = new AsyncFunction('poll', 'taskRuns', 'visibleAgentText', 'eventsFor', 'api', 'created', 'journey', 'expect',
    `${normalizer}\n${text.slice(summaryStart, summaryEnd)}\n${text.slice(start, end)}\nreturn journey;`);
  const calls = [], active = { id: 'native-run', status: 'running', runtimeMode: 'native' };
  let taskRunReads = 0, visibleRead = false;
  const journey = {};
  const result = await execute(async (label, load, accept) => {
    const value = await load();
    if (!accept(value)) throw new Error('streaming_observation_not_proven');
    return value;
  }, async () => {
    calls.push('task-runs'); taskRunReads++;
    // The run settles directly after the successful active observation.
    return [{ ...active, status: taskRunReads === 1 ? 'running' : 'succeeded' }];
  }, async () => { calls.push('visible-text'); visibleRead = true; return visible ? 'ordinary assistant streaming delta' : 'unrelated content'; },
  async () => { calls.push('durable-events'); return [{ payload: { prpEvent: {
    eventType: 'item.delta', sourceEventId: 'event-1', sourceSeq: 1, emittedAt: 'fixture-time',
    payload: { kind: ordinaryDelta ? 'agentMessage' : 'reasoning', text: 'ordinary assistant streaming delta' },
  } } }]; },
  async () => {
    assert.equal(visibleRead, true, 'Status must be read after visible text'); calls.push('status-after-visible');
    return { ...active, status: afterVisibleStatus };
  }, { issueId: 'owned-issue' }, journey,
  value => ({ toBe(expected) { assert.equal(value, expected); } }));
  return { result, calls, taskRunReads };
}
await assert.rejects(streamingContract(before.browser), /false !== true/);
cases.push({ name: 'original observer rejects a run settling immediately after successful active poll', outcome: 'expected false negative reproduced' });
const success = await streamingContract(after.browser);
assert.equal(success.taskRunReads, 1, 'No extra run-state read can invalidate the captured observation');
assert.deepEqual(success.calls, ['task-runs', 'visible-text', 'durable-events', 'status-after-visible']);
assert.equal(success.result.visibleBeforeTerminal, true);
assert.equal(success.result.streamingRunStatuses[0].status, 'running');
assert.equal(success.result.visibleDelta.sourceEventId, 'event-1');
assert.equal(success.result.firstVisibleAt, success.result.visibleDelta.visibleAt);
cases.push({ name: 'fixed observer retains exact successful active-stream observation across terminal race', outcome: 'passed', calls: success.calls });
for (const [name, options] of [
  ['terminal status after visibility still rejects streaming proof', { afterVisibleStatus: 'succeeded' }],
  ['missing visible matching text still rejects streaming proof', { visible: false }],
  ['reasoning-only event still rejects ordinary-assistant proof', { ordinaryDelta: false }],
]) {
  await assert.rejects(streamingContract(after.browser, options), /streaming_observation_not_proven/);
  cases.push({ name, outcome: 'expected rejection passed' });
}
const report = {
  passed: true,
  scope: 'Controlled helper contract/observation seams extracted from actual archived and changed source; no app, browser, provider, database or network is started.',
  historicalLiveProof: '/private/tmp/native-ingestion-live-proof-base61-b9',
  historicalProofUsesOriginalHelpers: true,
  files: Object.fromEntries(Object.keys(before).map(name => [name, { beforeSha256: digest(before[name]), afterSha256: digest(after[name]) }])),
  cases,
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
