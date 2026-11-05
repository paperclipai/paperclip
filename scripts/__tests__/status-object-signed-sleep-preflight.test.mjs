import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const launcher = path.join(root, 'scripts/test-status-object-signed-sleep.mjs');
const boundarySource = `
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { appendFileSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
require('node:net').Socket.prototype.connect = function() {
  appendFileSync(process.env.PREFLIGHT_NETWORK_RECEIPT, 'blocked\\n');
  process.exitCode = 98;
  throw new Error('Preflight controls forbid all sockets');
};
require('node:child_process').spawn = function(command, args, options) {
  assert.equal(command, process.execPath);
  assert(args.includes('server/src/__tests__/status-object-signed-sleep-acceptance.test.ts'));
  assert(args.includes('--maxWorkers=1'));
  assert(args.includes('--no-file-parallelism'));
  assert.equal(options.cwd, process.env.PREFLIGHT_EXPECTED_ROOT);
  appendFileSync(process.env.PREFLIGHT_SPAWN_RECEIPT, 'vitest-boundary\\n');
  const child = new EventEmitter();
  child.kill = () => false;
  queueMicrotask(() => child.emit('close', 0, null));
  return child;
};
syncBuiltinESMExports();
`;

function fixture(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'status-owner-preflight-'));
  const evidence = path.join(directory, 'evidence'), cloud = path.join(directory, 'cloud');
  mkdirSync(evidence);
  mkdirSync(path.join(cloud, 'dist/sleep/fixtures'), { recursive: true });
  writeFileSync(path.join(cloud, 'dist/sleep/fixtures/default-cadence-bridge.js'), '');
  const preload = path.join(directory, 'boundary.cjs'), log = path.join(directory, 'guard.jsonl');
  const spawnReceipt = path.join(directory, 'spawn.txt'), networkReceipt = path.join(directory, 'network.txt');
  writeFileSync(preload, boundarySource);
  writeFileSync(log, '');
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PREFLIGHT_EXPECTED_ROOT: root, PREFLIGHT_SPAWN_RECEIPT: spawnReceipt, PREFLIGHT_NETWORK_RECEIPT: networkReceipt,
    PAPERCLIP_SKILL_DEFAULT_CADENCE_TEST_DATABASE_URL: 'postgres://paperclip@127.0.0.1:55448/owner_preflight_app_test',
    PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_TEST_DATABASE_URL: 'postgres://paperclip@127.0.0.1:55448/owner_preflight_cloud_test',
    PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_CHECKOUT: cloud, PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_NODE: process.execPath,
    PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_SHA: '0'.repeat(40),
    PAPERCLIP_SKILL_DEFAULT_CADENCE_EVIDENCE: evidence, PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG: log,
  };
  const execute = () => {
    const result = spawnSync(process.execPath, ['--require', preload, launcher, '--owner=status', '--stage=identity'], {
      cwd: root, env, encoding: 'utf8', timeout: 10_000,
    });
    console.log(JSON.stringify({ event: 'launcher-preflight-child', pid: result.pid, status: result.status,
      spawnEntered: existsSync(spawnReceipt), socketAttempted: existsSync(networkReceipt),
      guardEvents: existsSync(env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG)
        ? readFileSync(env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] }));
    assert.equal(result.error, undefined);
    assert(!existsSync(networkReceipt), 'No socket may be entered during preflight controls');
    return result;
  };
  try { run({ evidence, directory, log, env, execute, spawnReceipt }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function refused(context, message) {
  const result = context.execute();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
  assert(!existsSync(context.spawnReceipt), 'Refusal must precede the Vitest spawn boundary');
  assert.equal(readFileSync(context.log, 'utf8'), '', 'Refusal must precede guard installation');
}

test('fresh evidence reaches the actual launcher Vitest boundary without transport', () => fixture(context => {
  const result = context.execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(context.spawnReceipt, 'utf8'), 'vitest-boundary\n');
}));

test('fresh evidence may contain only its explicit empty regular guard log', () => fixture(context => {
  const log = path.join(context.evidence, 'guard.jsonl');
  writeFileSync(log, '');
  context.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG = log;
  const result = context.execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(context.spawnReceipt, 'utf8'), 'vitest-boundary\n');
}));

for (const name of ['status-provider-state.json', 'status-provider-state.json.runs.jsonl',
  'status-provider-state.json.pending', 'status-provider-state.json.api-origin', 'other-evidence.json']) {
  test(`rejects existing ${name} before guard or spawn and preserves its bytes`, () => fixture(context => {
    const file = path.join(context.evidence, name), prior = 'retained evidence\n';
    writeFileSync(file, prior);
    refused(context, /requires a fresh evidence directory/);
    assert.equal(readFileSync(file, 'utf8'), prior);
  }));
}

test('rejects a symlink evidence directory before guard or spawn', () => fixture(context => {
  const link = path.join(context.directory, 'evidence-link');
  symlinkSync(context.evidence, link);
  context.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_EVIDENCE = link;
  refused(context, /evidence directory without a symlink/);
  assert(lstatSync(link).isSymbolicLink());
}));

test('rejects a symlink guard log without writing its target', () => fixture(context => {
  const link = path.join(context.evidence, 'guard-link.jsonl');
  symlinkSync(context.log, link);
  context.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG = link;
  refused(context, /fresh absolute guard log/);
  assert(lstatSync(link).isSymbolicLink());
}));
