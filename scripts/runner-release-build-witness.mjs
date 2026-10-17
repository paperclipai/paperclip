import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readFileSync, readdirSync, realpathSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {RUNNER_PACKAGE} from './runner-release-crate-cache.mjs';

const inside = (root, file) => file === root || file.startsWith(`${root}${sep}`);
export const environmentValue = value => value === undefined ? null : createHash('sha256').update(value).digest('hex');

export function validateEnvironmentWitness(witness, env) {
  assert.ok(witness && typeof witness === 'object' && !Array.isArray(witness), 'Invalid compiler environment witness');
  assert.ok(Object.keys(witness).length <= 1024, 'Unbounded compiler environment witness');
  for (const [key, value] of Object.entries(witness)) {
    assert.match(key,/^[A-Za-z_][A-Za-z0-9_]*$/,'Invalid compiler environment key');
    assert.ok(value === null || /^[a-f0-9]{64}$/.test(value), 'Invalid compiler environment digest');
    assert.equal(environmentValue(env[key]), value, `Release compiler environment changed: ${key}`);
  }
}

export function collectBuildWitness({root, env = process.env, compilerMetadata}) {
  assert.ok(!/[\s\\:]/.test(root), 'Unsupported Cargo dep-info checkout path');
  const workspace = join(root, RUNNER_PACKAGE, 'runner');
  let metadata=compilerMetadata;
  if (!metadata) {
    try { metadata=JSON.parse(execFileSync('cargo', ['metadata', '--offline', '--locked', '--no-deps',
      '--format-version=1', '--manifest-path', join(workspace, 'Cargo.toml')], {env, encoding:'utf8', timeout:30_000, maxBuffer:4*1024*1024})); }
    catch { throw new Error('Cargo workspace metadata is unavailable'); }
  }
  assert.equal(realpathSync(metadata.workspace_root), workspace, 'Unexpected Cargo workspace');
  const crates = join(workspace, 'crates');
  const allowedInput = file => [crates, join(root,RUNNER_PACKAGE,'protocol'), join(root,RUNNER_PACKAGE,'test-fixtures'),
    join(root,RUNNER_PACKAGE,'test/fixtures'), join(root,'tests/runner-e2e/fixtures')].some(directory=>inside(directory,file));
  const entries = readdirSync(join(workspace,'target/release/deps'));
  const environment = Object.create(null);
  let depInfoFiles = 0;
  assert.ok(metadata.packages.length > 0, 'No Cargo packages');
  for (const pkg of metadata.packages) {
    const manifest = realpathSync(pkg.manifest_path), directory = dirname(manifest);
    assert.ok(inside(crates,manifest), 'Unmodeled workspace manifest');
    for (const dependency of pkg.dependencies) {
      assert.ok(!dependency.path || inside(crates, realpathSync(dependency.path)), 'Unmodeled Cargo path dependency');
      assert.ok(!dependency.source || dependency.source === 'registry+https://github.com/rust-lang/crates.io-index', 'Unmodeled dependency source');
    }
    for (const target of pkg.targets) {
      assert.ok(allowedInput(realpathSync(target.src_path)), 'Unmodeled Cargo target');
      assert.ok(!target.kind.includes('custom-build'), 'Workspace build scripts require normal Cargo validation');
      if (!target.kind.includes('lib') && target.name !== 'paperclip-runnerd') continue;
      const prefix = `${target.name.replaceAll('-','_')}-`;
      const files = entries.filter(name=>name.startsWith(prefix) && name.endsWith('.d'));
      assert.ok(files.length > 0, `Missing compiler dep-info: ${target.name}`);
      for (const name of files) {
        const file = join(workspace,'target/release/deps',name), info=lstatSync(file);
        assert.ok(info.isFile() && !info.isSymbolicLink() && info.size < 2*1024*1024, 'Invalid compiler dep-info');
        const text=readFileSync(file,'utf8'), first=text.split('\n')[0];
        assert.ok(first.includes(': ') && !first.includes('\\'), 'Unsupported compiler dep-info format');
        for (const input of first.slice(first.indexOf(': ')+2).trim().split(/\s+/)) {
          const resolved=resolve(workspace,input);
          assert.ok(allowedInput(resolved), `Unmodeled compiler input: ${relative(root,resolved)}`);
          assert.equal(realpathSync(resolved),resolved,'Compiler input must be canonical');
        }
        for (const line of text.split('\n').filter(line=>line.startsWith('# env-dep:'))) {
          const item=line.slice('# env-dep:'.length), delimiter=item.indexOf('=');
          const key=delimiter<0?item:item.slice(0,delimiter), value=delimiter<0?undefined:item.slice(delimiter+1);
          assert.match(key,/^[A-Za-z_][A-Za-z0-9_]*$/,'Invalid compiler environment input');
          assert.ok(!value?.includes('\\'), 'Unsupported escaped compiler environment input');
          if (key === 'CARGO_MANIFEST_DIR') assert.equal(value,directory,'Compiled manifest directory mismatch');
          else if (key === 'CARGO_PKG_VERSION') assert.equal(value,pkg.version,'Compiled package version mismatch');
          else {
            assert.ok(!key.startsWith('CARGO_'),'Unmodeled Cargo-managed compiler input');
            assert.ok(value===env[key],`Compiler environment mismatch: ${key}`);
            environment[key]=environmentValue(value);
          }
        }
        depInfoFiles++;
      }
    }
  }
  let buildScripts = 0;
  const buildRoot=join(workspace,'target/release/build');
  if (existsSync(buildRoot)) {
    for (const name of readdirSync(buildRoot)) {
      const output=join(buildRoot,name,'output');
      if (!existsSync(output)) continue;
      assert.equal(realpathSync(output),output,'Build-script evidence must be canonical');
      const info=lstatSync(output);
      assert.ok(info.isFile() && info.size <= 1024*1024,'Invalid build-script evidence');
      for (const line of readFileSync(output,'utf8').split('\n')) {
        const match=/^cargo::?rerun-if-env-changed=([A-Za-z_][A-Za-z0-9_]*)$/.exec(line);
        if (match) environment[match[1]]=environmentValue(env[match[1]]);
      }
      buildScripts++;
    }
  }
  validateEnvironmentWitness(environment,env);
  return {environment,depInfoFiles,buildScripts};
}
