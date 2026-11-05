import assert from 'node:assert/strict';

export function assertNoCpuProfiles(execArgv, environment) {
  const flags = [...execArgv, environment.NODE_OPTIONS ?? ''].join(' ');
  assert.equal(/(?:^|\s)--(?:cpu-prof|heap-prof|prof)(?:[-=\s]|$)/.test(flags), false, 'Profiling flags forbidden');
  assert.equal(environment.PAPERCLIP_RESOURCE_CPU_PROFILE ?? '0', '0');
  assert.equal(environment.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_FS ?? '0', '0');
}

export function owningAttempt(report) {
  assert.deepEqual(report.errors, []); assert.equal(report.stats.unexpected, 0); assert.equal(report.stats.flaky, 0);
  assert.equal(report.stats.expected, 1); assert.equal(report.stats.skipped, 0);
  const tests = [];
  const visit = suites => { for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) for (const item of spec.tests ?? []) tests.push({ title: spec.title, ...item });
    visit(suite.suites);
  } };
  visit(report.suites); assert.equal(tests.length, 1, 'Exactly one owning normal journey required');
  const test = tests[0]; assert.equal(test.title, 'native ingestion reaches the shipped UI promptly and survives reload');
  assert.equal(test.expectedStatus, 'passed'); assert.equal(test.results.length, 1);
  const result = test.results[0]; assert.equal(result.status, 'passed'); assert.equal(result.retry, 0); assert.deepEqual(result.errors, []);
  assert.ok(Date.parse(result.startTime) > 0 && Number.isFinite(result.duration) && result.duration > 0);
  const attachments = result.attachments.filter(row => row.name === 'native-ingestion-evidence'); assert.equal(attachments.length, 1);
  return { result, attachment: attachments[0] };
}

export function markerCoverage(evidence, markers) {
  const expected = new Map(), offered = new Map(), identities = new Set();
  for (const item of evidence.cases) {
    const streams = item.clockEvidence.flatMap(stream => stream.emissions);
    for (const row of streams) {
      const key = `${row.markerCode}:${row.index}`; assert.equal(offered.has(key), false); offered.set(key, row);
    }
    assert.equal(item.durable.length, item.runs); assert.equal(item.persistedAfterReload, true);
    for (const proof of item.durable) {
      assert.equal(proof.uniqueSourceIdentities, proof.individualDeltas); assert.equal(proof.matchedSourceClocks, proof.individualDeltas);
      assert.equal(proof.ordered, true); assert.equal(proof.resultAcceptedEvents, item.stop ? 0 : 1);
      for (let index = 0; index < proof.individualDeltas; index++) {
        const key = `${proof.markerCode}:${index}`; assert.equal(expected.has(key), false);
        const source = offered.get(key); assert.ok(source, 'Durable marker missing original source clock'); assert.equal(source.nonce, proof.token);
        expected.set(key, proof.runId);
      }
    }
    if (!item.stop) {
      assert.equal(streams.length, item.runs * item.events);
      assert.equal(item.durable.reduce((n, row) => n + row.individualDeltas, 0), streams.length);
    }
  }
  const actual = new Map();
  for (const row of markers) {
    const key = `${row.markerCode}:${row.index}`; assert.equal(actual.has(key), false, 'Duplicate postcommit marker');
    assert.ok(expected.has(key), 'Postcommit marker outside independently durable prefix'); assert.equal(row.runId, expected.get(key));
    assert.match(row.identitySha256, /^[a-f0-9]{64}$/); assert.equal(identities.has(row.identitySha256), false);
    identities.add(row.identitySha256); actual.set(key, row);
  }
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), 'Missing postcommit coverage');
  return { originalSourceMarkers: offered.size, independentlyDurableMarkers: expected.size, postcommitMarkers: actual.size,
    uniqueCallbackIdentityHashes: identities.size, complete: true,
    scope: 'Exact run/code/index joins to owning journey source clocks and independently checked durable prefixes; normalized source identity/payload proof remains the frozen owning journey oracle; Stop raw tail policy unchanged' };
}

export function bindAcknowledgement(ack, metadata, receipt) {
  assert.equal(ack.pid, metadata.pid); assert.equal(ack.pid, receipt.pid);
  assert.equal(ack.finalizedAtMs, receipt.finalizedAtMs);
  for (const field of ['observerFile', 'observerSha256', 'recordFile', 'recordFileSha256']) assert.equal(ack[field], receipt[field], `ACK ${field} differs from captured receipt`);
  assert.deepEqual(ack.observer, receipt.observer); assert.deepEqual(ack.counters, receipt.counters);
}
