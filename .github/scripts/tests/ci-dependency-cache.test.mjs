import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { cachePlan } from "../../../scripts/ci-dependency-cache.mjs";

const entries = {
  "package.json": '{"scripts":{"postinstall":"node scripts/link-plugin-dev-sdk.mjs"}}',
  "server/package.json": '{"dependencies":{"external":"1.0.0"}}',
  "packages/shared/package.json": '{}',
  "packages/plugins/sdk/package.json": '{}',
  "pnpm-lock.yaml": 'lockfile',
  "pnpm-workspace.yaml": 'workspace',
  ".npmrc": 'auto-install-peers=false',
  "patches/external.patch": 'patch',
  "scripts/link-plugin-dev-sdk.mjs": 'postinstall',
  "scripts/ci-dependency-cache.mjs": 'cache schema',
  "scripts/ensure-plugin-build-deps.mjs": 'build verifier',
  "tsconfig.base.json": '{}',
  "packages/shared/src/index.ts": 'shared API',
  "packages/plugins/sdk/src/index.ts": 'SDK API',
  "server/src/server.ts": 'server',
};
const scope = { node: 'v24.19.0', root: '/work/paperclip', arch: 'x64', libc: '2.39', pnpm: '9.15.4', store: '/store' };
const plan = (files = entries, runtime = scope) => cachePlan({
  files: Object.keys(files), read: (file) => files[file] === null ? null : Buffer.from(files[file]), scope: runtime,
  packageDirs: ['.', 'packages/plugins/sdk', 'packages/shared', 'server'],
});

test('dependency identity includes manifests, resolution, patches, installer and runtime boundaries', () => {
  const original = plan();
  for (const file of Object.keys(entries).filter((file) =>
    /package\.json$/.test(file) || /^(pnpm-|\.npmrc|patches\/|scripts\/(link-plugin-dev-sdk|ci-dependency-cache))/.test(file))) {
    for (const value of [file.endsWith('package.json') ? '{"changed":true}' : 'changed', null]) {
      const changed = plan({ ...entries, [file]: value });
      assert.notEqual(changed.dependencyKey, original.dependencyKey, file);
      assert.notEqual(changed.buildKey, original.buildKey, file);
    }
  }
  assert.notEqual(plan({ ...entries, 'packages/new/package.json': '{}' }).dependencyKey, original.dependencyKey);
  for (const key of Object.keys(scope)) {
    assert.notEqual(plan(entries, { ...scope, [key]: 'different' }).dependencyKey, original.dependencyKey, key);
  }
});

test('shared and SDK source changes invalidate dependent builds without reinstalling packages', () => {
  const original = plan();
  for (const file of ['packages/shared/src/index.ts', 'packages/plugins/sdk/src/index.ts',
    'tsconfig.base.json']) {
    const changed = plan({ ...entries, [file]: 'changed' });
    assert.equal(changed.dependencyKey, original.dependencyKey, file);
    assert.notEqual(changed.buildKey, original.buildKey, file);
  }
  assert.deepEqual(plan({ ...entries, 'server/src/server.ts': 'different' }), original);
  assert.deepEqual(plan(Object.fromEntries(Object.entries(entries).reverse())), original);
  assert.deepEqual(original.dependencyPaths, ['node_modules', 'packages/plugins/sdk/node_modules',
    'packages/shared/node_modules', 'server/node_modules']);
  assert.deepEqual(plan({ ...entries, 'tests/fixtures/app/package.json': '{}' }).dependencyPaths, original.dependencyPaths);
  for (const directory of ['/outside', '../outside', 'server/../../outside']) {
    assert.throws(() => cachePlan({ files: [], read: () => null, scope, packageDirs: [directory] }));
  }
});

test('unmodelled workspace lifecycle scripts disable materialized reuse', () => {
  assert.equal(plan().cacheable, true);
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(plan({ ...entries, 'server/package.json': JSON.stringify({ scripts: { [hook]: 'node custom.mjs' } }) }).cacheable, false);
  }
  assert.equal(plan({ ...entries, 'package.json': '{"scripts":{"postinstall":"node other.mjs"}}' }).cacheable, false);
  for (const file of ['scripts/ensure-plugin-build-deps.mjs', 'scripts/new-install-helper.mjs', '.pnpmfile.cjs']) {
    assert.notEqual(plan({ ...entries, [file]: 'changed' }).dependencyKey, plan().dependencyKey);
  }
});

test('cache restores are exact and only a frozen canonical master push can publish entries', () => {
  const action = readFileSync(new URL('../../actions/setup-ci-dependencies/action.yml', import.meta.url), 'utf8');
  const installed = action.slice(action.indexOf('    - name: Restore installed'), action.indexOf('    - name: Locate pnpm'));
  const builds = action.slice(action.indexOf('    - name: Restore certified'), action.indexOf('    - name: Validate workspace'));
  for (const restore of [installed, builds]) assert.doesNotMatch(restore, /restore-keys:/);
  for (const step of action.split('    - name: Save ').slice(1)) {
    assert.match(step, /inputs\.save-cache == 'true'/);
    assert.match(step, /github\.repository == 'paperclipai\/paperclip'/);
    assert.match(step, /github\.event_name == 'push'/);
    assert.match(step, /github\.ref == 'refs\/heads\/master'/);
    assert.match(step, /steps\.install\.outputs\.frozen == 'true'/);
  }
  const workflow = readFileSync(new URL('../../workflows/release-verify.yml', import.meta.url), 'utf8');
  assert.match(workflow, /save-cache: .*inputs\.ref == github\.sha/);
});
