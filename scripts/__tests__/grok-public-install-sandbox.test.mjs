import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { GROK_PUBLIC_INSTALL_IMAGE, GROK_PUBLIC_INSTALL_LIFECYCLE, grokConsumerDockerArgs } from '../grok-public-install-sandbox.mjs';

const paths = { assets: '/private/staging/assets', consumer: '/private/staging/consumer', cache: '/private/staging/cache', uid: 1001, gid: 1001 };
const values = (args, flag) => args.flatMap((value, index) => value === flag ? [args[index + 1]] : []);

test('lifecycle execution has no network, host credentials, checkout, or elevated privileges', () => {
  const args = grokConsumerDockerArgs({ ...paths, command: GROK_PUBLIC_INSTALL_LIFECYCLE });
  assert.deepEqual(values(args, '--network'), ['none']);
  assert.deepEqual(values(args, '--user'), ['1001:1001']);
  assert.ok(args.includes('--read-only'));
  assert.deepEqual(values(args, '--cap-drop'), ['ALL']);
  assert.deepEqual(values(args, '--security-opt'), ['no-new-privileges']);
  assert.deepEqual(values(args, '--mount'), [
    'type=bind,src=/private/staging/assets,dst=/packages,readonly',
    'type=bind,src=/private/staging/consumer,dst=/consumer',
    'type=bind,src=/private/staging/cache,dst=/cache',
  ]);
  assert.deepEqual(values(args, '--env'), ['HOME=/tmp', 'npm_config_cache=/cache', 'npm_config_nodedir=/usr/local', 'npm_config_audit=false', 'npm_config_fund=false', 'npm_config_ignore_scripts=false']);
  assert.match(GROK_PUBLIC_INSTALL_IMAGE, /@sha256:[a-f0-9]{64}$/);
});

test('deferred lifecycle execution rebuilds the installed graph without dependency resolution', () => {
  assert.deepEqual(GROK_PUBLIC_INSTALL_LIFECYCLE, ['npm', 'rebuild', '--offline', '--ignore-scripts=false', '--dangerously-allow-all-scripts']);
});

test('a root or malformed host identity cannot run lifecycle scripts', () => {
  for (const uid of [0, -1, undefined, '1001']) {
    assert.throws(() => grokConsumerDockerArgs({ ...paths, uid, command: ['npm', 'ci'] }), /unprivileged/);
  }
});

test('only the scripts-disabled dependency download gets network access', () => {
  const args = grokConsumerDockerArgs({ ...paths, download: true, command: ['npm', 'install', '--ignore-scripts'] });
  assert.deepEqual(values(args, '--network'), ['bridge']);
  assert.ok(values(args, '--env').includes('npm_config_ignore_scripts=true'));
});

test('the separately provisioned executable is exposed read-only to the offline probe', () => {
  const prerequisite = '/private/staging/native/grok';
  const args = grokConsumerDockerArgs({ ...paths, prerequisite, command: ['node', '/packages/probe.mjs', 'present'] });
  assert.deepEqual(values(args, '--network'), ['none']);
  assert.equal(values(args, '--mount').at(-1), `type=bind,src=${prerequisite},dst=/opt/paperclip/providers/grok/1.0.13/grok,readonly`);
});

test('verification never elevates PR-controlled provisioning or cleanup on the host', () => {
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bsudo\b/);
  assert.ok(source.includes("const prerequisite = join(root, 'native/grok')"));
});
