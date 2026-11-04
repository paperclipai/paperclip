// Offline actual-source regression: an already-admitted resource beyond the
// cap must remain reachable by the real failure-cleanup loop. No cloud calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
function section(start, end) {
  assert.equal(source.split(start).length, 2, `Unique source seam: ${start}`);
  const offset = source.indexOf(start);
  const stop = source.indexOf(end, offset);
  assert.ok(stop > offset, `Missing end seam: ${end}`);
  return source.slice(offset, stop);
}
const admission = section('    for (const lease of leases)', '    if (runs.length !== 1)');
const lookup = section('\n  const sandbox = await daytona.get(row.providerLeaseId); assertOwned(sandbox, row);', '\n  const cwd = lease.metadata.remoteCwd;');
const cleanup = section('  for (const row of ledger.resources)', '  if (!summary.cleanup.providerCleanupFailed)');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function scenario(failFirstLookup) {
  const ledger = { resources: [] };
  const leases = [1, 2].map(index => ({ heartbeatRunId: `run-${index}`, providerLeaseId: `provider-${index}`, id: `lease-${index}` }));
  const expectedLabels = runId => ({ owner: 'offline-test', runId });
  const states = new Map(leases.map(lease => [lease.providerLeaseId, 'active']));
  const deletions = [];
  let persistedLedger;
  let lookupAttempts = 0;
  const lookupFailure = new Error('Injected first provider lookup failure');
  const daytona = {
    async get(id) {
      if (failFirstLookup && lookupAttempts++ === 0) throw lookupFailure;
      const lease = leases.find(lease => lease.providerLeaseId === id);
      assert.ok(lease, 'Only the exact test resources can be read');
      return { id, labels: expectedLabels(lease.heartbeatRunId) };
    },
    async delete(sandbox) { deletions.push(sandbox.id); states.set(sandbox.id, 'absent'); },
  };
  const assertOwned = (sandbox, row) => {
    assert.equal(sandbox.id, row.providerLeaseId);
    assert.deepEqual(sandbox.labels, row.expectedLabels);
  };
  const writeFile = async (_path, text) => { persistedLedger = JSON.parse(text); };
  const admit = () => new AsyncFunction(
    'leases', 'ledger', 'priorResourceCount', 'RESOURCE_CAP', 'daytona', 'expectedLabels',
    'assertOwned', 'writeFile', 'ledgerPath', 'assert', 'console', admission,
  )(leases, ledger, 0, failFirstLookup ? 2 : 1, daytona, expectedLabels, assertOwned, writeFile, 'offline-ledger', assert, { log() {} });
  if (failFirstLookup) {
    await assert.rejects(async () => {
      await admit();
      await new AsyncFunction('daytona', 'row', 'assertOwned', lookup)(daytona, ledger.resources[0], assertOwned);
    }, error => error === lookupFailure);
  } else await assert.rejects(admit, /cloud_resource_bound/);
  assert.equal(persistedLedger?.resources.length, 2, 'Every observed owned ID must reach the watchdog ledger');
  const summary = { cleanup: {} };
  const providerState = async row => ({ id: row.providerLeaseId, state: states.get(row.providerLeaseId) });
  const poll = async (_label, load, accept) => { const value = await load(); assert.ok(accept(value)); return value; };
  await new AsyncFunction(
    'ledger', 'summary', 'providerState', 'daytona', 'assertOwned', 'poll', 'safeError', cleanup,
  )(ledger, summary, providerState, daytona, assertOwned, poll, error => ({ message: error.message }));
  assert.deepEqual(deletions, leases.map(lease => lease.providerLeaseId));
  assert.ok(summary.cleanup.providerAbsence.every(row => row.state === 'absent'));
  assert.equal(summary.cleanup.providerCleanupFailed, undefined);
  return { failure: failFirstLookup ? 'first-provider-lookup' : 'resource-cap', observedOwnedResources: 2,
    declaredCap: failFirstLookup ? 2 : 1, ledgeredBeforeFailure: 2, exactOwnedCleanupCalls: 2 };
}
console.log(JSON.stringify({ status: 'passed', cloudCalls: 0, cases: [await scenario(false), await scenario(true)] }));
