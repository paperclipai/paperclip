import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const file = 'doc/benchmarks/native-event-ingestion-2026-11-03/live-ce33-914/helpers/verify-birth-settlement.mjs';
const source = await readFile(new URL('../../' + file, import.meta.url), 'utf8');
const before = execFileSync('git', ['show', 'd05f9b0db71eaee823b72136ae54611b12a72f35:' + file], { encoding: 'utf8' });
const gate = { chain: [{ pid: 101, birthTime: 'fixture-birth', executable: 'fixture-provider' }] };
function check(text, ps) {
  const start = text.includes('const processList = ') ? text.indexOf('const processList = ') : text.indexOf('const checks=gate.chain.map');
  const end = text.indexOf('const output=', start);
  assert.ok(start >= 0 && end > start);
  return new Function('execFileSync', 'assert', 'process', 'gate', text.slice(start, end) + '\nreturn checks;')(
    ps, assert, { pid: 777 }, gate,
  );
}
const failure = details => Object.assign(new Error('injected process-list failure'), details);

test('original checker falsely accepted a failed ps call', () => {
  const result = check(before, () => { throw failure({ status: 1 }); });
  assert.equal(result[0].absent, true);
});
test('successful complete snapshot proves absent captured PIDs', () => {
  let calls = 0;
  const result = check(source, (command, args) => {
    calls++;
    assert.equal(command, 'ps');
    assert.deepEqual(args, ['-axo', 'pid=,ppid=,stat=,lstart=,comm=']);
    return ' 777 1 S Tue Nov 3 18:00:00 2026 node\n 888 1 S Tue Nov 3 18:00:00 2026 ps\n';
  });
  assert.equal(calls, 1);
  assert.equal(result[0].absent, true);
});
test('process-list command failures never prove absence', () => {
  for (const details of [{ status: 1 }, { status: 2 }, { code: 'ENOENT' }, { code: 'EACCES' }, { signal: 'SIGTERM', status: null }]) {
    const error = failure(details);
    assert.throws(() => check(source, () => { throw error; }), value => value === error);
  }
});
test('empty, malformed and incomplete snapshots fail closed', () => {
  for (const text of ['', 'invalid row\n', ' 888 1 S ps\n']) assert.throws(() => check(source, () => text));
});
test('a captured process still present rejects settlement', () => {
  assert.throws(() => check(source, () => ' 777 1 S node\n 101 1 S fixture-provider\n'), /remains present/);
});
