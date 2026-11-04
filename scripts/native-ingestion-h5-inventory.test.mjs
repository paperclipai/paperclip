import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { validateArmInventory } from './native-ingestion-h5-inventory.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sourceRevision = '1'.repeat(40), reportSha256 = hash('owning-playwright'), binarySha256 = hash('runner');
const roots = ['server/dist', 'ui/dist', 'packages/db/src', 'packages/shared/src'];
const descriptors = () => [
  'packages/db/src/client.ts', 'packages/shared/src/index.ts', 'server/dist/hot-a.js',
  'server/dist/hot-b.js', 'server/dist/hot-c.js', 'server/dist/index.js', 'ui/dist/index.html',
].map(file => ({ bytes: 10, path: file, sha256: hash(file) }));
const aggregate = files => hash(files.map(row => JSON.stringify({ bytes: row.bytes, path: row.path, sha256: row.sha256 })).join('\n') + '\n');

async function fixture(directory, options = {}) {
  const revision = options.revision ?? sourceRevision;
  const files = descriptors(), manifest = { variant: 'B2', revision, compiledBuildRevision: revision,
    roots, fileCount: files.length, aggregateSha256: aggregate(files), files };
  options.manifest?.(manifest);
  const manifestBytes = gzipSync(Buffer.from(JSON.stringify(manifest)));
  const summary = { capturedAt: '2026-11-03T00:00:00.000Z', inventories: { B2: {
    manifest: 'B2-artifact-inventory.json.gz', manifestSha256: hash(manifestBytes), fileCount: manifest.fileCount,
    aggregateSha256: manifest.aggregateSha256 } } };
  options.summary?.(summary);
  const receipt = { completedAt: '2026-11-03T00:00:01.000Z',
    results: [{ variant: 'B2', revision, compiledBuildRevision: revision, sourceClean: true }],
    rustSourceTree: '2'.repeat(40), binarySha256, nativeStageHashes: [{ variant: 'B2', binarySha256 }],
    artifactInventorySummary: '/owned/original/artifact-inventory-summary.json' };
  options.receipt?.(receipt);
  const summaryBytes = Buffer.from(JSON.stringify(summary)), receiptBytes = Buffer.from(JSON.stringify(receipt));
  const sidecar = { schema: 'paperclip.native-ingestion.arm-inventory.v1', variant: 'B2', sourceRevision: revision,
    compiledBuildRevision: revision, playwrightReportSha256: reportSha256,
    manifestFile: 'B2-artifact-inventory.json.gz', manifestFileSha256: hash(manifestBytes),
    aggregateSha256: manifest.aggregateSha256,
    qualifiedReceiptFile: 'qualified.json', qualifiedReceiptSha256: hash(receiptBytes),
    inventorySummaryFile: 'artifact-inventory-summary.json', inventorySummarySha256: hash(summaryBytes) };
  options.sidecar?.(sidecar);
  const evidence = { sourceRevision: revision, compiledBuildRevision: revision,
    serverEntrySha256: hash('server/dist/index.js'), remote: { runner: { sha256: binarySha256 } },
    compiledHotPathHashes: Object.fromEntries(['server/dist/hot-a.js', 'server/dist/hot-b.js', 'server/dist/hot-c.js'].map(file => [file, hash(file)])) };
  options.evidence?.(evidence);
  await Promise.all([
    writeFile(path.join(directory, sidecar.manifestFile), manifestBytes),
    writeFile(path.join(directory, sidecar.inventorySummaryFile), summaryBytes),
    writeFile(path.join(directory, sidecar.qualifiedReceiptFile), receiptBytes),
    writeFile(path.join(directory, 'arm-inventory.json'), JSON.stringify(sidecar)),
  ]);
  return { sidecarFile: path.join(directory, 'arm-inventory.json'), sidecar, evidence,
    owningPlaywright: { reportSha256 }, manifest, summary, receipt };
}

async function withFixture(options, work) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'h5-inventory-'));
  try { await work(await fixture(directory, options), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('full frozen inventory, qualified native build and owning report bind one arm', async () => {
  await withFixture({}, async value => {
    const proof = await validateArmInventory(value.sidecarFile, value);
    assert.equal(proof.manifestFileSha256, value.sidecar.manifestFileSha256);
    assert.equal(proof.aggregateSha256, aggregate(descriptors()));
    assert.equal(proof.fileCount, descriptors().length);
    assert.equal(proof.qualifiedReceiptSha256, value.sidecar.qualifiedReceiptSha256);
    assert.equal(proof.playwrightReportSha256, reportSha256);
    assert.equal(proof.binarySha256, binarySha256);
    assert.deepEqual(proof.roots, roots);
  });
});

test('exact compressed manifest bytes and build-receipt bytes cannot be swapped', async () => {
  for (const field of ['manifestFile', 'qualifiedReceiptFile']) await withFixture({}, async (value, directory) => {
    const file = path.join(directory, value.sidecar[field]);
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.from(' ')]));
    await assert.rejects(validateArmInventory(value.sidecarFile, value), /bytes changed/);
  });
});

test('source, compiled build and owning report must match the arm', async () => {
  const cases = [
    [{ sidecar: row => { row.sourceRevision = '3'.repeat(40); } }, /source revision differs/],
    [{ sidecar: row => { row.compiledBuildRevision = '3'.repeat(40); } }, /build revision differs/],
    [{ sidecar: row => { row.playwrightReportSha256 = hash('another-report'); } }, /another owning Playwright/],
    [{ manifest: row => { row.revision = '3'.repeat(40); } }, /manifest source revision/],
    [{ receipt: row => { row.results[0].revision = '3'.repeat(40); } }, /receipt source revision/],
    [{ receipt: row => { row.results[0].compiledBuildRevision = '3'.repeat(40); } }, /receipt build revision/],
    [{ receipt: row => { row.results[0].sourceClean = false; } }, /source was not clean/],
  ];
  for (const [options, message] of cases) await withFixture(options, async value => {
    await assert.rejects(validateArmInventory(value.sidecarFile, value), message);
  });
});

test('file descriptors must be complete, bounded, distinct and match the Python aggregate', async () => {
  const cases = [
    [row => { row.fileCount--; }, /file count is incomplete/],
    [row => { row.aggregateSha256 = hash('wrong aggregate'); }, /aggregate does not match/],
    [row => { row.files[0].bytes = -1; }, /file descriptor/],
    [row => { row.files[0].path = '../outside'; }, /escapes registered roots/],
    [row => { row.files[1].path = row.files[0].path; }, /Duplicate/],
    [row => { row.files.reverse(); }, /order differs/],
    [row => { row.files.pop(); row.fileCount--; row.aggregateSha256 = aggregate(row.files); }, /omitted a registered root/],
    [row => { row.roots = ['server/dist']; }, /registered inventory roots/],
  ];
  for (const [change, message] of cases) await withFixture({ manifest: change }, async value => {
    await assert.rejects(validateArmInventory(value.sidecarFile, value), message);
  });
});

test('summary identifies exact gzip, count and aggregate for the selected variant', async () => {
  for (const [key, value] of [['manifestSha256', hash('wrong')], ['fileCount', 1], ['aggregateSha256', hash('wrong')]]) {
    await withFixture({ summary: row => { row.inventories.B2[key] = value; } }, async fixture => {
      await assert.rejects(validateArmInventory(fixture.sidecarFile, fixture), /Inventory summary/);
    });
  }
});

test('serving entry, every hot path and native binary must match full evidence', async () => {
  const cases = [
    [row => { row.serverEntrySha256 = hash('wrong-entry'); }, /server entry differs/],
    [row => { row.compiledHotPathHashes['server/dist/hot-c.js'] = hash('wrong-hot-path'); }, /hot path differs/],
    [row => { row.remote.runner.sha256 = hash('wrong-native'); }, /native binary differs/],
  ];
  for (const [change, message] of cases) await withFixture({ evidence: change }, async value => {
    await assert.rejects(validateArmInventory(value.sidecarFile, value), message);
  });
  await withFixture({ receipt: row => { row.nativeStageHashes.push({ ...row.nativeStageHashes[0] }); } }, async value => {
    await assert.rejects(validateArmInventory(value.sidecarFile, value), /native stage exactly once/);
  });
});

test('a future candidate revision is accepted only with matching complete provenance', async () => {
  await withFixture({ revision: 'f'.repeat(40) }, async value => {
    const proof = await validateArmInventory(value.sidecarFile, value);
    assert.equal(proof.revision, 'f'.repeat(40));
    assert.equal(proof.compiledBuildRevision, 'f'.repeat(40));
  });
});

test('aggregate follows the existing Python ensure_ascii convention for non-ASCII paths', async () => {
  // Independently computed with the retained artifact-inventory-ce33.py
  // json.dumps(sort_keys=True, separators=(',', ':')) canonical convention.
  const expected = '6f7bf8cab07e2aaf8faaa95a8bdb565c588670e4e3e3580acdba1f93154fedde';
  await withFixture({ manifest: row => {
    row.files.at(-1).path = 'ui/dist/é😀\u007f.html'; row.aggregateSha256 = expected;
  } }, async value => {
    const proof = await validateArmInventory(value.sidecarFile, value);
    assert.equal(proof.aggregateSha256, expected);
  });
});
