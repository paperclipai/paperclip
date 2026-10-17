import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { assertExecutedCases, assignedCaseShards, partitionCaseNames, runCaseShards } from '../run-vitest-case-shards.mjs';

const file = resolve('case.test.mjs');
const cases = ['alpha (.*)', 'beta [x] + $', 'duplicate', 'duplicate'].map(name => ({ name, file }));
const report = names => ({ success: true, numFailedTests: 0, testResults: [{ name: file,
  assertionResults: names.map(fullName => ({ fullName, title: fullName, ancestorTitles: [], status: 'passed' })) }] });

test('every case belongs to exactly one shard, with duplicate titles kept together', () => {
  const shards = partitionCaseNames(cases, 3, file);
  assert.deepEqual(shards.flatMap(shard => shard.tests).map(test => test.name).sort(), cases.map(test => test.name).sort());
  for (const testCase of cases) {
    assert.equal(shards.filter(shard => new RegExp(shard.pattern).test(testCase.name)).length, 1);
  }
  assert.equal(shards.some(shard => new RegExp(shard.pattern).test('alpha anything')), false);
  assert.equal(shards.some(shard => new RegExp(shard.pattern).test('prefix beta [x] + $')), false);
});

test('external lanes form a complete non-overlapping cover, including empty lanes', () => {
  for (const count of [1, 2, 8]) {
    const lanes = Array.from({ length: count }, (_, shardIndex) => assignedCaseShards(cases, 2, file, shardIndex, count));
    assert.deepEqual(lanes.flat(2).flatMap(shard => shard.tests).map(test => test.name).sort(), cases.map(test => test.name).sort());
    for (const name of new Set(cases.map(test => test.name))) {
      assert.equal(lanes.filter(lane => lane.some(shard => new RegExp(shard.pattern).test(name))).length, 1);
    }
  }
  for (const [index, count] of [[-1, 2], [2, 2], [0, 0], [0.5, 2], [0, Infinity]]) {
    assert.throws(() => assignedCaseShards(cases, 1, file, index, count));
  }
});

test('missing, extra, skipped, failed and wrong-file execution cannot qualify', () => {
  assertExecutedCases(cases, report(cases.map(test => test.name)), file);
  for (const names of [['alpha (.*)'], [...cases.map(test => test.name), 'extra'],
    ['alpha (.*)', 'beta [x] + $', 'duplicate']]) {
    assert.throws(() => assertExecutedCases(cases, report(names), file));
  }
  const skipped = report(cases.map(test => test.name));
  skipped.testResults[0].assertionResults[0].status = 'pending';
  assert.throws(() => assertExecutedCases(cases, skipped, file));
  const failed = report(cases.map(test => test.name));
  failed.success = false;
  assert.throws(() => assertExecutedCases(cases, failed, file));
  const otherFile = report(cases.map(test => test.name));
  otherFile.testResults[0].name = resolve('other.test.mjs');
  assert.throws(() => assertExecutedCases(cases, otherFile, file));
});

test('invalid inventory and worker arguments fail before execution', () => {
  for (const workers of [0, -1, 1.5, NaN]) assert.throws(() => partitionCaseNames(cases, workers, file));
  for (const tests of [[], [{ file, name: '' }], [{ file: 'different.test.mjs', name: 'case' }]]) {
    assert.throws(() => partitionCaseNames(tests, 2, file));
  }
});

test('nested result identities use the hierarchy without rewriting literal separators', () => {
  const name = 'parent > literal > child > literal';
  const nested = report([name]);
  Object.assign(nested.testResults[0].assertionResults[0], {
    ancestorTitles: ['parent > literal'], title: 'child > literal', fullName: 'parent > literal child > literal',
  });
  assertExecutedCases([{ file, name }], nested, file);
  assert.throws(() => assertExecutedCases([{ file, name: 'parent literal child literal' }], nested, file));
});

test('real Vitest expands each cases and runs them in separate processes with literal name filters', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'vitest-case-shards-'));
  const vitest = dirname(fileURLToPath(import.meta.resolve('vitest/package.json')));
  const target = join(root, 'case.test.mjs');
  const names = ['literal (.*)', 'literal [x] + $', 'duplicate', 'duplicate'];
  const makeSource = failing => `import { describe, expect, it } from ${JSON.stringify(pathToFileURL(join(vitest, 'dist/index.js')).href)};
    import { appendFileSync } from 'node:fs';
    function record(name) {
      appendFileSync(${JSON.stringify(join(root, 'pids.jsonl'))}, JSON.stringify({name, pid:process.pid})+'\\n');
      expect(${failing ? 'false' : 'true'}).toBe(true);
    }
    it.each(${JSON.stringify(names)})('%s', record);
    describe('parent > literal', () => it('child > literal', () => record('child > literal')));`;
  writeFileSync(join(root, 'vitest.config.mjs'), `export default {test:{include:['case.test.mjs']}};`);
  writeFileSync(target, makeSource(false));
  const options = { file: 'case.test.mjs', workers: 4, directory: join(root, 'pass'), cwd: root,
    command: [process.execPath, join(vitest, 'vitest.mjs')], env: { ...process.env, PAPERCLIP_CI_PROFILE: 'true',
      PAPERCLIP_CI_PROFILE_DIR: join(root, 'profile'), PAPERCLIP_CI_PROFILE_JOB: 'case-shards-regression' } };
  try {
    const result = await runCaseShards(options);
    assert.equal(result.tests, 5);
    assert.equal(result.workers, 4);
    const executions = readFileSync(join(root, 'pids.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(executions.map(entry => entry.name).sort(), [...names, 'child > literal'].sort());
    assert.equal(new Set(executions.map(entry => entry.pid)).size, 4);
    const records = readdirSync(join(root, 'profile')).flatMap(file =>
      readFileSync(join(root, 'profile', file), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    for (const kind of ['expected', 'start', 'end']) assert.equal(records.filter(record => record.kind === kind).length, 4, kind);
    assert.equal(records.filter(record => record.kind === 'test' && record.status === 'passed').length, 5);
    writeFileSync(join(root, 'pids.jsonl'), '');
    const external = await Promise.all(Array.from({ length: 3 }, (_, shardIndex) => runCaseShards({ ...options,
      workers: 2, shardIndex, shardCount: 3, directory: join(root, `external-${shardIndex}`) })));
    assert.equal(external.reduce((total, receipt) => total + receipt.tests, 0), 5);
    const distributed = readFileSync(join(root, 'pids.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(distributed.map(entry => entry.name).sort(), [...names, 'child > literal'].sort());
    writeFileSync(target, makeSource(true));
    await assert.rejects(runCaseShards({ ...options, directory: join(root, 'fail') }), /failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
