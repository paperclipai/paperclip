import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { diagnosticPlan } from './native-ingestion-h5e-resource-tools-v2/run-resource-diagnostic.mjs';

const root = '/private/tmp/native-ingestion-h5e-resource-tools-v2';
const plan = diagnosticPlan({ workload: 'SMALL', harnessRoot: '/fixture-only/harness', appRoot: '/fixture-only/app',
  nodeExecutable: '/fixture-only/node', output: '/fixture-only/output', variant: 'B0',
  counterPinsFile: '/fixture-only/pins.json', counterPinsSha256: 'a'.repeat(64),
  releaseFile: '/fixture-only/release.json', releaseSha256: 'b'.repeat(64) }, 55432);
const guard = async file => (await readFile(path.join(root, file), 'utf8')).split('\n')
  .find(line => line.startsWith('assert.equal(process.env.PAPERCLIP_RESOURCE_COUNTER_RELEASE,'));
const pgGuard = await guard('pg-service-preload.mjs'), counterGuard = await guard('counter-preload.mjs');
const context = { assert, process: { env: plan.environment } };
vm.runInNewContext(counterGuard, context);
let failure;
try { vm.runInNewContext(pgGuard, context); } catch (error) { failure = error; }
assert.ok(failure instanceof assert.AssertionError);
assert.equal(failure.actual, 'combined-h5e-resource-v2');
assert.equal(failure.expected, 'combined-h5e-resource-v1');
const proof = { actualSourceFunctions: ['diagnosticPlan', 'counter preload release assertion', 'PG preload release assertion'],
  providedReleaseTag: plan.environment.PAPERCLIP_RESOURCE_COUNTER_RELEASE,
  counterGuard, counterGuardPassed: true, pgGuard, pgGuardPassed: false,
  errorCode: failure.code, actual: failure.actual, expected: failure.expected,
  processAppPgVmNetworkOrBuildExecuted: false,
  scope: 'Node node:vm runs the actual extracted assertions against diagnosticPlan output; no preload, app or OS process is started.' };
await writeFile('/private/tmp/native-ingestion-h5e-resource-tools-v2-peer-tag-proof.json', JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof, null, 2));
