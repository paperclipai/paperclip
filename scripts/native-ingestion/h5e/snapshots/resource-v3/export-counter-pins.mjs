// Metadata export only; never starts an app, database, unit or provider.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { BASELINES, CANDIDATE, HELPERS, hash, shaFile, json, validateHelperApproval } from './resource-contract.mjs';

export function exportPins(base, variant, build, manifest) {
  assert.ok(['B0', 'B1', 'B2'].includes(variant)); assert.equal(build.revision, BASELINES[variant] ?? CANDIDATE);
  assert.equal(manifest.variant, variant); assert.equal(manifest.compiledBuildRevision, build.revision);
  assert.equal(manifest.revision, build.revision); assert.equal(manifest.aggregateSha256, build.aggregateSha256);
  const pins = structuredClone(base), reference = base.variants.B0;
  const one = pathname => { const rows = manifest.files.filter(row => row.path === pathname); assert.equal(rows.length, 1); return rows[0]; };
  pins.variants[variant] = { revision: build.revision, manifestSha256: build.manifestFileSha256, aggregateSha256: build.aggregateSha256,
    modules: Object.fromEntries(Object.entries(reference.modules).map(([name, row]) => [name, one(row.path)])), serverIndex: one('server/dist/index.js') };
  pins.qualificationSha256 = build.qualifiedReceiptSha256; pins.inventorySummarySha256 = build.inventorySummarySha256;
  pins.runtime.nativeBinarySha256 = build.binarySha256; pins.runtime.rustSourceTree = build.rustSourceTree;
  return pins;
}
async function main() {
  if (!process.argv.includes('--export')) { console.log(JSON.stringify({ sourceOnly: true, B2ExpectedSourceRevision: (await json(new URL('./pins.json', import.meta.url))).variants.B2?.revision ?? null, B2ServingQualified: false,
    action: 'Requires a concrete hashed metadata-export request and the actual qualified descriptor/manifest; no build or serving execution' })); return; }
  const option = key => process.argv.find(value => value.startsWith('--' + key + '='))?.slice(key.length + 3);
  const requestFile = option('request'), bytes = await readFile(requestFile); assert.equal(hash(bytes), option('request-sha256'));
  const request = JSON.parse(bytes); assert.equal(request.schema, 'native-ingestion-counter-pin-export/v1'); assert.equal(request.authorized, true);
  assert.equal(await shaFile(request.mainHelperFile), request.mainHelperSha256);
  assert.equal(await shaFile(request.mainHelperPacketFile), request.mainHelperPacketSha256);
  if (HELPERS[request.mainHelperSha256]) assert.equal(HELPERS[request.mainHelperSha256], request.mainHelperPacketSha256);
  else {
    assert.equal(await shaFile(request.mainHelperApprovalFile), request.mainHelperApprovalSha256);
    validateHelperApproval(await json(request.mainHelperApprovalFile), request.mainHelperSha256, request.mainHelperPacketSha256);
  }
  const helper = await import(pathToFileURL(request.mainHelperFile).href);
  const qualified = await helper.validateVariantBuild(request.variant, request.build);
  const base = await json(new URL('./pins.json', import.meta.url));
  const pg = await realpath(path.join(request.build.appRoot, 'packages/db/node_modules/postgres'));
  for (const [name, expected] of Object.entries(base.postgres.files)) assert.equal(await shaFile(path.join(pg, name)), expected);
  const pins = exportPins(base, request.variant, request.build, qualified.manifest);
  await writeFile(request.output, JSON.stringify(pins, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
  await writeFile(request.output + '.provenance.json', JSON.stringify({ sourceOnlyMetadataExport: true, variant: request.variant,
    descriptor: request.build, sourceRequestSha256: hash(bytes), pinsSha256: await shaFile(request.output),
    mainHelperSha256: request.mainHelperSha256, mainHelperPacketSha256: request.mainHelperPacketSha256,
    limitation: 'Actual hook semantics and serving qualification still required; metadata export establishes no resource or performance result' }, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
