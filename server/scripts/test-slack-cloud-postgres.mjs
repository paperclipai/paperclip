import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.slice(2).some(arg => arg !== '--instance-transition-only')) throw new Error('Unknown Slack fixture selector');
const transitionOnly = process.argv.includes('--instance-transition-only');
const server = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const guard = path.join(server, 'src/services/chat-channels/slack/cloud-test-prewire.cjs');
const names = ['PAPERCLIP_SLACK_TEST_DATABASE_URL', 'SLACK_EVENT_TEST_DATABASE_URL'];
const urls = names.map(name => {
  if (!process.env[name]) throw new Error(`Set ${name} to an owned dedicated PostgreSQL test database`);
  let url;
  try { url = new URL(process.env[name]); } catch { throw new Error(`${name} must name an explicit loopback *_test database`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    || !/^[a-zA-Z0-9_]+_test$/.test(decodeURIComponent(url.pathname.slice(1)))
    || ['options', 'database', 'dbname'].some(k => url.searchParams.has(k))) throw new Error(`${name} must name an explicit loopback *_test database`);
  return url;
});
if (urls[0].pathname === urls[1].pathname) throw new Error('Slack app and Cloud fixtures require distinct databases');
if (!process.env.SLACK_TEST_CLOUD_DIST || !path.isAbsolute(process.env.SLACK_TEST_CLOUD_DIST)
  || !existsSync(path.join(process.env.SLACK_TEST_CLOUD_DIST, 'connections/broker.js'))) throw new Error('SLACK_TEST_CLOUD_DIST must name the compiled companion Cloud dist directory');
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const ownedHome = mkdtempSync(path.join(tmpdir(), 'paperclip-slack-paired-'));
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME,
  LANG: process.env.LANG, TMPDIR: ownedHome, PAPERCLIP_HOME: ownedHome,
  NODE_ENV: 'test', NODE_OPTIONS: '', SLACK_GATE_EXPECT_PRELOAD: '1',
  PAPERCLIP_SLACK_TEST_DATABASE_URL: process.env.PAPERCLIP_SLACK_TEST_DATABASE_URL,
  SLACK_EVENT_TEST_DATABASE_URL: process.env.SLACK_EVENT_TEST_DATABASE_URL,
  SLACK_TEST_CLOUD_DIST: process.env.SLACK_TEST_CLOUD_DIST,
  SLACK_GATE_PROCESS_LOG: process.env.SLACK_GATE_PROCESS_LOG,
};
const child = spawn(process.execPath, ['--require', guard, vitest, 'run',
  ...(transitionOnly ? ['src/services/chat-channels/slack/cloud-instance-transition.postgres.test.ts'] :
    ['src/services/chat-channels/slack/cloud-enrollment.postgres.test.ts', 'src/services/chat-channels/slack/cloud-instance-transition.postgres.test.ts']), '--maxWorkers=1', '--no-file-parallelism', `--execArgv=--require=${guard}`],
{ cwd: server, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', (code, signal) => {
  rmSync(ownedHome, { recursive: true, force: true });
  process.exitCode = signal ? 1 : code ?? 1;
});
