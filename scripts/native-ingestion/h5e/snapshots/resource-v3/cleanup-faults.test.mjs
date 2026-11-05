import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseShow, unitName, validateCleanupUnit, serviceCommand } from './pg-service.mjs';
import { validateExitProof, parseExitShow, EXIT_KEYS } from './pg-exit-receipt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = file => readFileSync(path.join(here, file), 'utf8');
const absent = () => Object.assign(new Error('synthetic_absent'), { code: 'ENOENT' });
const release = { nonce: 'pure-source-fault', releaseSha256: 'a'.repeat(64), releaseFile: '/fixture/release.json', output: '/fixture/output',
  nodeExecutable: '/fixture/node', pg: { postgresBinary: '/fixture/postgres', postgresSha256: 'b'.repeat(64) } };
const ownership = { unit: unitName(release.nonce), unitAbsentBefore: true, sourceReleaseSha256: release.releaseSha256,
  envFile: '/fixture/output/owned-pg-environment', passwordFile: '/fixture/output/owned-initdb-password', dataDir: '/fixture/db', selectedPort: 55432 };
const ready = { pid: 123, starttimeTicks: '55', cgroupPath: '/fixture/cgroup', nonce: release.nonce, bootId: 'synthetic-boot',
  sourceReleaseSha256: release.releaseSha256, exitWriterSha256: 'e'.repeat(64), invocationId: 'c'.repeat(32) };
const readyHash = 'd'.repeat(64), writerHash = 'e'.repeat(64);
const normalProof = () => ({ schema: 'native-ingestion-systemd-pg-exit/v1', sourceReleaseSha256: release.releaseSha256, nonce: release.nonce,
  readyReceiptSha256: readyHash, writerSha256: writerHash, bootId: ready.bootId, pid: ready.pid, starttimeTicks: ready.starttimeTicks,
  unit: { Id: ownership.unit, InvocationID: ready.invocationId, ExecMainPID: '123', ExecMainCode: '1', ExecMainStatus: '0', Result: 'success' },
  systemdExit: { SERVICE_RESULT: 'success', EXIT_CODE: 'exited', EXIT_STATUS: '0' }, complete: true, normalPgShutdown: true });

function stopFixture(version, { initiallyAbsent = false, missingProof = false, reusedPid = false, omitMissingMainPid = false, proof = normalProof() } = {}) {
  const pg = source(version === 'old' ? 'test-fixtures/v1/pg-service.mjs' : 'pg-service.mjs');
  const showKeys = vm.runInNewContext(pg.slice(pg.indexOf('const showKeys = '), pg.indexOf('export const unitName')) + '\nshowKeys');
  const show = pg.slice(pg.indexOf('export async function serviceState('), pg.indexOf('export async function verifyPgService(')).replace(/^export /, '');
  const stop = pg.slice(pg.indexOf('export async function stopPgService(')).replace(/^export /, '')
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(here, 'pg-service.mjs')).href));
  const record = { shows: 0, stops: 0, unlinks: [], pidReads: [], scopeStats: [], writes: [] };
  const notFound = Object.assign(new Error('synthetic_systemctl_not_found'), { code: 1,
    stdout: `Id=${ownership.unit}\nLoadState=not-found\nActiveState=inactive\n${omitMissingMainPid ? '' : 'MainPID=0\n'}Result=success\n` });
  const context = { assert, path, JSON, Buffer, Date, URL, fileURLToPath, showKeys, parseShow, unitName, validateCleanupUnit, validateExitProof,
    process: { getuid: () => 1000 },
    json: async file => file.endsWith('pg-service.json') ? ready : file.endsWith('pg-start-attempt.json') ?
      { nonce: release.nonce, sourceReleaseSha256: release.releaseSha256, unit: ownership.unit } : ownership,
    systemctl: async (_release, operation) => {
      if (operation === 'stop') { record.stops++; return { stdout: '' }; }
      if (++record.shows === 1 && !initiallyAbsent) return { stdout: `Id=${ownership.unit}\nLoadState=loaded\nActiveState=active\nMainPID=0\n` };
      throw notFound;
    },
    readFile: async file => {
      if (file.includes('/proc/')) { record.pidReads.push(file); if (reusedPid) return 'replacement-pid'; throw absent(); }
      if (file.endsWith('pg-systemd-exit.json')) return Buffer.from(JSON.stringify(proof));
      throw new Error('unexpected_synthetic_read:' + file);
    },
    lstat: async () => { if (missingProof) throw absent(); return { uid: 1000, mode: 0o100600, isFile: () => true }; },
    stat: async file => { record.scopeStats.push(file); throw absent(); },
    unlink: async file => record.unlinks.push(file),
    shaFile: async file => file.endsWith('pg-service.json') ? readyHash : writerHash,
    writeFile: async (file, bytes) => record.writes.push({ file, value: JSON.parse(bytes) }),
  };
  return { record, stop: vm.runInNewContext(show + '\n' + stop + '\nstopPgService', context), notFound };
}

test('RED actual V1 stop success plus unit GC skips private cleanup; GREEN V2 retains normal proof and verifies retirement', async () => {
  const old = stopFixture('old'); await assert.rejects(old.stop(release), error => error === old.notFound);
  assert.equal(old.record.stops, 1); assert.equal(old.record.unlinks.length, 0); assert.equal(old.record.pidReads.length, 0);
  const current = stopFixture('new', { omitMissingMainPid: true }), result = await current.stop(release);
  assert.equal(result.complete, true); assert.equal(result.shutdownClassification, 'NORMAL'); assert.equal(result.unitNeverStarted, false);
  assert.equal(result.pidAbsent, true); assert.equal(result.scopeAbsent, true); assert.equal(current.record.unlinks.length, 2);
  assert.equal(current.record.writes.at(-1).value.complete, true);
});

test('RED V1 initially collected ready service is falsely never-started; GREEN V2 requires its exit proof and retirement', async () => {
  const old = stopFixture('old', { initiallyAbsent: true }), oldResult = await old.stop(release);
  assert.equal(oldResult.unitNeverStarted, true); assert.equal(old.record.pidReads.length, 0);
  const current = stopFixture('new', { initiallyAbsent: true }), result = await current.stop(release);
  assert.equal(result.unitNeverStarted, false); assert.equal(result.normalPgShutdown, true); assert.equal(current.record.stops, 0);
  assert.equal(current.record.pidReads.length, 1); assert.equal(current.record.scopeStats.length, 1);
});

test('missing/mismatched exit proof and PID reuse fail honestly while always removing exact owned private paths', async () => {
  for (const options of [{ missingProof: true }, { reusedPid: true },
    { proof: { ...normalProof(), readyReceiptSha256: 'f'.repeat(64) } },
    { proof: { ...normalProof(), systemdExit: { SERVICE_RESULT: 'timeout', EXIT_CODE: 'killed', EXIT_STATUS: 'KILL' } } }]) {
    const current = stopFixture('new', options); await assert.rejects(current.stop(release));
    assert.deepEqual(current.record.unlinks, [ownership.envFile, ownership.passwordFile]);
    const result = current.record.writes.at(-1).value;
    assert.equal(result.complete, false); assert.equal(result.normalPgShutdown, false); assert.equal(result.shutdownClassification, 'UNKNOWN');
    assert.equal(result.privateEnvironmentRemoved, true);
  }
});

function writerFixture(bad = false) {
  const text = source('pg-exit-receipt.mjs');
  const main = text.slice(text.indexOf('async function main()'), text.indexOf('\nif (process.argv[1]'))
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(here, 'pg-exit-receipt.mjs')).href));
  const writes = [], renames = [], commands = [];
  const exit = normalProof(); if (bad) exit.unit.ExecMainStatus = '1';
  const context = { assert, path, JSON, Object, Buffer, URL, Date, fileURLToPath, EXIT_KEYS, parseExitShow, validateExitProof,
    process: { argv: ['node', 'script', '--record-systemd-exit', '--release=/fixture/release.json', '--release-sha256=' + release.releaseSha256], env: exit.systemdExit },
    shaFile: async file => file.endsWith('release.json') ? release.releaseSha256 : writerHash,
    json: async () => ({ ...release }), validateRelease: value => value,
    hash: () => readyHash,
    readFile: async file => file.endsWith('pg-service.json') ? Buffer.from(JSON.stringify(ready)) : ready.bootId + '\n',
    execFile: () => { throw new Error('No real command permitted'); },
    promisify: () => async (executable, args) => { commands.push({ executable, args }); return { stdout: Object.entries(exit.unit).map(([key, value]) => key + '=' + value).join('\n') }; },
    lstat: async () => { throw absent(); }, writeFile: async (file, bytes, options) => writes.push({ file, value: JSON.parse(bytes), options }),
    rename: async (...args) => renames.push(args),
  };
  return { main: vm.runInNewContext(main + '\nmain', context), writes, renames, commands };
}

test('actual ExecStopPost writer atomically preserves own-unit status; bad exit stays explicitly unqualified', async () => {
  const valid = writerFixture(); await valid.main();
  assert.equal(valid.commands[0].executable, '/usr/bin/systemctl'); assert.equal(valid.commands[0].args.at(-1), ownership.unit);
  assert.equal(valid.writes[0].options.mode, 0o600); assert.equal(valid.renames.length, 1); assert.equal(valid.writes[0].value.normalPgShutdown, true);
  const invalid = writerFixture(true); await assert.rejects(invalid.main());
  assert.equal(invalid.writes[0].value.complete, false); assert.equal(invalid.writes[0].value.normalPgShutdown, false); assert.equal(invalid.renames.length, 1);
});

function captureFixture(version, { spawnError = false } = {}) {
  const capture = source(version === 'old' ? 'test-fixtures/v1/resource-capture.mjs' : 'resource-capture.mjs');
  const functions = capture.slice(capture.indexOf('async function poll('), capture.indexOf('async function databaseIdentity('));
  const startTail = capture.slice(capture.indexOf('  state = { ...context, pg, metadata, procStem, pgStem, children: [] };'), capture.indexOf("  const procRows = await poll('proc_ready'"));
  const finish = capture.slice(capture.indexOf('export async function finishResourceCapture(')).replace(/^export /, '');
  const child = new EventEmitter(); Object.assign(child, { pid: spawnError ? undefined : 321, exitCode: null, signalCode: null });
  const failure = Object.assign(new Error(spawnError ? 'synthetic_spawn_EACCES' : 'synthetic_birth_EACCES'), { code: 'EACCES' });
  const records = { listeners: null, kills: 0, saves: [], stops: [] };
  child.kill = () => { records.kills++; throw new Error('No signal allowed without birth'); };
  const baseRelease = { ...release, pythonExecutable: '/fixture/python', nodeExecutable: '/fixture/node' };
  const context = { assert, path, JSON, Date, context: { release: baseRelease, root: '/fixture/source' }, release: baseRelease,
    root: '/fixture/source', pg: { selectedPort: 55432 }, metadata: {}, procStem: '/fixture/proc', pgStem: '/fixture/sql', environment: {},
    setTimeout, clearTimeout, pause: async () => {},
    open: async () => ({ fd: 99, close: async () => {
      records.listeners = child.listenerCount('error');
      if (spawnError && records.listeners) child.emit('error', failure);
    } }),
    spawn: () => child,
    readFile: async () => { throw failure; }, parseProcIdentity: () => { throw new Error('No birth was read'); },
    lines: async () => { throw failure; },
    save: async (file, value) => records.saves.push({ file, value }),
    rename: async (temporary, target) => { records.stops.push(target); child.exitCode = 0; child.emit('close', 0, null); },
    finalizeCounterCapture: async () => { throw new Error('Must not finalize failed acquisition'); },
    verifyPgService: async () => { throw new Error('Must not verify PG after failed acquisition'); },
  };
  const api = vm.runInNewContext('let state;\n' + functions + '\n' + finish + '\nasync function startTail(){' + startTail +
    '}\n({startTail,finishResourceCapture,getState:()=>state})', context);
  return { api, records, child, failure };
}

test('RED V1 birth EACCES escapes ownership; GREEN V2 owns before await and cooperatively joins with primary error preserved', async () => {
  const old = captureFixture('old'); await assert.rejects(old.api.startTail(), error => error === old.failure);
  assert.equal(old.api.getState().children.length, 0); assert.equal(old.records.listeners, 0); assert.equal(old.child.exitCode, null);
  const current = captureFixture('new'); await assert.rejects(current.api.startTail(), error => error === current.failure);
  assert.equal(current.api.getState().children.length, 1); assert.equal(current.records.listeners, 1);
  assert.equal(current.records.stops.length, 1); assert.equal(current.child.exitCode, 0); assert.equal(current.records.kills, 0);
  await assert.rejects(current.api.finishResourceCapture(), error => error === current.failure);
  assert.equal(current.records.saves.at(-1).value.complete, false); assert.equal(current.records.saves.at(-1).value.collectors[0].exitSettled, true);
});

test('early spawn error already has listeners and an owned joined handle; no numeric PID is signalled', async () => {
  const current = captureFixture('new', { spawnError: true });
  await assert.rejects(current.api.startTail(), error => error === current.failure);
  assert.equal(current.records.listeners, 1); assert.equal(current.api.getState().children.length, 1);
  assert.equal(current.api.getState().children[0].exitSettled, true); assert.equal(current.records.kills, 0);
});

test('unjoined unknown birth and reused known birth never signal a numeric PID or become successful cleanup', async () => {
  const capture = source('resource-capture.mjs'), from = capture.indexOf('async function retireCollector('), to = capture.indexOf('async function stop(', from);
  const body = capture.slice(from, to); let signals = 0;
  const collector = { child: { kill() { signals++; } }, exitSettled: false, identity: null };
  const context = { assert, requestCollectorStop: async () => {}, awaitExit: async () => { throw new Error('synthetic_join_timeout'); },
    readFile: async () => 'synthetic-stat', parseProcIdentity: () => ({ starttimeTicks: 'replacement' }) };
  const retire = vm.runInNewContext(body + '\nretireCollector', context);
  await assert.rejects(retire(collector, release.nonce), /birth unavailable/);
  collector.identity = { pid: 321, starttimeTicks: 'original' };
  await assert.rejects(retire(collector, release.nonce), /Refuse collector PID reuse/); assert.equal(signals, 0);
});

test('direct service installs only the source-bound finite exit writer after all event windows', () => {
  const args = serviceCommand(release, ownership.dataDir, ownership.selectedPort, ownership.envFile);
  const post = args.find(value => value.startsWith('--property=ExecStopPost='));
  assert.ok(post.includes('/usr/bin/env')); assert.ok(post.includes('NODE_OPTIONS'));
  assert.ok(post.includes('pg-exit-receipt.mjs')); assert.ok(post.includes('--record-systemd-exit'));
  assert.ok(post.includes('--release-sha256=' + release.releaseSha256));
});
