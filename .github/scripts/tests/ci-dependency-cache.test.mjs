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

test('known Copilot hooks permit caching, track their helpers, and still run on restore', () => {
  const files = { ...entries,
    'server/package.json': JSON.stringify({ scripts: { postinstall: 'node scripts/install-copilot-assets.mjs' } }),
    'packages/paperclip-runner/package.json': JSON.stringify({ scripts: { postinstall: 'node scripts/install-copilot-assets.mjs' } }),
    'server/scripts/install-copilot-assets.mjs': 'server bootstrap',
    'packages/paperclip-runner/scripts/install-copilot-assets.mjs': 'runner bootstrap',
    'packages/paperclip-runner/scripts/materialize-copilot-binary.mjs': 'native materializer',
    'packages/paperclip-runner/scripts/copilot-inner-distribution.mjs': 'closure pins',
  };
  const compute = (input) => cachePlan({ files: Object.keys(input),
    read: file => input[file] == null ? null : Buffer.from(input[file]), scope,
    packageDirs: ['.', 'server', 'packages/paperclip-runner'],
  });
  const original = compute(files);
  assert.equal(original.cacheable, true);
  for (const file of Object.keys(files).filter(file => /^(server|packages\/paperclip-runner)\/scripts\//.test(file))) {
    for (const replacement of ['changed', null]) {
      assert.notEqual(compute({ ...files, [file]: replacement }).dependencyKey, original.dependencyKey, file);
    }
  }
  assert.equal(cachePlan({ files: ['elsewhere/package.json'],
    read: () => Buffer.from(files['server/package.json']), scope, packageDirs: ['elsewhere'],
  }).cacheable, false, 'the command is allowed only in its reviewed owners');
  const action = readFileSync(new URL('../../actions/setup-ci-dependencies/action.yml', import.meta.url), 'utf8');
  const replay = action.split('    - name: Replay workspace install hooks after restore')[1].split('    - name:')[0];
  assert.match(replay, /if: steps\.installed\.outputs\.cache-hit == 'true'/);
  assert.match(replay, /pnpm -r --if-present run postinstall\s+pnpm run postinstall/);
  assert.ok(action.indexOf('Replay workspace install hooks') < action.indexOf('Validate workspace links'));
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


test('paired test timings remain available when lifecycle hooks disable materialized caching', () => {
  const workflow = readFileSync(new URL('../../workflows/ci-work-benchmark.yml', import.meta.url), 'utf8');
  const step = name => workflow.split(`      - name: ${name}\n`)[1].split('      - name:')[0];
  for (const name of ['Save PR-scoped qualification dependencies', 'Save PR-scoped qualification builds',
    'Remove materialized outputs before restore', 'Qualify a real warm restore',
    'Verify exact cache hits and record setup comparison']) {
    assert.match(step(name), /if: steps.qualification.outputs.cacheable == 'true'/);
  }
  assert.match(step('Explain disabled materialized reuse'), /cacheable != 'true'/);
  for (const name of ['Prepare unchanged baseline', 'Compare complete commands and executed case inventories']) {
    assert.match(step(name), /if: steps\.test_scope\.outputs\.run == 'true'/);
    assert.doesNotMatch(step(name), /if:.*cacheable/);
  }
  const scope = step('Select changed server test work');
  assert.match(scope, /git diff --name-only HEAD\^1 HEAD --/);
  for (const file of ['scripts/benchmark-ci-work.mjs', 'scripts/run-vitest-stable.mjs',
    'server/src/__tests__/setup-supertest.ts', 'server/src/__tests__/workspace-runtime.test.ts',
    'server/src/services/workspace-git-snapshot-streaming.test.ts']) assert.ok(scope.includes(file));
  assert.doesNotMatch(scope, /scripts\/ci-dependency-cache|\.github\/actions\/setup-ci-dependencies/);
  assert.match(step('Exercise restored dependencies for cache-only changes'), /pnpm exec vitest run --project @paperclipai\/shared/);
});
