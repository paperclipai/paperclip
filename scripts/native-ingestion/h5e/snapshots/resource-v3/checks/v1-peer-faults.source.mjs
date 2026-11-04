import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import path from 'node:path';
import { parseShow, unitName } from './native-ingestion-h5e-resource-tools/pg-service.mjs';

const root = '/private/tmp/native-ingestion-h5e-resource-tools';
const pgSource = await readFile(path.join(root, 'pg-service.mjs'), 'utf8');
const captureSource = await readFile(path.join(root, 'resource-capture.mjs'), 'utf8');
const out = {};
const release = { nonce: 'peer-source-only', releaseSha256: 'a'.repeat(64), output: '/fixture-only/output',
  pg: { postgresBinary: '/fixture-only/postgres', postgresSha256: 'b'.repeat(64) } };
const ownership = { unit: unitName(release.nonce), unitAbsentBefore: true, sourceReleaseSha256: release.releaseSha256,
  envFile: '/fixture-only/private-env', passwordFile: '/fixture-only/password', dataDir: '/fixture-only/db', selectedPort: 55432 };
const receipt = { pid: 123, starttimeTicks: '55', cgroupPath: '/fixture-only/cgroup', nonce: release.nonce,
  sourceReleaseSha256: release.releaseSha256, invocationId: 'c'.repeat(32) };
const showSource = pgSource.slice(pgSource.indexOf('export async function serviceState('), pgSource.indexOf('export async function verifyPgService(')).replace(/^export /, '');
const stopSource = pgSource.slice(pgSource.indexOf('export async function stopPgService(')).replace(/^export /, '');
const showKeys = vm.runInNewContext(pgSource.slice(pgSource.indexOf('const showKeys = '), pgSource.indexOf('export const unitName')) + '\nshowKeys');
let shows = 0, stops = 0, unlinks = [], processReads = [], scopeStats = [], saves = [];
const notFound = Object.assign(new Error('synthetic_systemctl_show_not_found'), {
  code: 1, stdout: `Id=${ownership.unit}\nLoadState=not-found\nActiveState=inactive\nMainPID=0\nResult=success\n` });
const context = {
  assert, path, showKeys, parseShow, unitName,
  json: async file => file.endsWith('pg-service.json') ? receipt : ownership,
  systemctl: async (_release, operation) => {
    if (operation === 'stop') { stops++; return { stdout: '' }; }
    assert.equal(operation, 'show');
    if (++shows === 1) return { stdout: `Id=${ownership.unit}\nLoadState=loaded\nActiveState=active\nMainPID=0\n` };
    throw notFound;
  },
  unlink: async file => unlinks.push(file),
  readFile: async file => { processReads.push(file); throw Object.assign(new Error('fixture_absent'), { code: 'ENOENT' }); },
  stat: async file => { scopeStats.push(file); throw Object.assign(new Error('fixture_absent'), { code: 'ENOENT' }); },
  writeFile: async (...args) => saves.push(args),
};
const stop = vm.runInNewContext(showSource + '\n' + stopSource + '\nstopPgService', context);
await assert.rejects(stop(release), error => error === notFound);
assert.equal(stops, 1); assert.equal(shows, 2); assert.equal(unlinks.length, 0);
assert.equal(processReads.length, 0); assert.equal(scopeStats.length, 0); assert.equal(saves.length, 0);
out.stoppedTransientUnitDisappears = { actualSourceFunctions: ['serviceState', 'stopPgService'],
  stopCommandSucceeded: true, postStopShowReturnedNotFound: true, cleanupRejected: true,
  privateFilesUnlinked: unlinks, independentPidChecks: processReads, scopeChecks: scopeStats,
  cleanupReceiptWritten: false, noSystemctlOrFilesystemRuntimeExecuted: true };
unlinks = []; processReads = []; scopeStats = []; saves = [];
const missingBefore = vm.runInNewContext(showSource + '\n' + stopSource + '\nstopPgService', {
  ...context, systemctl: async () => { throw notFound; },
});
const earlyAbsent = await missingBefore(release);
assert.equal(earlyAbsent.complete, true); assert.equal(earlyAbsent.unitNeverStarted, true);
assert.equal(processReads.length, 0); assert.equal(scopeStats.length, 0);
out.alreadyCollectedReadyUnit = { readyReceiptExists: true, unitAbsentAtCleanup: true,
  returnedComplete: earlyAbsent.complete, incorrectlyClassifiedNeverStarted: earlyAbsent.unitNeverStarted,
  independentPidChecks: processReads, scopeChecks: scopeStats, normalPgShutdownProven: earlyAbsent.normalPgShutdown === true };

const pollSource = captureSource.slice(captureSource.indexOf('async function poll('), captureSource.indexOf('async function launchCollector('));
const launchSource = captureSource.slice(captureSource.indexOf('async function launchCollector('), captureSource.indexOf('async function awaitExit('));
const startTail = captureSource.slice(captureSource.indexOf('  state = { ...context, pg, metadata, procStem, pgStem, children: [] };'), captureSource.indexOf("  const procRows = await poll('proc_ready'"));
const finishSource = captureSource.slice(captureSource.indexOf('export async function finishResourceCapture(')).replace(/^export /, '');
const child = new EventEmitter(); Object.assign(child, { pid: 321, exitCode: null, signalCode: null });
let spawnCount = 0, kills = 0, listenersDuringClose = null, saved = [];
child.kill = () => { kills++; return true; };
const birthFailure = Object.assign(new Error('synthetic_birth_read_denied'), { code: 'EACCES' });
const captureContext = {
  assert, path, context: { release: { nonce: release.nonce, output: release.output }, root: '/fixture-only/source' },
  release: { nonce: release.nonce, pythonExecutable: '/fixture-only/python', nodeExecutable: '/fixture-only/node', output: release.output },
  root: '/fixture-only/source', pg: { selectedPort: 55432 }, metadata: {},
  procStem: '/fixture-only/proc', pgStem: '/fixture-only/sql', environment: {},
  open: async () => ({ fd: 99, close: async () => { listenersDuringClose = child.listenerCount('error'); } }),
  spawn: () => { spawnCount++; return child; },
  readFile: async () => { throw birthFailure; },
  parseProcIdentity: () => { throw new Error('must fail before parsing'); },
  pause: async () => {},
  lines: async () => { throw birthFailure; },
  save: async (_file, value) => saved.push(value),
  finalizeCounterCapture: async () => { throw new Error('must not finalize'); },
  verifyPgService: async () => { throw new Error('must not verify PG'); },
};
const capture = vm.runInNewContext('let state;\n' + pollSource + '\n' + launchSource + '\n' +
  finishSource + '\nasync function startTail(){' + startTail + '}\n({startTail, finishResourceCapture, getState:()=>state})', captureContext);
await assert.rejects(capture.startTail(), error => error === birthFailure);
assert.equal(spawnCount, 1); assert.equal(capture.getState().children.length, 0); assert.equal(kills, 0);
await assert.rejects(capture.finishResourceCapture(), error => error === birthFailure);
assert.equal(kills, 0); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
out.collectorBirthFailure = { actualSourceFunctions: ['poll', 'launchCollector', 'startResourceCapture tail', 'finishResourceCapture'],
  childSpawned: true, birthReadRejected: 'EACCES', cleanupChildrenRegistered: capture.getState().children.length,
  cleanupKillCalls: kills, fakeChildStillLive: true, errorListenersDuringFirstPostSpawnAwait: listenersDuringClose,
  combinedReceiptComplete: saved.at(-1).complete, noProcessOrProcRuntimeExecuted: true };
await writeFile('/private/tmp/native-ingestion-h5e-resource-tools-peer-faults.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
