import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const controls = process.argv.slice(2).join(' ') === '--controls';
if (!controls && process.argv.length > 2) throw new Error('Use no arguments for the witness or --controls for finite PG0 controls');
const names = ['PAPERCLIP_SKILL_DEFAULT_CADENCE_TEST_DATABASE_URL', 'PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_TEST_DATABASE_URL'];
if (!controls && process.env.PAPERCLIP_MAINTENANCE_PG0_CONTROLS) throw new Error('PG0 controls flag is forbidden for the witness');
if (!controls) {
  const urls = names.map(name => {
    if (!process.env[name]) throw new Error(`${name} requires an explicit dedicated test database`);
    let url; try { url = new URL(process.env[name]); } catch { throw new Error(`${name} requires a loopback dedicated test database`); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
      || !/^[a-zA-Z0-9_]+_test$/.test(decodeURIComponent(url.pathname.slice(1)))
      || ['options', 'dbname', 'database'].some(key => url.searchParams.has(key))) throw new Error(`${name} requires a loopback dedicated test database`);
    return url;
  });
  if (urls[0].pathname === urls[1].pathname) throw new Error('App and Cloud require distinct test databases');
  const cloud = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_CHECKOUT;
  if (!cloud || !path.isAbsolute(cloud) || !existsSync(path.join(cloud, 'dist/sleep/fixtures/default-cadence-bridge.js'))) throw new Error('Set the exact compiled Cloud checkout');
  if (!path.isAbsolute(process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_NODE || '')) throw new Error('Set the actual Node22 executable');
  if (!/^[a-f0-9]{40}$/.test(process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_SHA || '')) throw new Error('Set exact Cloud source SHA');
}
const log = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG;
if (!log || !path.isAbsolute(log) || !existsSync(path.dirname(log))) throw new Error('Set an absolute guard log in the existing evidence directory');
if (existsSync(log) && statSync(log).size !== 0) throw new Error('Use a fresh per-attempt guard log');
if (!process.version.startsWith('v24.')) throw new Error('Launch acceptance with the actual Node24 executable');
const require = createRequire(new URL('../server/package.json', import.meta.url));
const guard = path.join(root, 'scripts/fixtures/skill-default-cadence-network-guard.cjs');


require(guard);
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR,
  NODE_ENV: 'test', NODE_OPTIONS: `--require=${guard}`, PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG: log };
if (controls) env.PAPERCLIP_MAINTENANCE_PG0_CONTROLS = '1';
if (!controls) {
  for (const name of [...names, 'PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_CHECKOUT', 'PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_NODE',
    'PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_SHA', 'PAPERCLIP_SKILL_DEFAULT_CADENCE_EVIDENCE', 'PAPERCLIP_SKILL_DEFAULT_CADENCE_STAGE',
    'PAPERCLIP_TEST_POSTGRES_ADMIN_URL']) if (process.env[name]) env[name] = process.env[name];
  env.PAPERCLIP_SKILL_DEFAULT_CADENCE_ACCEPTANCE = '1'; env.PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS = '1';
}
const files = controls ? ['server/src/__tests__/skill-default-cadence-prewire.test.ts', 'server/src/__tests__/maintenance-harness-resources.test.ts',
  'server/src/__tests__/maintenance-postgres-proxy.test.ts', 'server/src/services/skill-source-idle-schedule.test.ts']
  : ['server/src/__tests__/skill-source-default-cadence-acceptance.test.ts'];
const child = spawn(process.execPath, ['--require', guard, vitest, 'run', ...files,
  '--maxWorkers=1', '--no-file-parallelism', ...(controls ? ['--testNamePattern=^(?!.*maintenance observer against PostgreSQL)'] : []), `--execArgv=--require=${guard}`], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('close', (code, signal) => {
  const events = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const violation = events.some(event => event.event === 'blocked' || event.unexpectedAttempts?.length);
  if (violation) console.error('Default cadence guard recorded an unexpected attempt; caught exceptions do not qualify');
  process.exitCode = violation ? 98 : signal ? 1 : code ?? 1;
});
