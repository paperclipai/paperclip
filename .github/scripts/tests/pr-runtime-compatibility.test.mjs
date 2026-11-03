import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/pr-trusted.yml', 'utf8');
const step = workflow.match(/      - name: Boot the production runtime(?: bundle)?\n        run: \|\n((?:          .*\n|\n)+)/)?.[1];
const legacyCommand = ['node', '--import', './server/node_modules/tsx/dist/loader.mjs', 'server/dist/index.js'];

function runSmoke(t, { runtime = false, script = true, dockerCommand = legacyCommand, dockerCommands = null, buildExit = 0, smokeExit = 0, built = true, manifest } = {}) {
  assert.ok(step, 'the reusable workflow must contain a source-compatible production runtime smoke');
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'ci-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content, executable = false) => {
    const fullPath = join(root, path);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content, { mode: executable ? 0o755 : 0o644 });
  };
  write('server/package.json', manifest ?? JSON.stringify({ scripts: runtime ? { 'build:runtime': 'bundle' } : {} }));
  const commands = dockerCommands ?? [dockerCommand];
  write('Dockerfile', `FROM node:24\n${commands.map((cmd) => `CMD ${JSON.stringify(cmd)}`).join('\n')}\n`);
  write('bin/pnpm', '#!/bin/sh\nprintf "build:%s\\n" "$*" >> "$CALL_LOG"\nexit "$BUILD_EXIT"\n', true);
  const harness = (source) => `#!/bin/sh\nprintf "smoke:${source}:%s\\n" "$*" >> "$CALL_LOG"\nexit "$SMOKE_EXIT"\n`;
  if (script) write('scripts/server-boot-smoke.sh', harness('source'), true);
  else write('.ci-boot-smoke/scripts/server-boot-smoke.sh', harness('trusted'), true);
  if (built) {
    write('server/node_modules/tsx/dist/loader.mjs', '');
    write('server/dist/index.js', '');
  }
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.replace(/^          /gm, '')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      // Exercise only the fixture commands, not the invoking agent's shell hooks.
      HOME: root,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      GITHUB_WORKSPACE: root,
      CALL_LOG: join(root, 'calls'),
      BUILD_EXIT: String(buildExit),
      SMOKE_EXIT: String(smokeExit),
    },
    timeout: 5000,
  });
  let calls = '';
  try { calls = readFileSync(join(root, 'calls'), 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { ...result, calls, root };
}

test('bundled source retains the runtime build and bundle smoke', (t) => {
  const result = runSmoke(t, { runtime: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, 'build:--filter @paperclipai/server build:runtime\nsmoke:source:node server/dist-runtime/index.mjs\n');
});

test('a declared runtime build failure never falls back to the legacy entrypoint', (t) => {
  const result = runSmoke(t, { runtime: true, buildExit: 23 });
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.calls, 'build:--filter @paperclipai/server build:runtime\n');
});

test('a bundle smoke failure remains a failure', (t) => {
  const result = runSmoke(t, { runtime: true, smokeExit: 24 });
  assert.equal(result.status, 24, result.stderr);
});

test('a declared bundled runtime with a missing source harness fails closed', (t) => {
  const result = runSmoke(t, { runtime: true, script: false });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /smoke:/);
});

for (const script of [true, false]) {
  test(`recognized legacy source boots its Dockerfile entrypoint with ${script ? 'source' : 'trusted'} harness`, (t) => {
    const result = runSmoke(t, { script });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, `smoke:${script ? 'source' : 'trusted'}:node --import ${result.root}/server/node_modules/tsx/dist/loader.mjs ${result.root}/server/dist/index.js\n`);
  });
}

test('legacy health smoke failures remain failures', (t) => {
  const result = runSmoke(t, { script: false, smokeExit: 25 });
  assert.equal(result.status, 25, result.stderr);
});

test('unknown Dockerfile commands cannot silently select legacy boot', (t) => {
  const result = runSmoke(t, { dockerCommand: ['node', 'different.js'] });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls, '');
});

for (const order of ['recognized-first', 'recognized-second']) {
  test(`multiple Dockerfile CMD lines cannot silently select legacy boot (${order})`, (t) => {
    const other = ['node', 'different-prod.js'];
    const result = runSmoke(t, {
      dockerCommands: order === 'recognized-first' ? [legacyCommand, other] : [other, legacyCommand],
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, '');
  });
}

test('missing legacy build output cannot pass a smoke', (t) => {
  const result = runSmoke(t, { built: false });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls, '');
});

test('malformed source manifest cannot select legacy boot', (t) => {
  const result = runSmoke(t, { manifest: '{' });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls, '');
});

test('a present but invalid runtime declaration does not select legacy boot', (t) => {
  const result = runSmoke(t, { manifest: JSON.stringify({ scripts: { 'build:runtime': null } }), buildExit: 26 });
  assert.equal(result.status, 26, result.stderr);
  assert.equal(result.calls, 'build:--filter @paperclipai/server build:runtime\n');
});

test('trusted harness checkout precedes production runtime boot', () => {
  const checkoutIndex = workflow.indexOf('      - name: Checkout the trusted boot smoke harness\n');
  const bootIndex = workflow.indexOf('      - name: Boot the production runtime\n');
  assert.ok(checkoutIndex >= 0, 'the trusted harness checkout must exist');
  assert.ok(bootIndex > checkoutIndex, 'check out the trusted harness before booting a source without one');
});

test('legacy harness is from an immutable trusted checkout without persisted credentials', () => {
  const checkout = workflow.match(/name: Checkout the trusted boot smoke harness\n([\s\S]*?)\n      - name:/)?.[1];
  assert.match(checkout ?? '', /if:.*hashFiles\('scripts\/server-boot-smoke.sh'\) == ''/);
  assert.match(checkout ?? '', /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(checkout, /repository: paperclipai\/paperclip/);
  assert.match(checkout, /ref: d20cb69ce5b1cdde08eea36c5a4badc72e3d7326/);
  assert.match(checkout, /persist-credentials: false/);
  assert.match(checkout, /sparse-checkout: scripts\/server-boot-smoke.sh/);
  assert.match(checkout, /path: .ci-boot-smoke/);
});
