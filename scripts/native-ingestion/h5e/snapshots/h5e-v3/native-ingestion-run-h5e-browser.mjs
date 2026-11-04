import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open, access, readdir, realpath, stat, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

// Prospective H5 application orchestrator. No launch without --execute and a
// byte-frozen root release. Original ce33 helper SHA is provenance only:
// 2244e238642caafd488a7c86fb463376c8459ee0f06f8054555407a174698fa1.
export const MODE = 'h5c-observe-original-sla-independent-agents-settlement';
export const PROTOCOL = 'v5c-independent-agents-complete-settlement-original-sla';
export const WORKLOAD_SHA256 = '68863d27c95106852050a5eedf8b76ab47aa854c6bd9038afc0fbbfdc6500e2a';
const H5_REVISION = '73ea8516739e81fa7f37cd67651b4a2c73674014';
const OLD_NATIVE_TARGET = '/home/ubuntu/native-ingestion/aligned-baseline/packages/paperclip-runner/runner/target';
const CF_NATIVE_TARGET = '/home/ubuntu/native-ingestion/aligned-cf-baseline/packages/paperclip-runner/runner/target';
const H5_PROTOCOL_SHA256 = '7995ffdbf14b772e4c39444f6b89ba8684bcd86ef8ae866ffb0f5dbd89f35ccd';
const H5_COMPARATOR_SHA256 = '3deceda0ef909829dfc3c2169d5d88ccb7c1ce9aa2881998e8ee07d23c1b56dc';
const H5_INVENTORY_HELPER_SHA256 = '76b897dd6b7a90e784e228d78d79633a6d7011fe3ea01737f3bef9c6113298e9';
const H5_PROTOCOL_DOCUMENT_SHA256 = '9fa1ba019e2385e0e9c23e2c66aebaeaf915e8204f04f00fa7e9bc0f83059291';
const INVENTORY_ROOTS = ['server/dist', 'ui/dist', 'packages/db/src', 'packages/shared/src'];
export const RESOURCE_WATCHDOG_MILLIS = 30 * 60_000;
export const STAGES = Object.freeze(['browser-aa-b0', 'browser-aa-b1', 'browser-b0-b1', 'browser-b1-b2', 'browser-b0-b2']);
export const FINALIZE_STAGE = 'browser-finalize-h4e';
const protocolFiles = ['native-event-ingestion.journey.ts', 'playwright-native-ingestion.config.ts', 'fixtures/in-feed-codex.mjs',
  'fixtures/native-ingestion-bin/codex', 'fixtures/composer-stop-codex-loader.mjs', 'fixtures/native-ingestion-bootstrap.mjs',
  'fixtures/native-ingestion-remote-server.mjs', 'fixtures/native-ingestion-protocol-qualification.mjs', 'fixtures/native-ingestion-h5.mjs'];
const BASELINES = Object.freeze({ B0: '7550ffa5d6447d2615bc89fc5313f4cbb958b615', B1: '2cf1454406cbd582a11f04476713eceb746eada5' });
const OLD_B2 = '0b616ccc90bf43cb26adac056a22ff01a84f982b';
const OLD_RECEIPT = '5a849da1bc307f4f1fd05c70a75813f6f78acc9941a54cc01e945652a5a79d6b';
const OLD_SUMMARY = 'e29a9a1a2b9481ef79f47c6b135e1d207e19d1ffc00833aa28b1f9163a210c5d';
const OLD_BINARY = '512875bd051b7f7a97c93d2aa63648c675a8a991e745c79bc7481ad2d2f02c66';
const OLD_RUST = '11a7ac118a438159c252dc0df4779aa56fec80d6';
const B2_REVISION = '75b3578cfccf040b087a55a624e01baa2bca37f9';
const CF_NATIVE_PROVENANCE = {
  "rustInputObjects": {
    "runner": "11a7ac118a438159c252dc0df4779aa56fec80d6",
    "runner/Cargo.toml": "e5ea7fb7c65397eab9ba3f4e69b0beff80d59aaf",
    "runner/Cargo.lock": "809b81962dbabf3aa3dce11aa4a4b3384c55f31d",
    "runner/crates/runner-core/Cargo.toml": "08ded319dbaf35e7d63e143f6dd0fc9a3a24388f",
    "package.json": "ae8b5a3ad0d89e3e2bc387fca1a3d11676212ac0",
    "rust-toolchain.toml": "cf01515b3a12ae24e658a2a30c47b2d4b8f97dfb",
    "protocol": "3acc326f96d180a51a82668d7acd7adbe55b0155",
    "protocol/manifest.json": "b0c918e3514e8f1d6a32a6bdcdd069db840a7622",
    "generated/semantic-action-catalog.json": "10800237d17af2eb0839220f98c8ec58a49bce83",
    "antigravity-distributions.json": "c6836e59b9888d99cfdfe0f8f48c01a5f566ff33",
    "scripts": "811ef12892e752dfd59fddb4a7c7765eb2cdac36",
    "acpx-profiles.json": "a3993363cd05df1c158ede0ba798d10506cceaec",
    "cursor-distributions.json": "c049c080192c62f9300953d7a28f617e45555812",
    "cursor-contract.json": "a7f8eca443cd7bbaf094da808be0650edf063db9",
    "src/drivers/acpx/kimi-closure-pins.ts": "f7942c01f1eaa18c592c41344f15710b0507732c"
  },
  "runtimeVersions": {
    "node": "v26.4.0\n",
    "pnpm": "9.15.4\n",
    "rustc": "rustc 1.97.1 (8bab26f4f 2026-07-14)\nbinary: rustc\ncommit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452\ncommit-date: 2026-07-14\nhost: x86_64-unknown-linux-gnu\nrelease: 1.97.1\nLLVM version: 22.1.6\n",
    "cargo": "cargo 1.97.1 (c980f4866 2026-06-30)\nrelease: 1.97.1\ncommit-hash: c980f4866141969fab6254a680546a277789d6f0\ncommit-date: 2026-06-30\nhost: x86_64-unknown-linux-gnu\nlibgit2: 1.9.2 (sys:0.20.4 vendored)\nlibcurl: 8.20.0-DEV (sys:0.4.88+curl-8.20.0 vendored ssl:OpenSSL/3.6.2)\nssl: OpenSSL 3.6.2 7 Apr 2026\nos: Ubuntu 24.4.0 (noble) [64-bit]\n"
  },
  "rustcVersion": "rustc 1.97.1 (8bab26f4f 2026-07-14)\nbinary: rustc\ncommit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452\ncommit-date: 2026-07-14\nhost: x86_64-unknown-linux-gnu\nrelease: 1.97.1\nLLVM version: 22.1.6\n",
  "cargoVersion": "cargo 1.97.1 (c980f4866 2026-06-30)\nrelease: 1.97.1\ncommit-hash: c980f4866141969fab6254a680546a277789d6f0\ncommit-date: 2026-06-30\nhost: x86_64-unknown-linux-gnu\nlibgit2: 1.9.2 (sys:0.20.4 vendored)\nlibcurl: 8.20.0-DEV (sys:0.4.88+curl-8.20.0 vendored ssl:OpenSSL/3.6.2)\nssl: OpenSSL 3.6.2 7 Apr 2026\nos: Ubuntu 24.4.0 (noble) [64-bit]\n",
  "effectiveRustEnvironment": {
    "RUSTUP_TOOLCHAIN": "1.97.1",
    "CARGO_TARGET_DIR": null,
    "RUSTFLAGS": null,
    "CARGO_ENCODED_RUSTFLAGS": null,
    "CARGO_BUILD_TARGET": null,
    "releaseProfile": "Cargo defaults; no custom target/features"
  },
  "metadata": {
    "binaryContractVersion": 2,
    "binaryName": "paperclip-runnerd",
    "durableSessionCapabilities": [
      "unlimited_runtime",
      "connection_lease_renewal"
    ],
    "externalProviderCapabilities": [
      "openai_dot_mcp",
      "grok_bot_mcp",
      "muse_external_v1"
    ],
    "harnessDriverVersion": 1,
    "nativeExecutionVersion": 1,
    "packageName": "@paperclipai/paperclip-runner",
    "packageVersion": "0.0.0",
    "providerPacks": [],
    "prp": {
      "maximumVersion": 2,
      "minimumVersion": 1,
      "name": "paperclip.runner"
    },
    "prpTransportModes": [
      "dial_ws_loopback",
      "dial_wss",
      "listen_ws"
    ],
    "schema": "paperclip-runner/runnerd-build-metadata/v1"
  }
};

const OLD_INVENTORIES = Object.freeze({
  B0: { manifestFileSha256: 'de7f87acba29b26cdd76367f1358aef5d1fb3bcb967c2eed027d266d04dce3ad', aggregateSha256: 'bd14772d45fcbabc9d66582e27400a9cfe2cdfbeb40eccbc372428d3edf9102d' },
  B1: { manifestFileSha256: '5dd499b896425a9afc5776c2e76214027a9d146f2ee32f8554e7fe9873f1b7bc', aggregateSha256: 'ebd636a5e5180f3eb6b9d8c1ade33c73d969e9c116e83d1c3326aa5ed7188ae5' },
});
const LOCK_SHA256 = '54a81b2ed3f1f85eaa085c034560ac248e384db34fbc7aba8c5a3846c29b3ce8';
const GATES_SHA256 = 'ded8bcbb8f05732348f6520b9c5e41b7c35bc098997eb263a9dcb174eede75fc';
const selfFile = fileURLToPath(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const getJson = async file => JSON.parse(await readFile(file, 'utf8'));
const saveJson = async (file, value, fresh = false) => writeFile(file, JSON.stringify(value, null, 2) + '\n', fresh ? { flag: 'wx' } : undefined);
const digest = (value, name) => assert.ok(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `Missing exact ${name} SHA-256`);
const revision = (value, name) => assert.ok(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value), `Missing immutable full ${name} revision`);
const absolute = (value, name) => assert.ok(typeof value === 'string' && path.isAbsolute(value), `Missing absolute ${name} path`);
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);

export function stagePlan(stage) {
  assert.ok(STAGES.includes(stage) || stage === FINALIZE_STAGE, 'Select one registered H5 stage');
  if (stage === FINALIZE_STAGE) return { stage, requiredVariants: ['B0', 'B1', 'B2'], priorStages: [...STAGES], fullArms: 0, finalizationOnly: true };
  const [baseline, candidate] = stage === STAGES[0] ? ['B0', 'B0'] : stage === STAGES[1] ? ['B1', 'B1']
    : stage === STAGES[2] ? ['B0', 'B1'] : stage === STAGES[3] ? ['B1', 'B2'] : ['B0', 'B2'];
  const aa = baseline === candidate;
  return { stage, baseline, candidate, aa, expectation: stage === STAGES[2] ? 'nonregression' : 'improvement',
    candidatePolicy: aa ? null : stage === STAGES[2] ? 'cursor-nonregression' : 'final-b2',
    requiredVariants: [...new Set([baseline, candidate])], priorStages: STAGES.slice(0, STAGES.indexOf(stage)),
    pairs: 5, fullArms: 10, noiseStage: aa ? null : `browser-aa-${baseline.toLowerCase()}` };
}

async function hashedJson(file, expected, name, compressed = false) {
  absolute(file, name); digest(expected, name);
  const bytes = await readFile(file); assert.equal(hash(bytes), expected, `${name} bytes changed`);
  return { bytes, value: JSON.parse((compressed ? gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }) : bytes).toString('utf8')) };
}

// Native equivalence is computed from qualified inputs/configuration, never
// from an optimization label. Both B2 modes use an independent frozen target.
function validateNativeProvenance(receipt, native) {
  const reference = CF_NATIVE_PROVENANCE;
  const record = (value, name) => assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Missing native ${name}`);
  const text = (value, name) => assert.ok(typeof value === 'string' && value.trim().length > 0, `Missing native ${name}`);
  record(receipt.rustInputObjects, 'input objects');
  assert.deepEqual(Object.keys(receipt.rustInputObjects).sort(), Object.keys(reference.rustInputObjects).sort(), 'Native qualification requires the complete exact fifteen input paths');
  for (const [file, object] of Object.entries(receipt.rustInputObjects)) revision(object, `Native input ${file}`);
  record(receipt.runtimeVersions, 'toolchain versions');
  assert.deepEqual(Object.keys(receipt.runtimeVersions).sort(), Object.keys(reference.runtimeVersions).sort(), 'Native qualification requires the complete toolchain version record');
  for (const [name, value] of Object.entries(receipt.runtimeVersions)) text(value, `${name} version`);
  text(receipt.rustcVersion, 'rustc version'); text(receipt.cargoVersion, 'cargo version');
  assert.equal(receipt.rustcVersion, receipt.runtimeVersions.rustc, 'Native rustc version records disagree');
  assert.equal(receipt.cargoVersion, receipt.runtimeVersions.cargo, 'Native Cargo version records disagree');
  record(receipt.effectiveRustEnvironment, 'compilation environment');
  assert.deepEqual(Object.keys(receipt.effectiveRustEnvironment).sort(), Object.keys(reference.effectiveRustEnvironment).sort(), 'Native compilation configuration is incomplete or contains unreviewed fields');
  for (const [name, value] of Object.entries(receipt.effectiveRustEnvironment)) {
    if (name === 'releaseProfile' || name === 'RUSTUP_TOOLCHAIN') text(value, name);
    else assert.ok(value === null || typeof value === 'string', `Invalid native compilation configuration: ${name}`);
  }
  const shape = (actual, expected, name) => {
    if (Array.isArray(expected)) {
      assert.ok(Array.isArray(actual) && actual.every(value => typeof value === 'string' && value.length > 0), `Invalid native metadata ${name}`);
      assert.equal(new Set(actual).size, actual.length, `Duplicate native metadata ${name}`);
    } else if (expected && typeof expected === 'object') {
      record(actual, `metadata ${name}`);
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `Invalid native metadata fields: ${name}`);
      for (const key of Object.keys(expected)) shape(actual[key], expected[key], `${name}.${key}`);
    } else if (typeof expected === 'number') assert.ok(Number.isSafeInteger(actual) && actual > 0, `Invalid native metadata ${name}`);
    else text(actual, `metadata ${name}`);
  };
  shape(native.metadata, reference.metadata, 'runnerd');
  for (const name of ['schema', 'binaryName', 'packageName']) assert.equal(native.metadata[name], reference.metadata[name], `Native metadata ${name} is not the qualified Runner contract`);
  assert.ok(native.metadata.prp.minimumVersion <= native.metadata.prp.maximumVersion, 'Invalid native PRP version interval');
  const actual = Object.fromEntries(Object.keys(reference).map(key => [key, key === 'metadata' ? native.metadata : receipt[key]]));
  return isDeepStrictEqual(actual, reference) ? 'unchanged-native-inputs' : 'changed-native-inputs';
}

export async function validateVariantBuild(variant, descriptor) {
  assert.ok(descriptor && typeof descriptor === 'object', `Required ${variant} qualified build is missing`);
  absolute(descriptor.appRoot, `${variant} appRoot`); revision(descriptor.revision, variant);
  digest(descriptor.binarySha256, `${variant} binary`); revision(descriptor.rustSourceTree, `${variant} Rust source tree`);
  const receipt = (await hashedJson(descriptor.qualifiedReceiptFile, descriptor.qualifiedReceiptSha256, `${variant} qualified receipt`)).value;
  const summary = (await hashedJson(descriptor.inventorySummaryFile, descriptor.inventorySummarySha256, `${variant} inventory summary`)).value;
  const manifest = (await hashedJson(descriptor.manifestFile, descriptor.manifestFileSha256, `${variant} inventory manifest`, true)).value;
  digest(descriptor.aggregateSha256, `${variant} aggregate inventory`);
  const rows = receipt.results?.filter(row => row.variant === variant);
  assert.equal(rows?.length, 1, `${variant} qualified receipt must select this variant exactly once`);
  assert.equal(rows[0].revision, descriptor.revision, `${variant} qualified receipt revision mismatch`);
  assert.equal(rows[0].compiledBuildRevision, descriptor.revision, `${variant} qualified compiled revision mismatch`);
  assert.equal(rows[0].sourceClean, true, `${variant} qualified source was not clean`);
  const native = receipt.nativeStageHashes?.filter(row => row.variant === variant);
  assert.equal(native?.length, 1, `${variant} qualified native stage is missing`);
  assert.equal(native[0].binarySha256, descriptor.binarySha256, `${variant} native stage binary mismatch`);
  assert.equal(receipt.binarySha256, descriptor.binarySha256, `${variant} receipt binary mismatch`);
  assert.equal(receipt.rustSourceTree, descriptor.rustSourceTree, `${variant} Rust source identity mismatch`);
  assert.equal(receipt.rustInputObjects?.runner, descriptor.rustSourceTree, `${variant} qualified Rust input objects are missing`);
  absolute(native[0].targetRealPath, `${variant} qualified native target`);
  for (const [file, object] of Object.entries(receipt.rustInputObjects)) {
    assert.ok(file && !path.posix.isAbsolute(file) && path.posix.normalize(file) === file && !file.includes('\\') && !file.split('/').includes('..'), 'Qualified Rust input path is invalid');
    revision(object, `${variant} Rust input ${file}`);
  }
  assert.equal(receipt.artifactInventorySummary, descriptor.qualifiedInventorySummaryReference ?? descriptor.inventorySummaryFile, `${variant} receipt points to another inventory summary`);
  assert.equal(manifest.variant, variant); assert.equal(manifest.revision, descriptor.revision);
  assert.equal(manifest.compiledBuildRevision, descriptor.revision); assert.equal(manifest.aggregateSha256, descriptor.aggregateSha256);
  assert.deepEqual(manifest.roots, INVENTORY_ROOTS);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === manifest.fileCount && manifest.fileCount > 0);
  const row = summary.inventories?.[variant]; assert.ok(row, `${variant} inventory summary entry missing`);
  assert.equal(row.manifest, path.basename(descriptor.manifestFile)); assert.equal(row.manifestSha256, descriptor.manifestFileSha256);
  assert.equal(row.aggregateSha256, descriptor.aggregateSha256); assert.equal(row.fileCount, manifest.fileCount);
  if (Object.hasOwn(BASELINES, variant)) {
    assert.equal(descriptor.revision, BASELINES[variant], 'Original baseline reference must remain unchanged');
    assert.equal(descriptor.qualifiedReceiptSha256, OLD_RECEIPT, 'B0/B1 must use the original, unmodified alignedCF qualified receipt');
    assert.equal(descriptor.inventorySummarySha256, OLD_SUMMARY); assert.equal(descriptor.binarySha256, OLD_BINARY);
    assert.equal(descriptor.rustSourceTree, OLD_RUST);
    for (const [key, value] of Object.entries(OLD_INVENTORIES[variant])) assert.equal(descriptor[key], value, `Original ${variant} inventory changed`);
  } else {
    assert.equal(variant, 'B2');
    assert.equal(descriptor.revision, B2_REVISION, 'B2 must use the reviewed current TypeScript batching source revision');
    assert.notEqual(descriptor.qualifiedReceiptSha256, OLD_RECEIPT, 'B2 needs its own fresh qualified production-build receipt');
    assert.equal(receipt.oldRustTargetNotReused, true, 'B2 build must attest that no baseline native target was reused');
    assert.equal(receipt.newSharedTarget, native[0].targetRealPath, 'B2 build receipt must bind its own independent native target');
    assert.equal(path.posix.normalize(native[0].targetRealPath), native[0].targetRealPath, 'B2 native target must be a normalized canonical path');
    for (const frozenTarget of [OLD_NATIVE_TARGET, CF_NATIVE_TARGET])
      assert.ok(native[0].targetRealPath !== frozenTarget && !native[0].targetRealPath.startsWith(frozenTarget + '/') && !frozenTarget.startsWith(native[0].targetRealPath + '/'), 'B2 requires an independent native target outside both immutable baseline target trees');
    validateNativeProvenance(receipt, native[0]);
  }
  return { receipt, summary, manifest };
}

// Match the existing inventory generator and H5 helper exactly: Unicode code
// point order, Python ensure_ascii JSON with sorted bytes/path/sha256 keys.
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
function inventoryPath(value) {
  assert.ok(typeof value === 'string' && value.length && !value.includes('\\') && !value.includes('\0')
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.split('/').includes('..')
    && INVENTORY_ROOTS.some(root => value.startsWith(`${root}/`)), 'Inventory filename escapes registered roots');
  return value;
}
export async function validateActualInventory(build, manifest) {
  const startedAtMs = Date.now(), started = performance.now(), canonicalRoot = await realpath(build.appRoot);
  assert.deepEqual(manifest.roots, INVENTORY_ROOTS);
  const expected = new Map(), canonicalFiles = new Set();
  for (const row of manifest.files) {
    const name = inventoryPath(row.path);
    assert.equal(expected.has(name), false, 'Duplicate inventory filename'); expected.set(name, row);
    digest(row.sha256, 'inventory file'); assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0);
  }
  assert.equal(expected.size, manifest.fileCount, 'Inventory file count is incomplete');
  const actualNames = [], canonicalDirectories = new Set();
  const walk = async relative => {
    const directory = path.join(build.appRoot, relative), canonical = await realpath(directory);
    assert.ok(canonical.startsWith(`${canonicalRoot}${path.sep}`), 'Inventory directory resolves outside APP_ROOT');
    assert.equal(canonicalDirectories.has(canonical), false, 'Inventory directory aliases another registered directory'); canonicalDirectories.add(canonical);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else {
        const file = path.join(build.appRoot, child), metadata = await lstat(file);
        if (metadata.isSymbolicLink()) assert.equal((await stat(file)).isDirectory(), false, 'Inventory directory symlink is not a frozen file');
        assert.ok(metadata.isFile() || metadata.isSymbolicLink(), 'Inventory includes a nonregular entry');
        inventoryPath(child); actualNames.push(child);
      }
    }
  };
  for (const root of INVENTORY_ROOTS) await walk(root);
  actualNames.sort(pythonOrder);
  assert.deepEqual(actualNames, [...expected.keys()].sort(pythonOrder), 'Actual APP_ROOT file set differs from frozen inventory');
  const actualRows = new Array(actualNames.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, actualNames.length) }, async () => {
    for (;;) {
      const index = next++; if (index >= actualNames.length) return;
      const name = actualNames[index], file = path.join(build.appRoot, name), canonical = await realpath(file);
      assert.ok(canonical.startsWith(`${canonicalRoot}${path.sep}`), 'Inventory file resolves outside APP_ROOT');
      assert.equal(canonicalFiles.has(canonical), false, 'Inventory filenames alias the same canonical file'); canonicalFiles.add(canonical);
      const before = await stat(file); assert.ok(before.isFile(), 'Inventory evidence must be a regular file');
      const content = createHash('sha256'); for await (const bytes of createReadStream(file)) content.update(bytes);
      const after = await stat(file);
      assert.equal(after.size, before.size, 'Artifact changed during inventory hashing'); assert.equal(after.mtimeMs, before.mtimeMs, 'Artifact changed during inventory hashing');
      const row = { bytes: after.size, path: name, sha256: content.digest('hex') }, frozen = expected.get(name);
      assert.equal(row.bytes, frozen.bytes, `Actual artifact size changed: ${name}`); assert.equal(row.sha256, frozen.sha256, `Actual artifact bytes changed: ${name}`);
      actualRows[index] = row;
    }
  }));
  const aggregateSha256 = hash(Buffer.from(`${actualRows.map(pythonRow).join('\n')}\n`, 'utf8'));
  assert.equal(aggregateSha256, manifest.aggregateSha256, 'Actual APP_ROOT aggregate differs from frozen inventory');
  assert.equal(aggregateSha256, build.aggregateSha256, 'Actual APP_ROOT aggregate differs from qualified build');
  return { appRoot: build.appRoot, canonicalAppRoot: canonicalRoot, fileCount: actualRows.length, aggregateSha256,
    startedAtMs, completedAtMs: Date.now(), elapsedMs: performance.now() - started,
    scope: 'Live registered file set, canonical containment/uniqueness, size and SHA checked before this arm; not an assertion of future immutability' };
}

function harnessFields(release) {
  return Object.fromEntries(['harnessRevision', 'protocolSha256', 'comparatorSha256', 'inventoryHelperSha256', 'protocolDocumentSha256', 'lockSha256', 'gatesSha256', 'workloadSha256', 'observationMode', 'protocolVersion'].map(key => [key, release[key]]));
}

export async function loadRelease(releaseFile, stage, outputRoot) {
  absolute(releaseFile, 'root release'); absolute(outputRoot, 'output root');
  const releaseBytes = await readFile(releaseFile), release = JSON.parse(releaseBytes);
  const plan = stagePlan(stage);
  assert.equal(release.authorized, true, 'Root release is not authorized'); assert.equal(release.stage, stage);
  assert.equal(release.outputRoot, outputRoot, 'Root release freezes a different exact output path');
  assert.equal(release.orchestratorSha256, hash(await readFile(selfFile)), 'Orchestrator changed after release');
  absolute(release.harnessRoot, 'H5 harness'); revision(release.harnessRevision, 'H5 harness');
  assert.equal(release.harnessRevision, H5_REVISION, 'Use the actual independently frozen H5 full revision');
  assert.equal(release.observationMode, MODE); assert.equal(release.protocolVersion, PROTOCOL);
  assert.equal(release.workloadSha256, WORKLOAD_SHA256);
  assert.equal(release.resourceWatchdogMillis, RESOURCE_WATCHDOG_MILLIS, 'Resource watchdog registration changed; this is not an SLA');
  assert.equal(release.lockSha256, LOCK_SHA256); assert.equal(release.gatesSha256, GATES_SHA256);
  for (const [key, expected] of [['protocolSha256', H5_PROTOCOL_SHA256], ['comparatorSha256', H5_COMPARATOR_SHA256], ['inventoryHelperSha256', H5_INVENTORY_HELPER_SHA256], ['protocolDocumentSha256', H5_PROTOCOL_DOCUMENT_SHA256]])
    assert.equal(release[key], expected, `Reviewed H5 source pin changed: ${key}`);
  for (const variant of plan.requiredVariants) await validateVariantBuild(variant, release.perVariantBuilds?.[variant]);
  const context = { releaseFile, releaseBytesSha256: hash(releaseBytes), release, plan, out: outputRoot, commands: [], commandIndex: 0 };
  await checkPriorStages(context);
  if (plan.noiseStage) await checkNoise(context);
  if (plan.finalizationOnly) await checkFinalizationInputs(context);
  return context;
}

async function checkReleaseBytes(context) {
  assert.equal(hash(await readFile(context.releaseFile)), context.releaseBytesSha256, 'Exact root release bytes changed');
  assert.equal(hash(await readFile(selfFile)), context.release.orchestratorSha256, 'Orchestrator changed after release');
  if (context.rootReleaseCopy) assert.equal(hash(await readFile(context.rootReleaseCopy)), context.releaseBytesSha256, 'Preserved root release bytes changed');
}

function checkComparisonIdentity(report, context) {
  assert.equal(report.complete, true); assert.equal(report.observationMode, MODE); assert.equal(report.protocolVersion, PROTOCOL);
  assert.equal(report.workloadSha256, WORKLOAD_SHA256); assert.equal(report.measurementSha256, context.release.protocolSha256);
  assert.equal(report.comparatorSha256, context.release.comparatorSha256); assert.equal(report.gatesSha256, GATES_SHA256);
  assert.equal(report.pairCount, 5);
}

export function assertAaNoiseSuitability(noise) {
  assert.equal(noise.aaSuitability?.passed, true, 'Unsuitable or missing browser A/A cannot freeze noise');
  assert.deepEqual(noise.aaSuitability.rule, { pairCount: 5, pairedFraction: 0.20, medianDriftFraction: 0.10,
    contrastRepresentationFloorMs: 2, representationLimitedMedianMs: 20 }, 'Browser A/A suitability rule changed');
  const keys = [];
  for (const name of ['paced', 'burst16', 'burst128', 'burst512', 'existing-history', 'operator-stop']) {
    keys.push(...['firstVisibleAfterEmissionMs', 'emissionToVisible.medianMs', 'drainThroughTerminalMs'].map(metric => `${name}:${metric}`));
    if (name === 'paced') keys.push(`${name}:interChunkGaps.maxMs`);
    if (!['burst16', 'operator-stop'].includes(name)) keys.push(`${name}:emissionToVisible.p95Ms`, `${name}:intendedToVisible.p95Ms`);
    if (name === 'operator-stop') keys.push(`${name}:stopThroughTerminalMs`, `${name}:stopThroughAcknowledgementMs`);
    else keys.push(`${name}:h5.independentDrain.elapsedFromEpochMs`);
  }
  const rows = noise.measurements;
  assert.ok(Array.isArray(rows), 'Browser A/A measurements are missing');
  // The frozen comparator adds both Stop p95 metrics only for a >=100-marker
  // observed Stop prefix. Its owning raw validation remains authoritative.
  if (rows.some(row => row.name === 'operator-stop' && ['emissionToVisible.p95Ms', 'intendedToVisible.p95Ms'].includes(row.metric)))
    keys.push('operator-stop:emissionToVisible.p95Ms', 'operator-stop:intendedToVisible.p95Ms');
  assert.deepEqual(rows.map(row => `${row.name}:${row.metric}`).sort(), keys.sort(), 'Browser A/A metric set changed or verified completion metric is missing');
  assert.equal(noise.aaSuitability.metricCount, keys.length, 'Browser A/A metric count changed');
  for (const row of rows) {
    assert.equal(row.aaSuitability?.passed, true, 'Every browser A/A measurement must pass suitability');
    assert.equal(row.aaSuitability.pairCount, 5); assert.equal(row.aaSuitability.sampleCount, 10);
    assert.equal(row.samples?.length, 5, 'Every browser A/A metric needs five pairs');
    for (const key of ['aaNoiseEnvelopeRelative', 'aaNoiseEnvelopeAbsoluteMs'])
      assert.ok(Number.isFinite(row[key]) && row[key] >= 0, 'Browser A/A actual noise must be finite and nonnegative');
    assert.equal(row.aaNoiseEnvelopeRelative, row.aaSuitability.observedNoiseRelative, 'Browser A/A relative noise changed');
    assert.equal(row.aaNoiseEnvelopeAbsoluteMs, row.aaSuitability.observedNoiseAbsoluteMs, 'Browser A/A absolute noise changed');
  }
}

async function checkPriorStages(context) {
  for (const stage of context.plan.priorStages) {
    const pin = context.release.priorStageReports?.[stage]; assert.ok(pin, `Stage order requires frozen ${stage} first`);
    assert.equal(pin.file, path.join(context.out, `${stage}.json`), 'Prior stage report path changed');
    const report = (await hashedJson(pin.file, pin.sha256, stage)).value;
    checkComparisonIdentity(report, context);
    const priorPlan = stagePlan(stage);
    assert.equal(report.phase, priorPlan.aa ? 'aa' : 'compare');
    if (priorPlan.aa) assertAaNoiseSuitability(report);
    assert.equal(report.baselineRevision, BASELINES[priorPlan.baseline]);
    const candidateRevision = BASELINES[priorPlan.candidate] ?? context.release.perVariantBuilds.B2?.revision;
    assert.equal(report.candidateRevision, candidateRevision, 'Prior stage used a different measured candidate revision');
    for (const [arm, variant] of [['baseline', priorPlan.baseline], ['candidate', priorPlan.candidate]]) {
      const expected = context.release.perVariantBuilds?.[variant] ?? (BASELINES[variant] ? { ...OLD_INVENTORIES[variant], qualifiedReceiptSha256: OLD_RECEIPT, inventorySummarySha256: OLD_SUMMARY } : undefined);
      assert.ok(expected, 'Prior candidate qualified build is unavailable');
      for (const key of ['manifestFileSha256', 'aggregateSha256', 'qualifiedReceiptSha256', 'inventorySummarySha256'])
        assert.equal(report.artifactInventories?.[arm]?.[key], expected[key], 'Prior stage changed a measured qualified inventory');
    }
    if (!priorPlan.aa) assert.equal(report.performancePassed, true, `Prior ${stage} performance failed`);
  }
}

export async function checkNoise(context) {
  const { release, plan, out } = context;
  const expected = path.join(out, `${plan.noiseStage}.json`);
  assert.equal(release.noiseReportFile, expected, 'Use the same exact frozen A/A noise path');
  const noise = (await hashedJson(expected, release.noiseReportSha256, 'Reviewed A/A noise report')).value;
  checkComparisonIdentity(noise, context); assert.equal(noise.phase, 'aa');
  assert.equal(noise.baselineRevision, release.perVariantBuilds[plan.baseline].revision);
  assert.equal(noise.candidateRevision, noise.baselineRevision);
  assert.equal(noise.h5Assessments?.length, 5, 'Reviewed A/A must contain all five complete assessments');
  assertAaNoiseSuitability(noise);
  const build = release.perVariantBuilds[plan.baseline];
  for (const arm of ['baseline', 'candidate']) for (const key of ['manifestFileSha256', 'aggregateSha256', 'qualifiedReceiptSha256', 'inventorySummarySha256'])
    assert.equal(noise.artifactInventories?.[arm]?.[key], build[key], 'Frozen A/A baseline inventory differs from required build');
  return noise;
}

const QUIET_SETTLE_MILLIS = 30_000, QUIET_POLL_MILLIS = 1_000, QUIET_PS_TIMEOUT_MILLIS = 2_000;
const QUIET_SCHEMA = 'paperclip.native-ingestion.physical-quiet.v1';
const QUIET_SCOPE = 'Dedicated Linux process-name guard for specified Node/PostgreSQL/Runner/browser/Rust-build names only; not a claim that every possible host activity is absent. Qualified H5 Stop proof separately covers provider/sleep control groups.';
const QUIET_ZOMBIE_POLICY = 'Strict: matched zombie/dead rows remain blockers until absent; no automatic killing or silent zombie exclusion.';
function processFamily(comm) {
  if (/^(node|node-MainThread)$/.test(comm)) return 'node';
  if (/^(postgres|postmaster|pg_ctl|initdb)$/.test(comm)) return 'postgresql';
  if (/^(paperclip-runne|paperclip-runner.*|Runner)$/.test(comm)) return 'runner';
  if (/^(chrome|headless|chromium)/i.test(comm)) return 'browser';
  if (/^(rustc|cargo)$/.test(comm)) return 'rust-build';
  return null;
}
export function classifyLinuxProcesses(text, orchestratorPid = process.pid) {
  assert.ok(typeof text === 'string' && text.trim(), 'Linux ps returned no process rows');
  assert.ok(Number.isSafeInteger(orchestratorPid) && orchestratorPid > 0, 'Invalid orchestrator PID');
  const seen = new Set(), matched = []; let rowCount = 0;
  for (const line of text.trim().split(/\r?\n/)) {
    const fields = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s+([DIRSTtWXZPK])\s*$/);
    assert.ok(fields, 'Malformed Linux ps PID/PPID/comm/state row');
    const row = { pid: Number(fields[1]), ppid: Number(fields[2]), comm: fields[3].trim(), state: fields[4] };
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.ppid) && row.ppid >= 0 && row.comm.length > 0 && row.comm.length <= 256 && !row.comm.includes('\0'), 'Malformed Linux ps process fields');
    assert.equal(seen.has(row.pid), false, 'Duplicate Linux ps PID'); seen.add(row.pid); rowCount++;
    const family = processFamily(row.comm);
    if (family) matched.push({ ...row, family, allowed: row.pid === orchestratorPid && !['Z', 'X'].includes(row.state) });
  }
  assert.ok(seen.has(orchestratorPid), 'Linux ps omitted the current orchestrator PID');
  return { rowCount, matched, blockers: matched.filter(row => !row.allowed) };
}
function linuxProcessRows(timeoutMillis) {
  return execFileSync('/bin/ps', ['-eo', 'pid=,ppid=,comm=,state='], {
    encoding: 'utf8', timeout: timeoutMillis, maxBuffer: 2 * 1024 * 1024, env: { LC_ALL: 'C' },
  });
}
export async function physicalQuietGuard({ receiptFile, phase, armStage, primaryFailureAlreadyPresent = false,
  platform = process.platform, orchestratorPid = process.pid, readPs = linuxProcessRows,
  now = () => performance.now(), pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
  absolute(receiptFile, 'physical quiet receipt');
  const started = now(), receipt = { schema: QUIET_SCHEMA, scope: QUIET_SCOPE, phase, armStage, platform, orchestratorPid,
    fields: ['pid', 'ppid', 'comm', 'state'], zombiePolicy: QUIET_ZOMBIE_POLICY,
    resourceSettleLimitMillis: QUIET_SETTLE_MILLIS, pollIntervalMillis: QUIET_POLL_MILLIS, psTimeoutMillis: QUIET_PS_TIMEOUT_MILLIS,
    primaryFailureAlreadyPresent, startedAtMs: Date.now(), passed: false, observations: [] };
  let failure;
  try {
    assert.equal(platform, 'linux', 'Accepted H5 physical quiet guard requires Linux');
    assert.ok(['pre-arm', 'post-arm'].includes(phase), 'Unknown physical quiet phase');
    for (;;) {
      const remaining = QUIET_SETTLE_MILLIS - (now() - started);
      assert.ok(remaining > 0, 'Physical quiet settle deadline expired; stop for cleanup');
      const observed = classifyLinuxProcesses(readPs(Math.max(1, Math.min(QUIET_PS_TIMEOUT_MILLIS, Math.floor(remaining)))), orchestratorPid);
      receipt.observations.push({ atMs: Date.now(), elapsedMillis: now() - started, ...observed });
      assert.ok(now() - started < QUIET_SETTLE_MILLIS, 'Physical quiet settle deadline expired; stop for cleanup');
      if (observed.blockers.length === 0) { receipt.passed = true; break; }
      const wait = Math.min(QUIET_POLL_MILLIS, QUIET_SETTLE_MILLIS - (now() - started));
      assert.ok(wait > 0, 'Physical quiet settle deadline expired; stop for cleanup');
      await pause(wait);
    }
  } catch (error) {
    failure = error;
    receipt.failure = { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) };
  }
  receipt.completedAtMs = Date.now(); receipt.elapsedMillis = now() - started;
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
  await writeFile(receiptFile, bytes, { flag: 'wx' });
  const result = { file: receiptFile, bytes: bytes.length, sha256: hash(bytes), passed: receipt.passed };
  if (failure) {
    const error = new Error(`Physical quiet guard failed (${phase}); receipt=${receiptFile}; sha256=${result.sha256}`, { cause: failure });
    Object.assign(error, { receiptFile, receiptSha256: result.sha256 }); throw error;
  }
  return result;
}
export async function assertNoPreferredUiShadow(appRoot, statPath = lstat) {
  const preferredIndex = path.join(appRoot, 'server/ui-dist/index.html'), preferredDirectory = path.dirname(preferredIndex);
  try { await statPath(preferredIndex); assert.fail('Preferred server/ui-dist/index.html exists (including a symlink); ui/dist inventory cannot attest the selected UI'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { assert.equal((await statPath(preferredDirectory)).isSymbolicLink(), false, 'Preferred server/ui-dist directory symlink prevents the absence guard'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { checkedAtMs: Date.now(), preferredIndex, preferredIndexAbsent: true, preferredDirectorySymlink: false,
    selectedUiRoot: path.join(appRoot, 'ui/dist'),
    assumption: 'Preferred server/ui-dist index absent at preflight; inventoried ui/dist is the compiled fallback. No routing/build changes or future immutability claim.' };
}

export async function validateRuntimeChecks(checks, workingDirectory, environment = process.env,
  { run = execFileSync, resolve = realpath, currentExecutable = process.execPath } = {}) {
  const names = ['node', 'pnpm', 'postgres', 'chromium', 'rustc', 'cargo'];
  const receipt = { checkedAtMs: Date.now(), cwd: workingDirectory, PATH: environment.PATH, passed: false, checks: {} };
  try {
    absolute(workingDirectory, 'Runtime check APP cwd');
    assert.ok(checks && typeof checks === 'object' && !Array.isArray(checks), 'Missing exact six runtime checks');
    assert.deepEqual(Object.keys(checks).sort(), [...names].sort(), 'Runtime checks must contain exactly the six approved labels');
    for (const name of names) {
      const check = checks[name];
      assert.ok(check && typeof check === 'object' && !Array.isArray(check), `Missing runtime check ${name}`);
      absolute(check.executable, `Runtime ${name} executable`);
      assert.ok(Array.isArray(check.args) && check.args.length > 0 && check.args.every(value => typeof value === 'string'), `Missing runtime ${name} args`);
      assert.ok(typeof check.expected === 'string' && check.expected.length > 0 && check.expected === check.expected.trim(), `Missing runtime ${name} expected output`);
    }
    assert.equal(checks.node.expected, 'v26.4.0', 'Use the qualified Node version');
    assert.equal(checks.pnpm.expected, '9.15.4', 'Use the qualified package-manager version');
    receipt.canonicalCwd = await resolve(workingDirectory);
    receipt.pathNode = await assertPathNode(environment, checks.node.executable, workingDirectory, { run, resolve, currentExecutable });
    for (const name of names) {
      const check = checks[name], canonicalExecutable = await resolve(check.executable);
      const row = receipt.checks[name] = { ...check, approvedExecutable: check.executable, canonicalExecutable, cwd: workingDirectory, canonicalCwd: receipt.canonicalCwd, actual: null };
      row.actual = run(check.executable, check.args, { cwd: workingDirectory, env: environment, encoding: 'utf8', timeout: 10_000 }).trim();
      assert.equal(row.actual, check.expected, `Runtime ${name} output differs from the frozen release`);
    }
    receipt.passed = true; return receipt;
  } catch (error) { error.runtimePreflight = receipt; throw error; }
}

async function checkFrozen(context, selectedVariant) {
  await checkReleaseBytes(context);
  for (const key of ['DATABASE_URL', 'PAPERCLIP_RUNNER_STATE_DIR', 'PAPERCLIP_INGESTION_SERVER_COMMAND', 'PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR',
    'PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_FS', 'PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_INSPECTOR', 'PAPERCLIP_INGESTION_BROWSER_CAPTURE', 'NODE_OPTIONS'])
    assert.ok(!process.env[key], `Acceptance rejects ambient ${key}`);
  const { release, plan } = context, actualInventories = {};
  const runtimeVariant = selectedVariant ?? plan.requiredVariants[0];
  const runtimeChecks = await validateRuntimeChecks(release.runtimeChecks, release.perVariantBuilds[runtimeVariant].appRoot, process.env);
  for (const variant of plan.requiredVariants) {
    const build = release.perVariantBuilds[variant], qualified = await validateVariantBuild(variant, build);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: build.appRoot, encoding: 'utf8' }).trim(), build.revision, `${variant} SUT revision changed`);
    assert.equal(execFileSync('git', ['status', '--short'], { cwd: build.appRoot, encoding: 'utf8' }).trim(), '', `${variant} SUT is dirty`);
    assert.equal((await getJson(path.join(build.appRoot, 'server/dist/build-info.json'))).commit, build.revision);
    const binaryFile = path.join(build.appRoot, 'packages/paperclip-runner/runner/target/release/paperclip-runnerd');
    const native = qualified.receipt.nativeStageHashes.find(row => row.variant === variant);
    const actualTarget = await realpath(path.join(build.appRoot, 'packages/paperclip-runner/runner/target'));
    assert.equal(await realpath(native.targetRealPath), native.targetRealPath, `${variant} qualified native target is an alias rather than its canonical path`);
    assert.equal(actualTarget, native.targetRealPath, `${variant} actual native target differs from qualified receipt`);
    assert.equal(await realpath(binaryFile), path.join(actualTarget, 'release/paperclip-runnerd'), `${variant} native binary resolves outside its exact qualified target`);
    assert.equal(hash(await readFile(binaryFile)), build.binarySha256, `${variant} actual native binary changed`);
    for (const [file, object] of Object.entries(qualified.receipt.rustInputObjects))
      assert.equal(execFileSync('git', ['rev-parse', `${build.revision}:packages/paperclip-runner/${file}`], { cwd: build.appRoot, encoding: 'utf8' }).trim(), object, `${variant} qualified Rust input changed: ${file}`);
    assert.equal(execFileSync('git', ['rev-parse', `${build.revision}:packages/paperclip-runner/runner`], { cwd: build.appRoot, encoding: 'utf8' }).trim(), build.rustSourceTree);
    if (!selectedVariant || selectedVariant === variant) actualInventories[variant] = {
      ...await validateActualInventory(build, qualified.manifest), uiServing: await assertNoPreferredUiShadow(build.appRoot),
    };
  }
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: release.harnessRoot, encoding: 'utf8' }).trim(), release.harnessRevision);
  assert.equal(execFileSync('git', ['status', '--short'], { cwd: release.harnessRoot, encoding: 'utf8' }).trim(), '');
  assert.equal(hash(Buffer.concat(await Promise.all(protocolFiles.map(file => readFile(path.join(release.harnessRoot, 'tests/e2e', file)))))), release.protocolSha256);
  for (const [file, expected] of [['scripts/compare-native-ingestion-browser.ts', release.comparatorSha256], ['scripts/native-ingestion-h5-inventory.mjs', release.inventoryHelperSha256], ['tests/e2e/fixtures/native-ingestion-h5.md', release.protocolDocumentSha256], ['scripts/native-ingestion-performance-gates.mjs', release.gatesSha256], ['pnpm-lock.yaml', release.lockSha256]])
    assert.equal(hash(await readFile(path.join(release.harnessRoot, file))), expected, `Frozen H5 support changed: ${file}`);
  await checkPriorStages(context);
  if (plan.noiseStage) await checkNoise(context);
  return { checkedAtMs: Date.now(), releaseFileSha256: context.releaseBytesSha256, actualInventories, runtimeChecks };
}

async function execute(context, step) {
  const index = ++context.commandIndex, startedAt = new Date().toISOString(), log = path.join(context.out, `${step.stage}.log`);
  const command = { index, stage: step.stage, cwd: step.cwd, executable: process.execPath, args: step.args, environmentOverrides: step.env ?? {}, startedAt, log,
    resourceWatchdogMillis: RESOURCE_WATCHDOG_MILLIS, resourceWatchdogScope: 'Resource-only cap including startup/test/teardown; original SLA and H5 observation limits remain driver-owned' };
  context.commands.push(command);
  const save = () => saveJson(path.join(context.out, `${context.plan.stage}-commands.json`), context.commands);
  await save(); console.log(`START ${step.stage} ${startedAt}; log=${log}`);
  const stream = (await open(log, 'wx')).createWriteStream();
  const child = spawn(process.execPath, step.args, { cwd: step.cwd, env: step.launchEnvironment ?? { ...process.env, ...step.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  command.childPid = child.pid; await save();
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  let forcedStop;
  const watchdog = setTimeout(() => {
    command.watchdogExpired = true; child.kill('SIGTERM');
    forcedStop = setTimeout(() => { command.forcedDriverKill = true; child.kill('SIGKILL'); }, 30_000);
  }, RESOURCE_WATCHDOG_MILLIS);
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  let exit;
  try { exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); }
  finally { clearTimeout(watchdog); clearTimeout(forcedStop); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); await new Promise(resolve => stream.end(resolve)); }
  Object.assign(command, { finishedAt: new Date().toISOString(), ...exit }); await save();
  console.log(`END ${step.stage} code=${exit.code} signal=${exit.signal ?? 'none'}`);
  assert.equal(command.watchdogExpired, undefined, 'Resource watchdog expired; stop for physical cleanup, never accept or advance');
  assert.equal(exit.code, 0, `Stage ${step.stage} failed; retain raw files and perform physical cleanup before continuing`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function assertPortReleased(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}
async function extractEvidence(directory) {
  const playwrightFile = path.join(directory, 'playwright.json'), report = await getJson(playwrightFile), attachments = [];
  const visit = node => { if (Array.isArray(node)) for (const child of node) visit(child); else if (node && typeof node === 'object') {
    if (Array.isArray(node.attachments)) attachments.push(...node.attachments.filter(value => value.name === 'native-ingestion-evidence'));
    for (const [key, child] of Object.entries(node)) if (key !== 'attachments') visit(child);
  } };
  visit(report); assert.equal(attachments.length, 1, 'Exactly one native-ingestion evidence attachment is required');
  const attachment = attachments[0];
  const evidence = attachment.body ? JSON.parse(Buffer.from(attachment.body, 'base64').toString()) : await getJson(path.resolve(directory, attachment.path));
  const file = path.join(directory, 'native-ingestion-evidence.json'); await saveJson(file, evidence, true);
  return { file, evidence, playwrightFile };
}

async function armSidecar(directory, variant, build) {
  const destination = path.join(directory, 'inventory'); await mkdir(destination);
  const copies = {};
  for (const [key, sha] of [['manifestFile', 'manifestFileSha256'], ['inventorySummaryFile', 'inventorySummarySha256'], ['qualifiedReceiptFile', 'qualifiedReceiptSha256']]) {
    const bytes = await readFile(build[key]); assert.equal(hash(bytes), build[sha], 'Per-arm provenance changed while copying');
    const file = path.join(destination, path.basename(build[key])); await writeFile(file, bytes, { flag: 'wx' }); copies[key] = path.relative(directory, file);
  }
  const sidecar = { schema: 'paperclip.native-ingestion.arm-inventory.v1', variant, sourceRevision: build.revision, compiledBuildRevision: build.revision,
    playwrightReportSha256: hash(await readFile(path.join(directory, 'playwright.json'))), ...copies,
    manifestFileSha256: build.manifestFileSha256, aggregateSha256: build.aggregateSha256,
    qualifiedReceiptSha256: build.qualifiedReceiptSha256, inventorySummarySha256: build.inventorySummarySha256 };
  const file = path.join(directory, 'arm-inventory.json'); await saveJson(file, sidecar, true); return file;
}

async function armArtifactFiles(result) {
  const sidecar = await getJson(result.inventoryFile), base = path.dirname(result.inventoryFile);
  return [result.file, result.playwrightFile, result.inventoryFile,
    ...['manifestFile', 'inventorySummaryFile', 'qualifiedReceiptFile'].map(key => path.resolve(base, sidecar[key])),
    path.join(base, 'pre-arm-inventory-check.json'), path.join(base, 'physical-http-port-check.json'),
    path.join(base, 'physical-quiet-pre.json'), path.join(base, 'physical-quiet-post.json')];
}
export async function sealArmArtifacts(out, result) {
  const canonicalRoot = await realpath(out), files = await armArtifactFiles(result), seen = new Set(), seals = [];
  for (const file of files) {
    absolute(file, 'raw arm artifact'); const canonical = await realpath(file);
    assert.ok(canonical.startsWith(`${canonicalRoot}${path.sep}`), 'Raw arm artifact resolves outside owned output');
    assert.equal(seen.has(canonical), false, 'Duplicate raw arm artifact'); seen.add(canonical);
    const bytes = await readFile(file); seals.push({ file, bytes: bytes.length, sha256: hash(bytes) });
  }
  return seals;
}
export async function verifyRawArtifactSeals(out, manifest) {
  const canonicalRoot = await realpath(out);
  for (const entry of manifest) for (const arm of ['baseline', 'candidate']) {
    const seals = entry[`${arm}Artifacts`]; assert.ok(Array.isArray(seals) && seals.length === 10, 'Raw arm byte seals are incomplete');
    const seen = new Set();
    for (const seal of seals) {
      absolute(seal.file, 'sealed arm artifact'); digest(seal.sha256, 'sealed arm artifact');
      assert.equal(seen.has(seal.file), false, 'Duplicate sealed arm artifact'); seen.add(seal.file);
      assert.ok((await realpath(seal.file)).startsWith(`${canonicalRoot}${path.sep}`), 'Sealed arm artifact resolves outside output');
      const bytes = await readFile(seal.file);
      assert.equal(bytes.length, seal.bytes, 'Raw arm artifact size changed after timing');
      assert.equal(hash(bytes), seal.sha256, 'Raw arm artifact bytes changed after timing');
    }
    const expected = await armArtifactFiles({ file: entry[`${arm}File`], playwrightFile: entry[`${arm}PlaywrightFile`], inventoryFile: entry[`${arm}InventoryFile`] });
    assert.deepEqual([...seen].sort(), expected.sort(), 'Raw seals do not cover this exact evidence/PW/sidecar/inventory set');
    for (const [filename, phase] of [['physical-quiet-pre.json', 'pre-arm'], ['physical-quiet-post.json', 'post-arm']]) {
      const receipt = await getJson(path.join(path.dirname(entry[`${arm}InventoryFile`]), filename));
      assert.equal(receipt.schema, QUIET_SCHEMA); assert.equal(receipt.passed, true); assert.equal(receipt.platform, 'linux');
      assert.equal(receipt.phase, phase); assert.equal(receipt.zombiePolicy, QUIET_ZOMBIE_POLICY);
    }
  }
}

function physicalGuardReferences(manifest) {
  return manifest.flatMap((entry, pair) => ['baseline', 'candidate'].map(arm => ({ pair: pair + 1, arm,
    receipts: entry[`${arm}Artifacts`].filter(seal => /^physical-quiet-(pre|post)\.json$/.test(path.basename(seal.file))) })));
}

export async function assertPathNode(environment, approvedExecutable, workingDirectory,
  { run = execFileSync, resolve = realpath, currentExecutable = process.execPath } = {}) {
  absolute(workingDirectory, 'PATH Node working directory'); absolute(approvedExecutable, 'Approved Node executable');
  assert.ok(typeof environment.PATH === 'string' && environment.PATH.length > 0, 'Actual launch PATH is missing');
  const actual = JSON.parse(run('node', ['-p', 'JSON.stringify({executable:process.execPath,version:process.version,cwd:process.cwd()})'],
    { env: environment, cwd: workingDirectory, encoding: 'utf8', timeout: 10000 }));
  assert.equal(actual.version, 'v26.4.0', 'PATH node version differs from approved VM runtime');
  absolute(actual.executable, 'PATH-selected Node executable'); absolute(actual.cwd, 'PATH-selected Node cwd');
  const canonicalExecutable = await resolve(actual.executable), approvedCanonicalExecutable = await resolve(approvedExecutable);
  assert.equal(canonicalExecutable, approvedCanonicalExecutable, 'PATH node executable differs from approved runtime');
  assert.equal(approvedCanonicalExecutable, await resolve(currentExecutable), 'Approved Node differs from orchestrator runtime');
  const canonicalCwd = await resolve(actual.cwd), approvedCanonicalCwd = await resolve(workingDirectory);
  assert.equal(canonicalCwd, approvedCanonicalCwd, 'PATH node did not run in the actual appRoot cwd');
  return { ...actual, canonicalExecutable, approvedCanonicalExecutable, canonicalCwd, approvedCanonicalCwd,
    PATH: environment.PATH, requestedCwd: workingDirectory };
}

async function browserRun(context, armStage, variant) {
  const preflight = await checkFrozen(context, variant); // ALL receipts; selected live artifact inventory before EVERY arm.
  const { release } = context, build = release.perVariantBuilds[variant], directory = path.join(context.out, armStage);
  await mkdir(directory, { recursive: false });
  await physicalQuietGuard({ receiptFile: path.join(directory, 'physical-quiet-pre.json'), phase: 'pre-arm', armStage });
  const port = await freePort();
  const environmentOverrides = { PAPERCLIP_INGESTION_OBSERVATION_MODE: MODE, PAPERCLIP_RUNNER_BINARY: path.join(build.appRoot, 'packages/paperclip-runner/runner/target/release/paperclip-runnerd'),
    PAPERCLIP_RUNNER_REMOTE_BINARY_PATH: path.join(build.appRoot, 'packages/paperclip-runner/runner/target/release/paperclip-runnerd'),
    PAPERCLIP_INGESTION_TRANSPORT: 'sandbox-remote-with-local-stop', PAPERCLIP_E2E_PORT: String(port), PAPERCLIP_INGESTION_SMOKE: '0',
    PAPERCLIP_INGESTION_VARIANT: `${armStage}-${variant}`, PAPERCLIP_INGESTION_APP_ROOT: build.appRoot, PAPERCLIP_INGESTION_EVIDENCE_DIR: directory,
    PAPERCLIP_INGESTION_DRIVER_DEPENDENCIES: 'Independent frozen H5 driver install; each measured variant owns its separately qualified application/native build', PATH: process.env.PATH };
  const launchEnvironment = { ...process.env, ...environmentOverrides };
  assert.equal(preflight.runtimeChecks.PATH, launchEnvironment.PATH, 'Runtime checks must use the exact launch PATH');
  assert.equal(preflight.runtimeChecks.cwd, build.appRoot, 'Runtime checks must use the selected APP cwd');
  const pathNode = await assertPathNode(launchEnvironment, process.execPath, build.appRoot);
  await saveJson(path.join(directory, 'pre-arm-inventory-check.json'), { ...preflight, pathNode }, true);
  let primaryError, inventoryFile, extracted;
  try {
    await execute(context, { stage: armStage, cwd: release.harnessRoot,
      args: ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/e2e/playwright-native-ingestion.config.ts'],
      env: environmentOverrides, launchEnvironment });
  } catch (error) { primaryError = error; }
  try {
    inventoryFile = await armSidecar(directory, variant, build); extracted = await extractEvidence(directory);
    if (!primaryError) {
      const { evidence } = extracted;
      assert.equal(evidence.complete, true); assert.equal(evidence.observationComplete, true); assert.equal(evidence.observationMode, MODE);
      assert.equal(evidence.workloadSha256, WORKLOAD_SHA256); assert.equal(evidence.protocolVersion, PROTOCOL);
      assert.equal(evidence.transport, 'sandbox-remote-with-local-stop'); assert.equal(evidence.cleanup?.complete, true); assert.deepEqual(evidence.cleanup.errors, []);
      assert.equal(evidence.measurementSha256, release.protocolSha256); assert.equal(evidence.harnessProvenance?.sourceRevision, release.harnessRevision); assert.equal(evidence.harnessProvenance?.sourceStatus, '');
      assert.equal(evidence.sourceRevision, build.revision); assert.equal(evidence.compiledBuildRevision, build.revision);
      assert.equal(evidence.serverArtifact, 'compiled'); assert.equal(evidence.qualificationOnly, false); assert.equal(evidence.diagnosticOnly, false); assert.equal(evidence.performanceAcceptanceEligible, true);
      assert.equal(evidence.browserRecording?.trace, 'off'); assert.equal(evidence.browserRecording?.video, 'off'); assert.equal(evidence.browserRecording?.screencast, false);
      const loaded = evidence.cases.find(item => item.name === 'burst512'); assert.equal(loaded.runs, 100); assert.equal(loaded.participants, 100); assert.equal(loaded.durable.length, 100);
      const { validateArmInventory } = await import(pathToFileURL(path.join(release.harnessRoot, 'scripts/native-ingestion-h5-inventory.mjs')).href);
      await validateArmInventory(inventoryFile, { evidence, owningPlaywright: { reportSha256: hash(await readFile(extracted.playwrightFile)) } });
    }
  } catch (error) { primaryError ??= error; }
  try { await assertPortReleased(port); await saveJson(path.join(directory, 'physical-http-port-check.json'), { released: true, port, scope: 'Owned HTTP listener only; PG/Runner/provider physical cleanup is separately required before the next release' }, true); }
  catch (error) { primaryError ??= error; }
  try { await physicalQuietGuard({ receiptFile: path.join(directory, 'physical-quiet-post.json'), phase: 'post-arm', armStage,
    primaryFailureAlreadyPresent: Boolean(primaryError) }); }
  catch (error) {
    if (primaryError) console.error(`Secondary physical quiet failure; primary fixture failure is retained: ${error.message}`);
    primaryError ??= error;
  } // Failed guard receipt and SHA remain independent evidence; the fixture failure stays primary.
  if (primaryError) throw primaryError;
  const result = { file: extracted.file, playwrightFile: extracted.playwrightFile, inventoryFile };
  return { ...result, artifacts: await sealArmArtifacts(context.out, result) };
}

function comparatorArgs(context, plan, pairsFile, output, originalProof) {
  const args = ['scripts/compare-native-ingestion-browser.ts', `--observation-mode=${MODE}`, `--phase=${plan.aa ? 'aa' : 'compare'}`,
    `--expect=${plan.expectation}`, `--pairs=${pairsFile}`, `--output=${output}`];
  if (!plan.aa) args.push(`--candidate-policy=${plan.candidatePolicy}`, `--noise-report=${path.join(context.out, `${plan.noiseStage}.json`)}`,
    ...(originalProof ? [`--original-h4e-proof=${originalProof.proofFile}`, `--original-h4e-inventory=${originalProof.inventoryFile}`, '--require-acceptance'] : ['--require-performance']));
  return args;
}

async function browserSeries(context) {
  const { plan, release } = context, manifest = [], file = path.join(context.out, `${plan.stage}-pairs.json`), comparisonFile = path.join(context.out, `${plan.stage}.json`);
  await access(comparisonFile).then(() => assert.fail('Prior comparison output already exists'), error => { if (error.code !== 'ENOENT') throw error; });
  await saveJson(file, manifest, true);
  for (let pair = 0; pair < 5; pair++) {
    const entry = {}, arms = pair % 2 ? [['candidate', plan.candidate], ['baseline', plan.baseline]] : [['baseline', plan.baseline], ['candidate', plan.candidate]];
    for (const [arm, variant] of arms) {
      const result = await browserRun(context, `${plan.stage}-pair${pair + 1}-${arm}`, variant);
      entry[`${arm}File`] = result.file; entry[`${arm}PlaywrightFile`] = result.playwrightFile; entry[`${arm}InventoryFile`] = result.inventoryFile; entry[`${arm}Artifacts`] = result.artifacts;
    }
    manifest.push(entry); await saveJson(file, manifest);
  }
  await checkFrozen(context); // Same exact release/noise path and bytes pre-comparator.
  await verifyRawArtifactSeals(context.out, manifest);
  const manifestSha256 = hash(await readFile(file));
  await execute(context, { stage: `${plan.stage}-comparison`, cwd: release.harnessRoot, args: comparatorArgs(context, plan, file, comparisonFile) });
  assert.equal(hash(await readFile(file)), manifestSha256, 'Raw paired manifest changed during comparison');
  await verifyRawArtifactSeals(context.out, manifest);
  const result = await getJson(comparisonFile); checkComparisonIdentity(result, context);
  if (!plan.aa) assert.equal(result.performancePassed, true);
  await saveJson(path.join(context.out, `${plan.stage}.completion.json`), { stage: plan.stage, complete: true, fullArms: 10, completedAtMs: Date.now(),
    releaseFile: context.rootReleaseCopy, originalReleaseFile: context.releaseFile, releaseFileSha256: context.releaseBytesSha256, harnessPins: harnessFields(release),
    perVariantBuilds: Object.fromEntries(plan.requiredVariants.map(variant => [variant, release.perVariantBuilds[variant]])),
    manifestFile: file, manifestSha256, comparisonFile, comparisonSha256: hash(await readFile(comparisonFile)),
    physicalGuards: physicalGuardReferences(manifest),
    ...(plan.noiseStage ? { noiseReportFile: release.noiseReportFile, noiseReportSha256: release.noiseReportSha256 } : {}),
    performancePassed: result.performancePassed ?? null, acceptancePassed: result.acceptancePassed ?? null,
    finalOriginalH4eConfirmationPending: plan.candidatePolicy === 'final-b2' }, true);
}

async function checkFinalizationInputs(context) {
  const proof = context.release.originalH4eProof;
  assert.ok(proof, 'One later unchanged H4e proof is required for both final comparisons');
  for (const [key, sha] of [['proofFile', 'proofSha256'], ['inventoryFile', 'inventorySha256']]) await hashedJson(proof[key], proof[sha], `Original H4e ${key}`);
  const proofReport = await getJson(proof.proofFile), proofAttempts = [];
  const visit = value => {
    if (Array.isArray(value)) for (const child of value) visit(child);
    else if (value && typeof value === 'object') {
      if (Array.isArray(value.results) && Object.hasOwn(value, 'expectedStatus')) proofAttempts.push(...value.results);
      for (const [key, child] of Object.entries(value)) if (key !== 'results') visit(child);
    }
  };
  visit(proofReport); assert.equal(proofAttempts.length, 1, 'One later unchanged original H4e attempt must confirm both stages');
  const proofStartedAtMs = Date.parse(proofAttempts[0].startTime);
  assert.ok(Number.isFinite(proofStartedAtMs), 'Original H4e proof has no actual attempt start time');
  for (const stage of ['browser-b1-b2', 'browser-b0-b2']) {
    const pin = context.release.completedSeries?.[stage]; assert.ok(pin, `Missing frozen completed ${stage}`);
    assert.equal(pin.file, path.join(context.out, `${stage}.completion.json`));
    const completion = (await hashedJson(pin.file, pin.sha256, `${stage} completion`)).value;
    assert.equal(completion.stage, stage); assert.equal(completion.complete, true); assert.equal(completion.fullArms, 10); assert.equal(completion.performancePassed, true);
    assert.ok(Number.isFinite(completion.completedAtMs) && completion.completedAtMs < proofStartedAtMs, 'Original H4e proof must run after BOTH timing stages complete');
    assert.deepEqual(completion.harnessPins, harnessFields(context.release));
    const plan = stagePlan(stage);
    for (const variant of plan.requiredVariants) assert.deepEqual(completion.perVariantBuilds[variant], context.release.perVariantBuilds[variant], 'Finalization changed a measured qualified build');
    assert.equal(completion.manifestFile, path.join(context.out, `${stage}-pairs.json`));
    assert.equal(completion.comparisonFile, path.join(context.out, `${stage}.json`));
    assert.equal(hash(await readFile(completion.manifestFile)), completion.manifestSha256, 'Raw timing manifest changed before finalization');
    const manifest = await getJson(completion.manifestFile); assert.equal(manifest.length, 5);
    await verifyRawArtifactSeals(context.out, manifest);
    assert.deepEqual(completion.physicalGuards, physicalGuardReferences(manifest), 'Completion physical-guard receipts differ from sealed arm bytes');
    assert.equal(hash(await readFile(completion.comparisonFile)), completion.comparisonSha256, 'Preliminary performance assessment changed');
    assert.equal(completion.noiseReportFile, path.join(context.out, `${plan.noiseStage}.json`), 'Finalization rebound the frozen noise path');
    assert.equal(hash(await readFile(completion.noiseReportFile)), completion.noiseReportSha256, 'Frozen noise bytes changed before finalization');
    const originalRelease = await hashedJson(completion.releaseFile, completion.releaseFileSha256, `${stage} original release`);
    assert.equal(originalRelease.value.noiseReportFile, completion.noiseReportFile); assert.equal(originalRelease.value.noiseReportSha256, completion.noiseReportSha256);
  }
}

async function finalizeSeries(context) {
  await checkFrozen(context); await checkFinalizationInputs(context);
  for (const stage of ['browser-b1-b2', 'browser-b0-b2']) {
    await checkFrozen(context); await checkFinalizationInputs(context);
    const pin = context.release.completedSeries[stage], completion = (await hashedJson(pin.file, pin.sha256, `${stage} completion`)).value;
    const output = path.join(context.out, `${stage}.final.json`);
    await access(output).then(() => assert.fail('Final assessment output already exists'), error => { if (error.code !== 'ENOENT') throw error; });
    await execute(context, { stage: `${stage}-original-h4e-finalization`, cwd: context.release.harnessRoot,
      args: comparatorArgs(context, stagePlan(stage), completion.manifestFile, output, context.release.originalH4eProof) });
    await checkFinalizationInputs(context);
    assert.equal((await getJson(output)).acceptancePassed, true);
  }
}

async function main() {
  const stage = option('stage');
  if (!process.argv.includes('--execute') && !process.argv.includes('--validate-release')) {
    console.log(JSON.stringify({ draft: true, observationMode: MODE, protocolVersion: PROTOCOL, workloadSha256: WORKLOAD_SHA256,
      stages: STAGES.map(stagePlan), fullArms: 50, finalization: stagePlan(FINALIZE_STAGE),
      baselines: BASELINES, originalReceiptSha256: OLD_RECEIPT, resourceWatchdogMillis: RESOURCE_WATCHDOG_MILLIS,
      frozenH5: { revision: H5_REVISION, protocolSha256: H5_PROTOCOL_SHA256, comparatorSha256: H5_COMPARATOR_SHA256, inventoryHelperSha256: H5_INVENTORY_HELPER_SHA256, protocolDocumentSha256: H5_PROTOCOL_DOCUMENT_SHA256 },
      pendingPins: 'B2 source75b3578 needs its own actual production-build receipt, isolated native target and qualified actual binary hash; native input equality does not imply cross-role artifact equality. No H5 VM execution is released by this file.',
      note: 'Plan only; no SUT/build/VM/network or arm starts. Root and independent peer review plus qualification release required.' }, null, 2)); return;
  }
  const out = option('output-root') ?? '/home/ubuntu/native-ingestion/evidence/h5e/series';
  const context = await loadRelease(option('release'), stage, out);
  if (process.argv.includes('--validate-release') && !process.argv.includes('--execute')) {
    console.log(JSON.stringify({ valid: true, stage, requiredVariants: context.plan.requiredVariants,
      validationScope: 'Static immutable release/receipt/manifest/noise/stage-order bindings only; no live SUT/driver/build attestation and no arm execution', releaseFileSha256: context.releaseBytesSha256 })); return;
  }
  await checkFrozen(context); await mkdir(out, { recursive: true });
  // Keep the exact release bytes as a distinct artifact, so later stages never
  // require an owner to retain an overwriteable release-input filename.
  context.rootReleaseCopy = path.join(out, `${stage}-root-release.json`);
  const releaseBytes = await readFile(context.releaseFile);
  assert.equal(hash(releaseBytes), context.releaseBytesSha256, 'Root release changed before preservation');
  await writeFile(context.rootReleaseCopy, releaseBytes, { flag: 'wx' });
  await saveJson(path.join(out, `${stage}-release-record.json`), { ...context.release, releaseFile: context.releaseFile,
    releaseFileSha256: context.releaseBytesSha256, recordedAt: new Date().toISOString() }, true);
  if (context.plan.finalizationOnly) await finalizeSeries(context); else await browserSeries(context);
}
if (process.argv[1] && path.resolve(process.argv[1]) === selfFile) await main();
