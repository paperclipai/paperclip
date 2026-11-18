import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { githubLauncherSource } from './github-launcher.ts';

const win = { skip: process.platform !== 'win32' };
function fixture(t, name = 'gh') {
  const root = mkdtempSync(path.join(tmpdir(), 'pc-win-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const managed = path.join(root, 'managed'); mkdirSync(managed);
  const launcher = path.join(managed, name); writeFileSync(launcher, githubLauncherSource());
  return { root, managed, launcher };
}
function run(launcher, args, env) {
  return spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PAPERCLIP_GITHUB_OPERATION_ACTIVE: '', PAPERCLIP_GITHUB_BROKER_TOKEN: '', PAPERCLIP_GITHUB_BROKER_URL: '', ...env } });
}
for (const name of ['git', 'gh']) test(`executes real ${name}.exe`, win, t => {
  const f = fixture(t, name);
  const binary = execFileSync('where.exe', [name + '.exe'], { encoding: 'utf8' }).split(/\r?\n/)[0];
  const result = run(f.launcher, ['--version'], { PATH: `${f.managed};${path.dirname(binary)}`, PATHEXT: '.EXE', GH_CONFIG_DIR: f.root });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout.toLowerCase(), new RegExp(name));
});
test('PATH precedence, extension precedence, isolation and recursion guard', win, t => {
  const f = fixture(t); const first = path.join(f.root, 'first'); const second = path.join(f.root, 'second'); mkdirSync(first); mkdirSync(second);
  copyFileSync(process.execPath, path.join(first, 'gh.exe'));
  copyFileSync(process.execPath, path.join(second, 'gh.exe'));
  const probe = path.join(f.root, 'probe.js');
  writeFileSync(probe, `const {spawnSync}=require('node:child_process'); const r=spawnSync(process.execPath,[process.env.TEST_LAUNCHER],{env:process.env,encoding:'utf8'}); console.log(JSON.stringify({exec:process.execPath,token:process.env.GH_TOKEN||'',active:process.env.PAPERCLIP_GITHUB_OPERATION_ACTIVE,path:process.env.PATH,recursion:r.status,stderr:r.stderr}));`);
  const r = run(f.launcher, [probe], { PATH: `${f.managed};${first};${second}`, PATHEXT: '.COM;.EXE', GH_CONFIG_DIR: f.root, GH_TOKEN: 'host-secret', TEST_LAUNCHER: f.launcher });
  assert.equal(r.status, 0, r.stderr); const data = JSON.parse(r.stdout); assert.equal(data.exec.toLowerCase(), path.join(first, 'gh.exe').toLowerCase());
  assert.equal(data.token, ''); assert.equal(data.active, '1'); assert.equal(data.path, `${first};${second}`); assert.equal(data.recursion, 126); assert.match(data.stderr, /launcher_recursion_rejected/);
});
test('PATHEXT determines precedence within the same directory', win, t => {
  const f = fixture(t); const dir = path.join(f.root, 'bin'); mkdirSync(dir);
  copyFileSync(process.execPath, path.join(dir, 'gh.exe')); copyFileSync(process.execPath, path.join(dir, 'gh.com'));
  const probe = path.join(f.root, 'ext.js'); writeFileSync(probe, 'console.log(process.execPath)');
  const r = run(f.launcher, [probe], { PATH: `${f.managed};${dir}`, PATHEXT: '.COM;.EXE', GH_CONFIG_DIR: f.root });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim().toLowerCase(), path.join(dir, 'gh.com').toLowerCase());
});
test('missing or disallowed executable returns 127', win, t => {
  const f = fixture(t); const dir = path.join(f.root, 'bin'); mkdirSync(dir); copyFileSync(process.execPath, path.join(dir, 'gh.exe'));
  const r = run(f.launcher, ['--version'], { PATH: `${f.managed};${dir}`, PATHEXT: '.COM', GH_CONFIG_DIR: f.root });
  assert.equal(r.status, 127); assert.match(r.stderr, /not installed/);
});
