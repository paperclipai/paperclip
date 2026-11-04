// Portable source checks. Only temporary test/input locations are adapted;
// sealed helpers, fixtures, assertions and existing campaign files stay intact.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packageRoot, hash, verifyPackage } from './verify-package.mjs';

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const suite = option('suite') ?? 'h5e';
assert.ok(['h5e', 'resource', 'external'].includes(suite), 'Select h5e, resource or external');
await verifyPackage();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'native-ingestion-source-checks-'));
const commands = [], adaptations = [];
const cleanEnvironment = { ...process.env };
for (const key of ['PROVENANCE_HELPER_ROOT', 'SOURCE_HELPER_ROOT', 'PAPERCLIP_RESOURCE_PINS_FILE',
  'PAPERCLIP_RESOURCE_PINS_SHA256', 'NODE_OPTIONS']) delete cleanEnvironment[key];

function run(args, cwd, expectedExit = 0, environment = cleanEnvironment) {
  let stdout = '', stderr = '', exit = 0;
  try {
    stdout = execFileSync(process.execPath, args, { cwd, env: environment,
      encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    exit = error.status;
    stdout = String(error.stdout ?? ''); stderr = String(error.stderr ?? '');
    if (exit !== expectedExit) throw error;
  }
  assert.equal(exit, expectedExit);
  commands.push({ args, cwd, exit, expectedExit, stdoutSha256: hash(stdout), stderrSha256: hash(stderr) });
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return stdout;
}

try {
  const resource = path.join(packageRoot, 'snapshots/resource-v3');
  if (suite === 'resource') {
    run(['--test', '--test-concurrency=1', 'counter-semantics.test.mjs', 'counter-flush.test.mjs',
      'resource-tools.test.mjs', 'cleanup-faults.test.mjs', 'preload-tag-contract.test.mjs'], resource);
  } else if (suite === 'external') {
    run(['--test', '--test-concurrency=1', 'pg_cluster_binding.test.mjs', 'pg_resources.test.mjs'], path.join(resource, 'external'));
  } else {
    const mainRoot = option('main-root'), companionRoot = option('companion-root');
    assert.ok(mainRoot && companionRoot, 'Pass --main-root and --companion-root with the exact independent frozen checkouts');
    for (const [root, revision] of [[mainRoot, '73ea8516739e81fa7f37cd67651b4a2c73674014'],
      [companionRoot, 'a89f321ab5654211cbff7be1ee15c110b8db4a5f']]) {
      assert.ok(path.isAbsolute(root));
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), revision);
      assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '');
    }
    const work = path.join(temporary, 'h5e-v4');
    await cp(path.join(packageRoot, 'snapshots/h5e-v4'), work, { recursive: true });
    const builds = path.join(temporary, 'cf-builds'), inventories = path.join(builds, 'evidence/aligned-cf/environment');
    await mkdir(inventories, { recursive: true });
    const metadata = path.join(resource, 'baseline-metadata');
    await cp(path.join(metadata, 'aligned-cf-builds-qualified.json'), path.join(builds, 'aligned-cf-builds-qualified.json'));
    for (const name of ['artifact-inventory-summary.json', 'B0-artifact-inventory.json.gz', 'B1-artifact-inventory.json.gz']) {
      await cp(path.join(metadata, name), path.join(inventories, name));
    }
    await cp(path.join(packageRoot, 'fixtures/unoptimized-B2-base-artifact-inventory.json.gz'), path.join(inventories, 'B2-base-artifact-inventory.json.gz'));
    const compositionFile = path.join(work, 'composition.json');
    const composition = JSON.parse(await readFile(compositionFile, 'utf8'));
    for (const row of composition.clones) row.parent = path.join(packageRoot, 'snapshots/h5e-v3', row.file);
    await writeFile(compositionFile, JSON.stringify(composition));
    const replacements = new Map([
      ['/private/tmp/native-ingestion-evidence-cf/builds', builds],
      ['/private/tmp/native-ingestion-cf-build-descriptors.json', path.join(packageRoot, 'fixtures/cf-build-descriptors.json')],
      ['/private/tmp/native-ingestion-run-h5d-browser.mjs', path.join(packageRoot, '../h5d/native-ingestion-run-h5d-browser.mjs')],
      ['/private/tmp/paperclip-native-event-blocked-stop-v4', companionRoot],
    ]);
    for (const name of ['source-guards.test.mjs', 'native-provenance.test.mjs']) {
      const file = path.join(work, name), original = await readFile(file, 'utf8');
      let adapted = original;
      for (const [from, to] of replacements) {
        let count = 0;
        adapted = adapted.replace(/(['"])(\/private\/tmp\/[^'"\n]*)\1/g, (literal, _quote, value) => {
          if (value !== from && !value.startsWith(from + '/')) return literal;
          count++;
          return JSON.stringify(to + value.slice(from.length));
        });
        if (count) adaptations.push({ file: name, from, to, count });
      }
      await writeFile(file, adapted);
      adaptations.push({ file: name, originalSha256: hash(original), temporarySha256: hash(adapted), assertionsChanged: false });
    }
    run(['--test', '--test-concurrency=1', 'native-provenance.test.mjs', 'source-guards.test.mjs'], work);
    const red = run(['--test', '--test-name-pattern=qualified current75 and prospective sources use exact descriptor receipts',
      'native-provenance.test.mjs'], work, 1, { ...cleanEnvironment, PROVENANCE_HELPER_ROOT: path.join(packageRoot, 'snapshots/h5e-v3') });
    assert.equal(red.split('B2 must use the reviewed current TypeScript batching source revision').length - 1, 2);
    run(['--test', '--test-name-pattern=H5 CLI retains baseline SLA failure', 'scripts/native-ingestion-performance-gates.test.mjs'], mainRoot);
  }
  console.log(JSON.stringify({ sourceOnly: true, complete: true, suite, assertionsChanged: false,
    sealedSourceBytesChanged: false, commands, temporaryTestPathAdaptations: adaptations }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
