import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { prepareReportLock } from './prepare-report-lock.mjs';
import { withReportingDependencies, reportingPnpmArguments } from './report-only-dependencies.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const grpc = '@grpc/grpc-js@1.14.5', photon = '@photon-ai/advanced-imessage@2.2.0';
const canonical = { 'postgres@3.4.9': 'patches/postgres@3.4.9.patch' };
async function fixture(run, mutate = async () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'reporting-patches-'));
  try {
    const directory = path.join(root, 'tests/runner-e2e'); await mkdir(directory, { recursive: true });
    const patches = { ...canonical, [grpc]: 'patches/@grpc__grpc-js@1.14.5.patch', [photon]: 'patches/@photon-ai__advanced-imessage@2.2.0.patch' };
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: { postinstall: 'MUST_NOT_RUN' }, pnpm: { patchedDependencies: patches } }, null, 2) + '\n');
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\npatchedDependencies:\n' + Object.entries(patches).map(([key, value]) => `  "${key}": ${value}\n`).join('') + '\noverrides:\n  stable: 1\n');
    await writeFile(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npatchedDependencies:\n  postgres@3.4.9:\n    hash: abc123\n    path: patches/postgres@3.4.9.patch\nimporters:\n  .:\n    dependencies:\n      stable:\n        specifier: ^1.0.0\n        version: 1.0.0\n");
    await mkdir(path.join(root, 'packages/db'), { recursive: true });
    await mkdir(path.join(root, 'cli'), { recursive: true });
    await writeFile(path.join(root, 'packages/db/package.json'), JSON.stringify({ dependencies: { 'drizzle-orm': '0.45.2', postgres: '3.4.9' } }));
    await writeFile(path.join(root, 'cli/package.json'), JSON.stringify({ dependencies: { postgres: '3.4.9', tsx: '^4.23.15' } }));
    await writeFile(path.join(root, 'pnpm-lock.yaml'),
      "  cli:\n    dependencies:\n      tsx:\n        specifier: ^4.23.15\n        version: 4.23.15\n"
      + "  packages/db:\n    dependencies:\n      drizzle-orm:\n        specifier: ^0.45.2\n        version: 0.45.2(postgres@3.4.9(patch_hash=abc123))\n      postgres:\n        specifier: ^3.4.9\n        version: 3.4.9(patch_hash=abc123)\n"
      + "  server:\n    dependencies:\n      drizzle-orm:\n        specifier: ^0.45.2\n        version: 0.45.2(postgres@3.4.9(patch_hash=abc123))\n", { flag: 'a' });
    await writeFile(path.join(directory, 'report-lock.patch'), 'authenticated fixture patch\n');
    const lock = await readFile(path.join(root, 'pnpm-lock.yaml')), patch = await readFile(path.join(directory, 'report-lock.patch'));
    await writeFile(path.join(directory, 'report-lock.json'), JSON.stringify({ outputSha256: digest(lock), patchSha256: digest(patch) }));
    await mutate(root);
    const names = ['package.json', 'pnpm-workspace.yaml', 'packages/db/package.json', 'cli/package.json', 'pnpm-lock.yaml', 'tests/runner-e2e/report-lock.json', 'tests/runner-e2e/report-lock.patch'];
    const before = await Promise.all(names.map(async name => [name, await readFile(path.join(root, name)), (await stat(path.join(root, name))).mode]));
    await run(root);
    for (const [name, bytes, mode] of before) { assert.deepEqual(await readFile(path.join(root, name)), bytes, name); assert.equal((await stat(path.join(root, name))).mode, mode); }
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('reporting scope uses canonical patches then restores exact Source, repeatedly', () => fixture(async root => {
  for (let i = 0; i < 2; i++) await withReportingDependencies(root, async () => {
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).pnpm.patchedDependencies, canonical);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'packages/db/package.json'), 'utf8')).dependencies, { 'drizzle-orm': '^0.45.2', postgres: '^3.4.9' });
    assert.equal(JSON.parse(await readFile(path.join(root, 'cli/package.json'), 'utf8')).dependencies.postgres, undefined);
    const workspace = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    assert.ok(!workspace.includes(grpc)); assert.ok(!workspace.includes(photon)); assert.ok(workspace.includes('postgres@3.4.9'));
  });
}));
test('failed frozen installer preserves exact primary error and restores both Source files', () => fixture(async root => {
  const reason = new Error('actual installer refusal');
  await assert.rejects(withReportingDependencies(root, async () => { throw reason; }), error => error === reason);
}));
test('overlapping invocation refuses before changing active reporting scope', () => fixture(async root => {
  await withReportingDependencies(root, async () => {
    await assert.rejects(withReportingDependencies(root, async () => assert.fail('second installer entered')), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).pnpm.patchedDependencies, canonical);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'packages/db/package.json'), 'utf8')).dependencies, { 'drizzle-orm': '^0.45.2', postgres: '^3.4.9' });
    assert.equal(JSON.parse(await readFile(path.join(root, 'cli/package.json'), 'utf8')).dependencies.postgres, undefined);
  });
}));
for (const variant of ['unknown-lock', 'changed-patch', 'unknown-patch', 'changed-canonical-path', 'wrong-extra-path', 'workspace-disagreement', 'duplicate-workspace-key']) {
  test(`refuses ${variant} before installer/config writes`, () => fixture(async root => {
    await assert.rejects(withReportingDependencies(root, async () => assert.fail('installer entered')));
  }, async root => {
    if (variant === 'unknown-lock') return writeFile(path.join(root, 'pnpm-lock.yaml'), 'unknown');
    if (variant === 'changed-patch') return writeFile(path.join(root, 'tests/runner-e2e/report-lock.patch'), 'changed');
    if (variant.startsWith('workspace') || variant === 'duplicate-workspace-key') {
      const file = path.join(root, 'pnpm-workspace.yaml'), text = await readFile(file, 'utf8');
      return writeFile(file, variant === 'duplicate-workspace-key' ? text.replace('patchedDependencies:', 'patchedDependencies:\n  postgres@3.4.9: patches/postgres@3.4.9.patch') : text.replace(`  "${grpc}": patches/@grpc__grpc-js@1.14.5.patch\n`, ''));
    }
    const file = path.join(root, 'package.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
    if (variant === 'unknown-patch') manifest.pnpm.patchedDependencies['other@1'] = 'patches/other.patch';
    if (variant === 'changed-canonical-path') manifest.pnpm.patchedDependencies['postgres@3.4.9'] = 'patches/other.patch';
    if (variant === 'wrong-extra-path') manifest.pnpm.patchedDependencies[grpc] = 'patches/other.patch';
    await writeFile(file, JSON.stringify(manifest));
  }));
}

test('failed restoration retains both exact beforeimages, primary error and exclusive ownership', () => fixture(async root => {
  const packagePath = path.join(root, 'package.json'), workspacePath = path.join(root, 'pnpm-workspace.yaml');
  const originalPackage = await readFile(packagePath), originalWorkspace = await readFile(workspacePath);
  const originalDb = await readFile(path.join(root, 'packages/db/package.json')), originalCli = await readFile(path.join(root, 'cli/package.json'));
  const reason = new Error('frozen installer failed before restoration');
  await assert.rejects(withReportingDependencies(root, async () => {
    await rm(packagePath); await mkdir(packagePath); throw reason;
  }), error => error instanceof AggregateError && error.errors[0] === reason
    && error.errors.some(item => item.code === 'EISDIR'));
  const ownership = path.join(root, '.paperclip-reporting-dependencies');
  assert.deepEqual(await readFile(path.join(ownership, 'package.json.before')), originalPackage);
  assert.deepEqual(await readFile(path.join(ownership, 'pnpm-workspace.yaml.before')), originalWorkspace);
  assert.deepEqual(await readFile(workspacePath), originalWorkspace);
  assert.deepEqual(await readFile(path.join(ownership, 'packages__db__package.json.before')), originalDb);
  assert.deepEqual(await readFile(path.join(ownership, 'cli__package.json.before')), originalCli);
  assert.deepEqual(await readFile(path.join(root, 'packages/db/package.json')), originalDb);
  assert.deepEqual(await readFile(path.join(root, 'cli/package.json')), originalCli);
  await assert.rejects(withReportingDependencies(root, async () => assert.fail('retry entered')), { code: 'EEXIST' });
  // Explicit test-fixture disposal/recovery, never automatic stale-owner takeover.
  await rm(packagePath, { recursive: true }); await writeFile(packagePath, originalPackage);
  await rm(ownership, { recursive: true });
}));
test('only credential-free preflight admits the fixed offline lockfile-only command', () => {
  assert.deepEqual(reportingPnpmArguments('--reporting-preflight', [], {}),
    ['install', '--lockfile-only', '--frozen-lockfile', '--ignore-scripts', '--offline']);
  assert.throws(() => reportingPnpmArguments('--reporting-preflight', ['--offline'], {}));
  for (const name of ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_WEB_IDENTITY_TOKEN_FILE'])
    assert.throws(() => reportingPnpmArguments('--reporting-preflight', [], { [name]: 'controlled capability sentinel' }));
});
test('protected reporting install refuses preflight, resolver and lifecycle option changes', () => {
  const prefix = ['--', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'];
  assert.deepEqual(reportingPnpmArguments('--reporting-install', [...prefix, '--store-dir', '/owned/report-store'], {}),
    ['install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/owned/report-store']);
  for (const extra of ['--lockfile-only', '--offline', '--no-frozen-lockfile', '--resolution-only', '--ignore-scripts=false'])
    assert.throws(() => reportingPnpmArguments('--reporting-install', [...prefix, extra], {}));
  assert.throws(() => reportingPnpmArguments('--reporting-install', ['--', 'pnpm', 'install', '--frozen-lockfile'], {}));
});

test('default reviewed-lock API does not project any Source manifests', () => fixture(async root => {
  assert.equal(await prepareReportLock(root), 'already-reviewed');
  assert.equal(JSON.parse(await readFile(path.join(root, 'packages/db/package.json'), 'utf8')).dependencies.postgres, '3.4.9');
  assert.equal(JSON.parse(await readFile(path.join(root, 'cli/package.json'), 'utf8')).dependencies.postgres, '3.4.9');
}));
for (const file of ['packages/db/package.json', 'cli/package.json']) test(`unknown postgres identity refuses before install: ${file}`, () => fixture(async root => {
  await assert.rejects(withReportingDependencies(root, async () => assert.fail('installer entered')));
}, async root => {
  const p = path.join(root, file), manifest = JSON.parse(await readFile(p, 'utf8')); manifest.dependencies.postgres = '3.4.10'; await writeFile(p, JSON.stringify(manifest));
}));
test('authenticated but different canonical postgres patch resolution refuses', () => fixture(async root => {
  await assert.rejects(withReportingDependencies(root, async () => assert.fail('installer entered')));
}, async root => {
  const p = path.join(root, 'pnpm-lock.yaml'), lock = (await readFile(p, 'utf8')).replaceAll('patch_hash=abc123', 'patch_hash=different'); await writeFile(p, lock);
  const policyPath = path.join(root, 'tests/runner-e2e/report-lock.json'), policy = JSON.parse(await readFile(policyPath, 'utf8')); policy.outputSha256 = digest(lock); await writeFile(policyPath, JSON.stringify(policy));
}));

test('feature-absent reporting still projects DB/CLI and restores all four manifests', () => fixture(async root => {
  await withReportingDependencies(root, async () => {
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).pnpm.patchedDependencies, canonical);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'packages/db/package.json'), 'utf8')).dependencies,
      { 'drizzle-orm': '^0.45.2', postgres: '^3.4.9' });
    const cli = JSON.parse(await readFile(path.join(root, 'cli/package.json'), 'utf8'));
    assert.equal(cli.dependencies.postgres, undefined); assert.equal(cli.dependencies.tsx, '^4.23.15');
  });
}, async root => {
  const packagePath = path.join(root, 'package.json'), manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  delete manifest.pnpm.patchedDependencies[grpc]; delete manifest.pnpm.patchedDependencies[photon];
  await writeFile(packagePath, JSON.stringify(manifest));
  const workspacePath = path.join(root, 'pnpm-workspace.yaml');
  const workspace = (await readFile(workspacePath, 'utf8')).split('\n')
    .filter(line => !line.includes(`"${grpc}"`) && !line.includes(`"${photon}"`)).join('\n');
  await writeFile(workspacePath, workspace);
}));

test('canonical-aligned other versions leave every reporting manifest unchanged during install', () => fixture(async root => {
  const names = ['package.json', 'pnpm-workspace.yaml', 'packages/db/package.json', 'cli/package.json'];
  const before = await Promise.all(names.map(name => readFile(path.join(root, name))));
  await withReportingDependencies(root, async () => {
    for (let i = 0; i < names.length; i++) assert.deepEqual(await readFile(path.join(root, names[i])), before[i]);
  });
}, async root => {
  const packagePath = path.join(root, 'package.json'), manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  manifest.pnpm.patchedDependencies = { 'postgres@3.5.0': 'patches/postgres@3.5.0.patch' };
  await writeFile(packagePath, JSON.stringify(manifest));
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\npatchedDependencies:\n  postgres@3.5.0: patches/postgres@3.5.0.patch\n');
  const dbPath = path.join(root, 'packages/db/package.json'), db = JSON.parse(await readFile(dbPath, 'utf8'));
  db.dependencies = { 'drizzle-orm': '0.46.0', postgres: '3.5.0' }; await writeFile(dbPath, JSON.stringify(db));
  const cliPath = path.join(root, 'cli/package.json'), cli = JSON.parse(await readFile(cliPath, 'utf8')); cli.dependencies.postgres = '3.5.0'; await writeFile(cliPath, JSON.stringify(cli));
  const lockPath = path.join(root, 'pnpm-lock.yaml');
  let lock = (await readFile(lockPath, 'utf8')).replaceAll('3.4.9', '3.5.0').replaceAll('^3.5.0', '3.5.0')
    .replaceAll('^0.45.2', '0.46.0').replaceAll('0.45.2', '0.46.0');
  lock = lock.replace('  cli:\n    dependencies:\n', '  cli:\n    dependencies:\n      postgres:\n        specifier: 3.5.0\n        version: 3.5.0(patch_hash=abc123)\n');
  await writeFile(lockPath, lock);
  const policyPath = path.join(root, 'tests/runner-e2e/report-lock.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
  policy.outputSha256 = digest(lock); await writeFile(policyPath, JSON.stringify(policy));
}));

test('Server drizzle peer mismatch refuses before any reporting projection', () => fixture(async root => {
  await assert.rejects(withReportingDependencies(root, async () => assert.fail('installer entered')));
}, async root => {
  const lockPath = path.join(root, 'pnpm-lock.yaml');
  const lock = (await readFile(lockPath, 'utf8')).replace(
    '  server:\n    dependencies:\n      drizzle-orm:\n        specifier: ^0.45.2\n        version: 0.45.2(postgres@3.4.9(patch_hash=abc123))',
    '  server:\n    dependencies:\n      drizzle-orm:\n        specifier: ^0.45.2\n        version: 0.45.2(postgres@3.4.9(patch_hash=different))');
  await writeFile(lockPath, lock);
  const policyPath = path.join(root, 'tests/runner-e2e/report-lock.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
  policy.outputSha256 = digest(lock); await writeFile(policyPath, JSON.stringify(policy));
}));
test('actual repository canonical reporting profile projects and restores real Source manifests', () => fixture(async root => {
  const lock = parse(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  const inventory = Object.fromEntries(Object.entries(lock.patchedDependencies).map(([name, item]) => [name, item.path]));
  let entered = false;
  await withReportingDependencies(root, async () => {
    entered = true;
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const workspace = parse(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8'));
    assert.deepEqual(manifest.pnpm.patchedDependencies, inventory);
    assert.deepEqual(workspace.patchedDependencies, inventory);
    for (const directory of ['.', 'packages/db', 'cli']) {
      const source = JSON.parse(await readFile(path.join(root, directory, 'package.json'), 'utf8'));
      for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const actual = Object.fromEntries(Object.entries(source[group] ?? {}).map(([name, value]) => [name, workspace.overrides?.[name] ?? value]));
        const expected = Object.fromEntries(Object.entries(lock.importers[directory][group] ?? {}).map(([name, item]) => [name, item.specifier]));
        assert.deepEqual(actual, expected, `${directory}:${group}`);
      }
    }
  });
  assert.equal(entered, true);
}, async root => {
  const repository = path.resolve(import.meta.dirname, '../..');
  for (const file of ['package.json', 'pnpm-workspace.yaml', 'packages/db/package.json', 'cli/package.json']) {
    await copyFile(path.join(repository, file), path.join(root, file));
  }
  // CI may install from an ephemeral resolved overlay. The reporting fixture
  // authenticates the committed canonical policy/lock, never relabels that overlay.
  for (const file of ['pnpm-lock.yaml', 'tests/runner-e2e/report-lock.json', 'tests/runner-e2e/report-lock.patch']) {
    await writeFile(path.join(root, file), execFileSync('git', ['show', `HEAD:${file}`], { cwd: repository }));
  }
  await prepareReportLock(root);
}));
