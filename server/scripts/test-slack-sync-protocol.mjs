import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const guard = path.join(server, 'src/__tests__/helpers/slack-cloud/prewire.cjs');
const args = process.argv.slice(2);
if (args.length > 1 || args.length === 1 && !['--warm-only', '--action-delayed-only'].includes(args[0])) throw new Error('Use --warm-only, --action-delayed-only or no arguments');
const mode = args[0] === '--warm-only' ? 'warm' : 'action-delayed';
const testNamePattern = args.length === 1
  ? `captures signed Slack forwarding protocol with registered owners \\(${mode}\\)$`
  : 'captures signed Slack forwarding protocol with registered owners';
const names = ['PAPERCLIP_SLACK_TEST_DATABASE_URL'];
for (const name of names) {
  if (!process.env[name]) throw new Error(`Set ${name} to an owned dedicated PostgreSQL test database`);
  let url;
  try { url = new URL(process.env[name]); } catch { throw new Error(`${name} must name an explicit loopback *_test database`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    || !/^[a-zA-Z0-9_]+_test$/.test(decodeURIComponent(url.pathname.slice(1)))
    || ['options', 'database', 'dbname'].some(k => url.searchParams.has(k))) throw new Error(`${name} must name an explicit loopback *_test database`);
}
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const ownedHome = mkdtempSync(path.join(tmpdir(), 'paperclip-slack-protocol-'));
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME,
  LANG: process.env.LANG, TMPDIR: ownedHome, PAPERCLIP_HOME: ownedHome,
  NODE_ENV: 'test', NODE_OPTIONS: '', SLACK_GATE_EXPECT_PRELOAD: '1',
  PAPERCLIP_SLACK_TEST_DATABASE_URL: process.env.PAPERCLIP_SLACK_TEST_DATABASE_URL,
  PAPERCLIP_SLACK_PROTOCOL_CAPTURE: '1',
  SLACK_GATE_PROCESS_LOG: process.env.SLACK_GATE_PROCESS_LOG,
};
const child = spawn(process.execPath, ['--require', guard, vitest, 'run',
  'src/__tests__/chat-channels.integration.test.ts', '--testNamePattern', testNamePattern, '--maxWorkers=1', '--no-file-parallelism', `--execArgv=--require=${guard}`],
{ cwd: server, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', (code, signal) => {
  rmSync(ownedHome, { recursive: true, force: true });
  process.exitCode = signal ? 1 : code ?? 1;
});
