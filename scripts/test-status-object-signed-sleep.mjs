import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || !/^--owner=(status|object)$/.test(args[0]) || !/^--stage=(bootstrap|cycle|identity)$/.test(args[1])) {
  throw new Error('Use --owner=status|object --stage=bootstrap|cycle, or --owner=status --stage=identity');
}
if (args[1] === '--stage=identity' && args[0] !== '--owner=status') throw new Error('Identity control requires the status owner');
const diagnostic = process.env.PAPERCLIP_STATUS_OBJECT_SLEEP_DIAGNOSTIC;
const diagnosticOwner = args[0] === '--owner=object' && args[1] === '--stage=bootstrap'
  || args[0] === '--owner=status' && args[1] === '--stage=identity';
if (diagnostic !== undefined && (diagnostic !== '1' || !diagnosticOwner)) {
  throw new Error('Diagnostic capture requires object bootstrap or status identity and the explicit value 1');
}
if (!process.version.startsWith('v24.')) throw new Error('Use the actual Node24 executable');
if (process.env.PAPERCLIP_MAINTENANCE_PG0_CONTROLS) throw new Error('PG0 flag is forbidden for signed owner acceptance');
const names = ['PAPERCLIP_SKILL_DEFAULT_CADENCE_TEST_DATABASE_URL', 'PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_TEST_DATABASE_URL'];
const urls = names.map(name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} requires an explicit dedicated database`);
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '55448'
    || !/^[a-zA-Z0-9_]+_test$/.test(decodeURIComponent(url.pathname.slice(1))) || url.search || url.hash) {
    throw new Error(`${name} requires the exact owned loopback database without overrides`);
  }
  return url;
});
if (urls[0].pathname === urls[1].pathname) throw new Error('App and Cloud fixtures must differ');
if (process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL) {
  const admin = new URL(process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL);
  if (!['postgres:', 'postgresql:'].includes(admin.protocol) || admin.hostname !== '127.0.0.1' || admin.port !== '55448'
    || admin.pathname !== '/postgres' || admin.search || admin.hash) throw new Error('Admin URL must be the same loopback55448/postgres cluster');
}
const cloud = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_CHECKOUT;
if (!cloud || !path.isAbsolute(cloud) || !existsSync(path.join(cloud, 'dist/sleep/fixtures/default-cadence-bridge.js'))) throw new Error('Set exact compiled Cloud checkout');
if (!path.isAbsolute(process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_NODE || '')) throw new Error('Set exact Node22 executable');
if (!/^[a-f0-9]{40}$/.test(process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_SHA || '')) throw new Error('Set exact Cloud source SHA');
const evidence = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_EVIDENCE;
if (!evidence || !path.isAbsolute(evidence) || !existsSync(evidence)) throw new Error('Set an existing absolute evidence directory');
const log = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG;
if (!log || !path.isAbsolute(log) || !existsSync(path.dirname(log)) || existsSync(log) && statSync(log).size !== 0) throw new Error('Set a fresh absolute guard log');
const require = createRequire(new URL('../server/package.json', import.meta.url));
const guard = path.join(root, 'scripts/fixtures/skill-default-cadence-network-guard.cjs');
delete process.env.DATABASE_URL;
delete process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_ORIGINS;
require(guard);
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR,
  NODE_ENV: 'test', NODE_OPTIONS: `--require=${guard}`, PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG: log,
  PAPERCLIP_STATUS_OBJECT_SLEEP_ACCEPTANCE: '1', PAPERCLIP_STATUS_OBJECT_SLEEP_OWNER: args[0].slice(8),
  PAPERCLIP_STATUS_OBJECT_SLEEP_STAGE: args[1].slice(8), PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS: '1' };
for (const name of [...names, 'PAPERCLIP_STATUS_OBJECT_SLEEP_DIAGNOSTIC', 'PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_CHECKOUT', 'PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_NODE',
  'PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_SHA', 'PAPERCLIP_SKILL_DEFAULT_CADENCE_EVIDENCE', 'PAPERCLIP_TEST_POSTGRES_ADMIN_URL']) {
  if (process.env[name]) env[name] = process.env[name];
}
const child = spawn(process.execPath, ['--require', guard, vitest, 'run', 'server/src/__tests__/status-object-signed-sleep-acceptance.test.ts',
  '--maxWorkers=1', '--no-file-parallelism', `--execArgv=--require=${guard}`], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('close', (code, signal) => {
  const events = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  process.exitCode = events.some(event => event.event === 'blocked' || event.unexpectedAttempts?.length) ? 98 : signal ? 1 : code ?? 1;
});
