import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const enabled = process.platform === 'linux';
let root;
let script;
let environment;
before(async () => {
  if (!enabled) return;
  root = await mkdtemp(path.join(tmpdir(), 'paperclip-wsl-helper-'));
  const repo = path.join(root, 'repo');
  const instance = path.join(root, 'data', 'instances', 'default');
  script = path.join(repo, 'skills', 'paperclip-wsl', 'scripts', 'paperclip-wsl.mjs');
  await mkdir(path.dirname(script), { recursive: true });
  await mkdir(path.join(repo, '.paperclip'), { recursive: true });
  await mkdir(instance, { recursive: true });
  await copyFile(fileURLToPath(new URL('./paperclip-wsl.mjs', import.meta.url)), script);
  const bins = [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'];
  const home = path.join(root, 'data');
  await writeFile(path.join(repo, '.paperclip', 'wsl.local.json'), JSON.stringify({
    distro: process.env.WSL_DISTRO_NAME || 'test', user: (await import('node:os')).userInfo().username,
    checkout: repo, node: process.execPath, paperclipHome: home, instanceId: 'default', port: 3100,
    binPaths: bins, ...(process.env.WSL_DISTRO_NAME ? { capacityPath: "/mnt/c" } : {}), minimumFreeBytes: 1,
  }));
  await writeFile(path.join(instance, 'config.json'), JSON.stringify({ server: { port: 3100 } }));
  environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('PAPERCLIP_') || ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'PORT'].includes(key)) delete environment[key];
  }
  assert.equal(spawnSync('git', ['init', repo], { env: environment, encoding: 'utf8' }).status, 0);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
function invoke(args, extra = {}) {
  return spawnSync(process.execPath, [script, ...args], { env: { ...environment, ...extra }, encoding: 'utf8', timeout: 10000 });
}
test('passes spaces and Unicode as one argument and selects the configured instance', { skip: !enabled }, () => {
  const result = invoke(['exec', process.execPath, '-e', 'console.log(JSON.stringify({args:process.argv.slice(1),config:process.env.PAPERCLIP_CONFIG}))', 'ruimte en café']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.args, ['ruimte en café']);
  assert.equal(output.config, path.join(root, 'data', 'instances', 'default', 'config.json'));
});
for (const [key, value] of [['PAPERCLIP_INSTANCE_ID', 'other'], ['PAPERCLIP_CONFIG', '/tmp/other.json'], ['DATABASE_URL', 'postgres://other'], ['DATABASE_MIGRATION_URL', 'postgres://other'], ['PORT', '3101']]) {
  test('refuses ' + key + ' before starting the requested command', { skip: !enabled }, () => {
    const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")'], { [key]: value });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(key));
    assert.doesNotMatch(result.stdout, /STARTED/);
  });
}
test('refuses Windows executables and reports missing native tools', { skip: !enabled }, () => {
  const result = invoke(['exec', 'definitely-unavailable-paperclip.exe']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-native or unavailable command/);
});

for (const location of ['instance', 'checkout']) {
  test('rejects saved database overrides in the ' + location + ' dotenv file', { skip: !enabled }, async () => {
    const file = location === 'instance' ? path.join(root, 'data', 'instances', 'default', '.env') : path.join(root, 'repo', '.env');
    await writeFile(file, 'DATABASE_URL=postgres://another-database\n');
    try {
      const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /DATABASE_URL/);
      assert.doesNotMatch(result.stdout, /STARTED/);
    } finally { await rm(file); }
  });
}
test('rejects a different Windows instance selection before executing', { skip: !enabled }, async () => {
  const config = JSON.parse(await readFile(path.join(root, 'repo', '.paperclip', 'wsl.local.json'), 'utf8'));
  config.instanceId = 'another-instance';
  const result = invoke(['--linux-entry', Buffer.from(JSON.stringify(config)).toString('base64url'), 'exec', process.execPath, '-e', 'console.log("STARTED")']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Windows and Linux profiles differ/);
  assert.doesNotMatch(result.stdout, /STARTED/);
});
test('puts the selected Node before a conflicting configured PATH', { skip: !enabled }, async () => {
  const file = path.join(root, 'repo', '.paperclip', 'wsl.local.json');
  const saved = await readFile(file, 'utf8');
  const config = JSON.parse(saved);
  const bin = path.join(root, 'shadow-bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'node'), '#!/bin/sh\necho WRONG_NODE\n');
  await chmod(path.join(bin, 'node'), 0o755);
  config.binPaths.unshift(bin);
  await writeFile(file, JSON.stringify(config));
  try {
    const result = invoke(['exec', 'node', '-e', 'console.log(process.execPath)']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), process.execPath);
  } finally { await writeFile(file, saved); }
});
test('rejects a Windows backup path in the selected instance config', { skip: !enabled }, async () => {
  const file = path.join(root, 'data', 'instances', 'default', 'config.json');
  const saved = await readFile(file, 'utf8');
  await writeFile(file, JSON.stringify({server:{port:3100},database:{backup:{dir:'C:\\old-backups'}}}));
  try {
    const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Windows data paths/);
  } finally { await writeFile(file, saved); }
});
test('requires host capacity selection when invoked in WSL', { skip: !enabled }, async () => {
  const file = path.join(root, 'repo', '.paperclip', 'wsl.local.json');
  const saved = await readFile(file, 'utf8');
  const config = JSON.parse(saved);
  delete config.capacityPath;
  await writeFile(file, JSON.stringify(config));
  try {
    const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")'], { WSL_DISTRO_NAME: config.distro });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /capacityPath/);
  } finally { await writeFile(file, saved); }
});

for (const backup of ['~/backups', './backups']) {
  test('accepts supported native backup path ' + backup, { skip: !enabled }, async () => {
    const file = path.join(root, 'data', 'instances', 'default', 'config.json');
    const saved = await readFile(file, 'utf8');
    await writeFile(file, JSON.stringify({server:{port:3100},database:{backup:{dir:backup}}}));
    try {
      const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /STARTED/);
    } finally { await writeFile(file, saved); }
  });
}

for (const [key, value] of [['PAPERCLIP_CONTEXT','/tmp/other/context.json'], ['PAPERCLIP_AUTH_STORE','/tmp/other/auth.json'], ['PAPERCLIP_STORAGE_PROVIDER','s3'], ['PAPERCLIP_STORAGE_S3_BUCKET','other'], ['PAPERCLIP_STORAGE_S3_ENDPOINT','https://other.invalid'], ['PAPERCLIP_STORAGE_S3_PREFIX','other/'], ['PAPERCLIP_IN_WORKTREE','true'], ['PAPERCLIP_API_URL','http://localhost:3101']]) {
  test('rejects inherited instance selector ' + key, { skip: !enabled }, () => {
    const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")'], { [key]: value });
    assert.equal(result.status, 1);
    assert.match(result.stderr, key === "PAPERCLIP_API_URL" ? /CLI context targets another instance/ : new RegExp(key));
    assert.doesNotMatch(result.stdout, /STARTED/);
  });
}
test('rejects a normalized data path into a Windows mount', { skip: !enabled }, async () => {
  const file = path.join(root, 'data', 'instances', 'default', 'config.json');
  const saved = await readFile(file, 'utf8');
  await writeFile(file, JSON.stringify({server:{port:3100},storage:{localDisk:{baseDir:'/home/../mnt/c/other'}}}));
  try {
    const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Windows data paths/);
  } finally { await writeFile(file, saved); }
});

for (const location of ['home', 'checkout']) {
  test('rejects a saved CLI API target in the ' + location + ' context', { skip: !enabled }, async () => {
    const file = location === 'home' ? path.join(root, 'data', 'context.json') : path.join(root, 'repo', '.paperclip', 'context.json');
    await writeFile(file, JSON.stringify({version:2,currentProfile:'default',profiles:{default:{apiBase:'https://another-instance.invalid'}}}));
    try {
      const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /CLI context targets another instance/);
      assert.doesNotMatch(result.stdout, /STARTED/);
    } finally { await rm(file); }
  });
}
test('preserves the checkout CLI context for the selected local instance', { skip: !enabled }, async () => {
  const file = path.join(root, 'repo', '.paperclip', 'context.json');
  await writeFile(file, JSON.stringify({version:2,currentProfile:'default',profiles:{default:{apiBase:'http://localhost:3100',companyId:'local-company'}}}));
  try {
    const result = invoke(['exec', process.execPath, '-e', 'console.log(process.env.PAPERCLIP_CONTEXT)']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), file);
  } finally { await rm(file); }
});

test('allows unused remote profiles while rejecting an explicitly selected remote profile', { skip: !enabled }, async () => {
  const file = path.join(root, 'data', 'context.json');
  await writeFile(file, JSON.stringify({version:2,currentProfile:'local',profiles:{local:{apiBase:'http://localhost:3100'},remote:{apiBase:'https://remote.invalid'}}}));
  try {
    const local = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")']);
    assert.equal(local.status, 0, local.stderr);
    const remote = invoke(['exec', 'pnpm', 'paperclipai', '--profile', 'remote', 'company', 'list']);
    assert.equal(remote.status, 1);
    assert.match(remote.stderr, /CLI context targets another instance/);
  } finally { await rm(file); }
});
