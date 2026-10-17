import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invocationEnv } from './ci-profile/record.mjs';
import { startPrefetch, stopPrefetches } from './prefetch-child.mjs';

const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function partitionCaseNames(tests, workers, file) {
  assert.ok(Number.isSafeInteger(workers) && workers > 0, 'Invalid worker count');
  assert.ok(Array.isArray(tests) && tests.length > 0, 'No collected tests');
  const groups = new Map();
  for (const test of tests) {
    assert.equal(resolve(test.file), resolve(file), 'Unexpected collected file');
    assert.ok(typeof test.name === 'string' && test.name.length > 0, 'Missing test name');
    if (!groups.has(test.name)) groups.set(test.name, []);
    groups.get(test.name).push(test);
  }
  const shards = Array.from({ length: Math.min(workers, groups.size) }, () => ({ tests: [], names: [] }));
  for (const [name, cases] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const target = shards.reduce((best, next) => next.tests.length < best.tests.length ? next : best);
    target.names.push(name);
    target.tests.push(...cases);
  }
  return shards.map(shard => ({ ...shard, pattern: `^(?:${shard.names.map(escapePattern).join('|')})$` }));
}

export function assertExecutedCases(expected, report, file) {
  assert.equal(report.success, true, 'Vitest reported a failure');
  assert.equal(report.numFailedTests, 0, 'Vitest reported failed tests');
  const actual = [];
  for (const suite of report.testResults) {
    assert.equal(resolve(suite.name), resolve(file), 'Unexpected result file');
    for (const test of suite.assertionResults) {
      if (test.status === 'pending' || test.status === 'skipped') continue;
      assert.equal(test.status, 'passed', `Test did not pass: ${test.fullName}`);
      assert.ok(Array.isArray(test.ancestorTitles) && typeof test.title === 'string', 'Missing test hierarchy');
      actual.push([...test.ancestorTitles, test.title].join(' > '));
    }
  }
  assert.deepEqual(actual.sort(), expected.map(test => test.name).sort(), 'Executed cases differ from assigned cases');
}

export function assignedCaseShards(tests, workers, file, shardIndex = 0, shardCount = 1) {
  assert.ok(Number.isSafeInteger(shardCount) && shardCount > 0, 'Invalid shard count');
  assert.ok(Number.isSafeInteger(shardIndex) && shardIndex >= 0 && shardIndex < shardCount, 'Invalid shard index');
  return partitionCaseNames(tests, workers * shardCount, file).filter((_, index) => index % shardCount === shardIndex);
}

export async function runCaseShards({ file, workers, directory, shardIndex = 0, shardCount = 1, cwd = process.cwd(), env = process.env, command = ['pnpm', 'exec', 'vitest'] }) {
  const started = performance.now();
  const absoluteFile = realpathSync(resolve(cwd, file));
  const output = resolve(directory);
  mkdirSync(output, { recursive: true });
  const handles = [];
  const launch = (name, args, runEnv) => {
    const handle = startPrefetch({ name, cmd: command[0], args: [...command.slice(1), ...args], cwd,
      env: runEnv, logPath: resolve(output, `${name}.log`) });
    handles.push(handle);
    return handle;
  };
  try {
    const collected = resolve(output, 'collected.json');
    await launch('collect', ['list', file, '--no-static-parse', '--allowOnly=false', `--json=${collected}`], env).done;
    const tests = JSON.parse(readFileSync(collected, 'utf8'));
    const shards = assignedCaseShards(tests, workers, absoluteFile, shardIndex, shardCount);
    const collectMs = performance.now() - started;
    const results = await Promise.allSettled(shards.map(async (shard, index) => {
      const reportPath = resolve(output, `shard-${index}.json`);
      const reporters = ['--reporter=default', '--reporter=json'];
      if (env.PAPERCLIP_CI_PROFILE === 'true') {
        reporters.push(`--reporter=${fileURLToPath(new URL('./ci-profile/vitest-reporter.mjs', import.meta.url))}`);
      }
      const handle = launch(`shard-${index}`, ['run', file, '--allowOnly=false', '--pool=forks', '--maxWorkers=1',
        '--no-file-parallelism', `--testNamePattern=${shard.pattern}`, ...reporters, `--outputFile.json=${reportPath}`], invocationEnv('vitest', env));
      await handle.done;
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      assertExecutedCases(shard.tests, report, absoluteFile);
      return { index, tests: shard.tests.length, elapsedMs: handle.durationMs };
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    const receipt = { file, workers: shards.length, tests: shards.reduce((total, shard) => total + shard.tests.length, 0), totalTests: tests.length, shardIndex, shardCount, collectMs,
      elapsedMs: performance.now() - started, shards: results.map(result => result.value) };
    writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt));
    return receipt;
  } finally {
    await stopPrefetches(handles);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, workers, directory] = process.argv.slice(2);
  assert.ok(file && workers && directory, 'Usage: run-vitest-case-shards.mjs FILE WORKERS OUTPUT_DIRECTORY');
  await runCaseShards({ file, workers: Number(workers), directory });
}
