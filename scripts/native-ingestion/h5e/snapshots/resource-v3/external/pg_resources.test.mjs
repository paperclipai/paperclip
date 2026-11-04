import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateConfig, validateSnapshot, sampledLockOccupancy } from './pg_resources.mjs';
import { createClusterObserver, assertClusterBinding } from './pg_cluster_binding.mjs';
import { fixture } from './pg_binding_fixtures.mjs';

const config = () => fixture().config;

test('source config needs immutable driver, database and birth inputs', () => {
  validateConfig(config());
  assert.throws(() => validateConfig({ ...config(), driverConnectionSha256: '' }));
  assert.throws(() => validateConfig({ ...config(), expectedPostmasterBirthTicks: '' }));
  assert.throws(() => validateConfig({ ...config(), maxDurationMs: 1800001 }));
  assert.throws(() => validateConfig({ ...config(), clusterBindingModuleSha256: '' }));
});

test('database, connection replacement and silent truncation are rejected', async () => {
  const value = fixture(), observed = await createClusterObserver(value.config, value.io)(300);
  const binding = assertClusterBinding(value.identity, observed, value.config);
  validateSnapshot(value.snapshot(), value.config, binding, observed);
  assert.throws(() => validateSnapshot({ ...value.snapshot(), databaseOid: 43 }, value.config, binding, observed));
  assert.throws(() => validateSnapshot({ ...value.snapshot(), observerBackendPid: 301 }, value.config, binding, observed));
  assert.throws(() => validateSnapshot({ ...value.snapshot(), lockCapExceeded: true }, value.config, binding, observed));
  assert.throws(() => validateSnapshot({ ...value.snapshot(), activity: [{ pid: 300 }] }, value.config, binding, observed));
});

test('sampled lock observations cannot establish exact wait or hold durations', () => {
  const value = sampledLockOccupancy([{ beginEpochMs: 0, endEpochMs: 1, snapshot: {
    activity: [{ pid: 300, backend_start: 'epoch-A', wait_event_type: 'Lock', blocking_pids: [400] }] } }], 300);
  assert.equal(value.observations[0].lockWaitObserved, true);
  assert.equal(value.exactWaitMs, null);
  assert.equal(value.exactHoldMs, null);
});

test('backend PID reuse cannot merge two wait histories', () => {
  const records = ['epoch-A', 'epoch-B'].map(backend_start => ({ snapshot: {
    activity: [{ pid: 300, backend_start, wait_event_type: 'Lock', blocking_pids: [400] }] } }));
  assert.throws(() => sampledLockOccupancy(records, 300));
});

test('SQL captures no query payload and remains bounded/read-only', async () => {
  const sql = await readFile(new URL('./pg-snapshot.sql', import.meta.url), 'utf8');
  assert.match(sql, /limit 2049/);
  assert.match(sql, /limit 8193/);
  assert.match(sql, /pg_backend_pid\(\)/);
  assert.match(sql, /current_setting\('data_directory'\)/);
  assert.match(sql, /inet_server_port\(\)/);
  assert.doesNotMatch(sql, /\ba\.query\b|\bquery\s*,|\b(insert|update|delete|create|alter|drop)\s/i);
});
