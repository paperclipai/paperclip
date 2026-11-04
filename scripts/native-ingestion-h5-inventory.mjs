import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const SCHEMA = 'paperclip.native-ingestion.arm-inventory.v1';
const ROOTS = ['server/dist', 'ui/dist', 'packages/db/src', 'packages/shared/src'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

async function bounded(file, maximumBytes) {
  const metadata = await stat(file);
  assert.ok(metadata.isFile() && metadata.size <= maximumBytes, 'Inventory evidence file is absent, nonregular or oversized');
  const bytes = await readFile(file);
  assert.ok(bytes.length <= maximumBytes, 'Inventory evidence file grew beyond its bound');
  return bytes;
}

function relativeArtifact(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !value.includes('\0') && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
    && !value.split('/').includes('..') && ROOTS.some(root => value.startsWith(`${root}/`));
}

// The existing Python generator sorts Unicode code points and uses json.dumps
// with sort_keys=True, separators=(',', ':') and its default ensure_ascii=True.
function pythonOrder(left, right) {
  const a = [...left], b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference) return difference;
  }
  return a.length - b.length;
}
const pythonRow = row => JSON.stringify({ bytes: row.bytes, path: row.path, sha256: row.sha256 })
  .replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * Validates frozen inventory evidence and reported serving fingerprints only.
 * The owner supplies this sidecar per arm; this helper never reads the SUT tree
 * and does not attest that a live filesystem remained unchanged during a run.
 */
export async function validateArmInventory(sidecarFile, { evidence, owningPlaywright }) {
  assert.equal(typeof sidecarFile, 'string', 'Missing arm inventory sidecar');
  assert.ok(object(evidence) && object(owningPlaywright), 'Missing serving evidence or owning Playwright report');
  const absoluteSidecar = path.resolve(sidecarFile), base = path.dirname(absoluteSidecar);
  const sidecarBytes = await bounded(absoluteSidecar, 256 * 1024);
  const sidecar = JSON.parse(sidecarBytes.toString('utf8'));
  assert.equal(sidecar.schema, SCHEMA, 'Unsupported arm inventory sidecar schema');
  assert.ok(['B0', 'B1', 'B2'].includes(sidecar.variant), 'Unknown inventory variant');
  assert.ok(revision(sidecar.sourceRevision) && revision(sidecar.compiledBuildRevision), 'Invalid inventory source revision');
  assert.equal(sidecar.sourceRevision, evidence.sourceRevision, 'Inventory source revision differs from arm');
  assert.equal(sidecar.compiledBuildRevision, evidence.compiledBuildRevision, 'Inventory build revision differs from arm');
  assert.equal(sidecar.compiledBuildRevision, sidecar.sourceRevision, 'Inventory was built from a different source revision');
  assert.ok(digest(sidecar.playwrightReportSha256) && digest(owningPlaywright.reportSha256), 'Missing owning Playwright report hash');
  assert.equal(sidecar.playwrightReportSha256, owningPlaywright.reportSha256, 'Inventory belongs to another owning Playwright report');
  const resolve = name => {
    assert.ok(typeof sidecar[name] === 'string' && sidecar[name].length > 0, `Missing inventory ${name}`);
    return path.resolve(base, sidecar[name]);
  };
  const readHashed = async (name, hashName, maximumBytes) => {
    assert.ok(digest(sidecar[hashName]), `Invalid inventory ${hashName}`);
    const file = resolve(name), bytes = await bounded(file, maximumBytes);
    assert.equal(sha256(bytes), sidecar[hashName], `Inventory ${name} bytes changed`);
    return { file, bytes };
  };
  const manifestSource = await readHashed('manifestFile', 'manifestFileSha256', 64 * 1024 * 1024);
  const manifest = JSON.parse(gunzipSync(manifestSource.bytes, { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['aggregateSha256', 'compiledBuildRevision', 'fileCount', 'files', 'revision', 'roots', 'variant']);
  assert.equal(manifest.variant, sidecar.variant, 'Inventory manifest variant differs from sidecar');
  assert.equal(manifest.revision, sidecar.sourceRevision, 'Inventory manifest source revision differs from arm');
  assert.equal(manifest.compiledBuildRevision, sidecar.compiledBuildRevision, 'Inventory manifest build revision differs from arm');
  assert.deepEqual(manifest.roots, ROOTS, 'Full registered inventory roots are required');
  assert.ok(Number.isSafeInteger(manifest.fileCount) && manifest.fileCount > 0 && manifest.fileCount <= 500000, 'Invalid inventory file count');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === manifest.fileCount, 'Inventory file count is incomplete');
  assert.ok(digest(manifest.aggregateSha256) && digest(sidecar.aggregateSha256), 'Invalid inventory aggregate hash');
  const files = new Map();
  for (const row of manifest.files) {
    assert.ok(object(row), 'Invalid inventory file row');
    assert.deepEqual(Object.keys(row).sort(), ['bytes', 'path', 'sha256']);
    assert.ok(relativeArtifact(row.path), 'Inventory file escapes registered roots');
    assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && digest(row.sha256), 'Invalid inventory file descriptor');
    assert.equal(files.has(row.path), false, 'Duplicate inventory file path');
    files.set(row.path, row);
  }
  const sorted = [...manifest.files].sort((left, right) => pythonOrder(left.path, right.path));
  assert.deepEqual(manifest.files.map(row => row.path), sorted.map(row => row.path), 'Inventory file order differs from generator');
  for (const root of ROOTS) assert.ok(manifest.files.some(row => row.path.startsWith(`${root}/`)), 'Inventory omitted a registered root');
  const aggregate = sha256(Buffer.from(`${sorted.map(pythonRow).join('\n')}\n`, 'utf8'));
  assert.equal(aggregate, manifest.aggregateSha256, 'Inventory aggregate does not match exact file descriptors');
  assert.equal(aggregate, sidecar.aggregateSha256, 'Inventory aggregate differs from sidecar');
  assert.ok(digest(evidence.serverEntrySha256), 'Missing serving server entry hash');
  assert.equal(files.get('server/dist/index.js')?.sha256, evidence.serverEntrySha256, 'Serving server entry differs from full inventory');
  assert.ok(object(evidence.compiledHotPathHashes) && Object.keys(evidence.compiledHotPathHashes).length > 0, 'Missing serving hot-path fingerprints');
  for (const [file, hash] of Object.entries(evidence.compiledHotPathHashes)) {
    assert.ok(relativeArtifact(file) && digest(hash), 'Invalid serving hot-path fingerprint');
    assert.equal(files.get(file)?.sha256, hash, 'Serving hot path differs from full inventory');
  }
  const summarySource = await readHashed('inventorySummaryFile', 'inventorySummarySha256', 1024 * 1024);
  const summary = JSON.parse(summarySource.bytes.toString('utf8'));
  const summaryRow = summary.inventories?.[sidecar.variant];
  assert.ok(object(summaryRow), 'Inventory summary omitted this variant');
  assert.ok(typeof summaryRow.manifest === 'string' && path.basename(summaryRow.manifest) === summaryRow.manifest
    && summaryRow.manifest.endsWith('.json.gz'), 'Inventory summary manifest reference is invalid');
  assert.equal(summaryRow.manifestSha256, sidecar.manifestFileSha256, 'Inventory summary points to different manifest bytes');
  assert.equal(summaryRow.aggregateSha256, aggregate, 'Inventory summary aggregate differs');
  assert.equal(summaryRow.fileCount, manifest.fileCount, 'Inventory summary file count differs');
  const receiptSource = await readHashed('qualifiedReceiptFile', 'qualifiedReceiptSha256', 4 * 1024 * 1024);
  const receipt = JSON.parse(receiptSource.bytes.toString('utf8'));
  assert.ok(Array.isArray(receipt.results), 'Qualified build receipt has no results');
  const qualified = receipt.results.filter(row => row.variant === sidecar.variant);
  assert.equal(qualified.length, 1, 'Qualified build receipt must identify this variant exactly once');
  assert.equal(qualified[0].revision, sidecar.sourceRevision, 'Qualified build receipt source revision differs');
  assert.equal(qualified[0].compiledBuildRevision, sidecar.compiledBuildRevision, 'Qualified build receipt build revision differs');
  assert.equal(qualified[0].sourceClean, true, 'Qualified build source was not clean');
  assert.ok(typeof receipt.artifactInventorySummary === 'string' && receipt.artifactInventorySummary.length > 0,
    'Qualified build receipt omitted its inventory summary reference');
  assert.ok(revision(receipt.rustSourceTree), 'Qualified build receipt omitted Rust input identity');
  assert.ok(Array.isArray(receipt.nativeStageHashes), 'Qualified build receipt omitted native stage hashes');
  const native = receipt.nativeStageHashes.filter(row => row.variant === sidecar.variant);
  assert.equal(native.length, 1, 'Qualified build receipt must identify this native stage exactly once');
  assert.ok(digest(native[0].binarySha256) && digest(receipt.binarySha256), 'Qualified native binary hash is invalid');
  assert.equal(native[0].binarySha256, receipt.binarySha256, 'Qualified native binary hashes disagree');
  assert.equal(native[0].binarySha256, evidence.remote?.runner?.sha256, 'Serving native binary differs from qualified build');
  return { schema: SCHEMA, sidecarFile: absoluteSidecar, sidecarFileSha256: sha256(sidecarBytes), variant: sidecar.variant,
    revision: manifest.revision, compiledBuildRevision: manifest.compiledBuildRevision,
    manifestFile: manifestSource.file, manifestFileSha256: sidecar.manifestFileSha256,
    aggregateSha256: aggregate, fileCount: manifest.fileCount, roots: manifest.roots,
    inventorySummaryFile: summarySource.file, inventorySummarySha256: sidecar.inventorySummarySha256,
    qualifiedReceiptFile: receiptSource.file, qualifiedReceiptSha256: sidecar.qualifiedReceiptSha256,
    binarySha256: native[0].binarySha256, rustSourceTree: receipt.rustSourceTree,
    playwrightReportSha256: owningPlaywright.reportSha256,
    scope: 'Exact frozen manifest/summary/build-receipt bytes for all registered roots, with reported server/hot-path/native fingerprints checked; no live SUT filesystem attestation' };
}
