#!/usr/bin/env node
// Importing this module performs no I/O. Execution requires --execute.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, open, stat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validateClusterConfig, localConnectionOptions, createClusterObserver, assertClusterBinding } from './pg_cluster_binding.mjs';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const isHash = value => /^[a-f0-9]{64}$/.test(value);
const fixedApplicationName = 'native-ingestion-external-resource-v2';

export function validateConfig(config) {
  assert.equal(config.schema, 'native-ingestion-pg-resource-config/v2');
  assert.equal(config.diagnosticOnly, true);
  assert.match(config.expectedBootId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(config.nonce, /^[a-zA-Z0-9_-]{8,96}$/);
  assert.ok(Number.isInteger(config.intervalMs) && config.intervalMs >= 250 && config.intervalMs <= 2000);
  assert.ok(Number.isInteger(config.maxDurationMs) && config.maxDurationMs >= 1000 && config.maxDurationMs <= 1800000);
  assert.ok(Number.isInteger(config.maxOutputBytes) && config.maxOutputBytes >= 4096 && config.maxOutputBytes <= 64 * 1024 * 1024);
  for (const key of ['owningReleaseSha256', 'qualifiedBuildSha256', 'driverIndexSha256', 'driverConnectionSha256', 'driverPackageSha256', 'snapshotSqlSha256', 'clusterBindingModuleSha256']) {
    assert.ok(isHash(config[key]), `${key} required`);
  }
  assert.ok(config.driverIndexPath.startsWith('/') && config.driverConnectionPath.startsWith('/'));
  assert.ok(Number.isInteger(config.expectedDatabaseOid) && config.expectedDatabaseOid > 0);
  assert.ok(Number.isInteger(config.expectedPostmasterPid) && config.expectedPostmasterPid > 1);
  assert.match(config.expectedPostmasterBirthTicks, /^[0-9]+$/);
  validateClusterConfig(config);
  return config;
}

export function validateSnapshot(snapshot, config, binding, observed) {
  assertClusterBinding(snapshot, observed, config, binding);
  assert.equal(snapshot.activityCapExceeded, false);
  assert.equal(snapshot.lockCapExceeded, false);
  assert.ok(Array.isArray(snapshot.activity) && snapshot.activity.length <= 2048);
  assert.ok(Array.isArray(snapshot.locks) && snapshot.locks.length <= 8192);
  assert.equal(snapshot.activity.some(row => row.pid === binding.observed.observer.pid), false);
  assert.ok(Number.isFinite(Number(snapshot.serverEpochMs)));
  assert.ok(snapshot.databaseStats && Object.hasOwn(snapshot.databaseStats, 'stats_reset'));
  return snapshot;
}

export function sampledLockOccupancy(samples, pid) {
  const observations = samples.flatMap(sample => sample.snapshot.activity.filter(row => row.pid === pid)
    .map(row => ({ beginEpochMs: sample.beginEpochMs, endEpochMs: sample.endEpochMs,
      backendStart: row.backend_start, lockWaitObserved: row.wait_event_type === 'Lock',
      blockingPids: row.blocking_pids })));
  assert.ok(new Set(observations.map(row => row.backendStart)).size <= 1, 'backend PID was reused');
  return { pid, observations, exactWaitMs: null, exactHoldMs: null,
    reason: 'polls can miss waits, ownership changes and gaps between observations' };
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const values = new Map();
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--execute') continue;
    assert.ok(['--config', '--output', '--stop-file'].includes(args[index]), 'unknown argument');
    assert.ok(index + 1 < args.length && !values.has(args[index]), 'missing/duplicate argument');
    values.set(args[index], args[++index]);
  }
  assert.equal(values.size, 3);
  const configBytes = await readFile(values.get('--config'));
  const config = validateConfig(JSON.parse(configBytes));
  const sqlPath = resolve(dirname(fileURLToPath(import.meta.url)), 'pg-snapshot.sql');
  const sqlBytes = await readFile(sqlPath);
  assert.equal(sha(sqlBytes), config.snapshotSqlSha256);
  const clusterBindingModuleSha256 = sha(await readFile(new URL('./pg_cluster_binding.mjs', import.meta.url)));
  assert.equal(clusterBindingModuleSha256, config.clusterBindingModuleSha256);
  const [driverIndex, driverConnection] = await Promise.all([
    readFile(config.driverIndexPath), readFile(config.driverConnectionPath),
  ]);
  assert.equal(sha(driverIndex), config.driverIndexSha256);
  assert.equal(sha(driverConnection), config.driverConnectionSha256);
  const indexReal = await realpath(config.driverIndexPath);
  const connectionReal = await realpath(config.driverConnectionPath);
  assert.equal(connectionReal, resolve(dirname(indexReal), 'connection.js'));
  assert.equal(indexReal.endsWith('/src/index.js'), true);
  const packageBytes = await readFile(resolve(dirname(indexReal), '..', 'package.json'));
  assert.equal(sha(packageBytes), config.driverPackageSha256);
  assert.equal(JSON.parse(packageBytes).version, '3.4.9');
  if (!execute) {
    console.log(JSON.stringify({ validSourceConfig: true, executed: false, diagnosticOnly: true }));
    return;
  }
  assert.equal(process.platform, 'linux');
  assert.equal((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), config.expectedBootId);
  // URL is consumed only in memory; never serialize it or arbitrary driver errors.
  assert.ok(process.env.NATIVE_INGESTION_PG_URL, 'connection environment required');
  const connectionOptions = localConnectionOptions(process.env.NATIVE_INGESTION_PG_URL, config);
  const stopPath = values.get('--stop-file');
  await assert.rejects(stat(stopPath), error => error.code === 'ENOENT');
  const outputPath = values.get('--output');
  const output = await open(outputPath, 'wx', 0o600);
  const receiptOutput = await open(outputPath + '.receipt.json', 'wx', 0o600);
  const started = performance.now();
  const startedCpu = process.cpuUsage();
  const digest = createHash('sha256');
  let bytes = 0, samples = 0, completed = false, failure = null, sql, phase = 'connection';
  const write = async record => {
    const data = Buffer.from(JSON.stringify(record) + '\n');
    assert.ok(bytes + data.length <= config.maxOutputBytes, 'output cap exceeded');
    await output.write(data);
    digest.update(data);
    bytes += data.length;
  };
  try {
    const { default: postgres } = await import(pathToFileURL(config.driverIndexPath).href);
    sql = postgres({ ...connectionOptions, max: 1, prepare: false,
      connect_timeout: 5, idle_timeout: 0, onnotice() {},
      connection: { application_name: fixedApplicationName,
        options: '-c default_transaction_read_only=on -c statement_timeout=1000 -c lock_timeout=100' } });
    const [first] = await sql`select json_build_object(
      'serverVersion', current_setting('server_version_num')::int,
      'databaseOid', (select oid from pg_database where datname=current_database()),
      'databaseName', current_database(), 'observerBackendPid', pg_backend_pid(),
      'postmasterStartEpochMs', extract(epoch from pg_postmaster_start_time()) * 1000,
      'dataDirectory', current_setting('data_directory'),
      'configuredServerPort', current_setting('port')::int,
      'serverAddress', inet_server_addr()::text, 'clientAddress', inet_client_addr()::text,
      'serverPort', inet_server_port(), 'transactionReadOnly', current_setting('transaction_read_only')
    ) as identity`;
    const identity = first.identity;
    const observeCluster = createClusterObserver(config);
    phase = 'initial_cluster_binding';
    const binding = assertClusterBinding(identity, await observeCluster(identity.observerBackendPid), config);
    await write({ schema: 'native-ingestion-pg-resources/v2', kind: 'header', diagnosticOnly: true,
      configSha256: sha(configBytes), config, samplerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
      identity, clusterBinding: binding, clusterBindingModuleSha256,
      includesObserverDatabaseWork: true, pgStatStatementsCaptured: false });
    while (true) {
      const cycleBeginEpochMs = Date.now(), cycleBegin = performance.now();
      phase = 'sample_before_cluster_binding';
      const before = await observeCluster(binding.observed.observer.pid);
      assertClusterBinding(binding.sqlIdentity, before, config, binding);
      // One read-only autocommit query per sample. No new transaction per relation/lock row.
      phase = 'sample_sql';
      const beginEpochMs = Date.now(), begin = performance.now(), monotonicNs = process.hrtime.bigint().toString();
      const result = await sql.unsafe(sqlBytes.toString('utf8'));
      const endEpochMs = Date.now(), readDurationMs = performance.now() - begin;
      assert.equal(result.length, 1);
      phase = 'sample_after_cluster_binding';
      const after = await observeCluster(binding.observed.observer.pid);
      const snapshot = validateSnapshot(result[0].snapshot, config, binding, after);
      assert.deepEqual(after, before, 'Cluster binding changed across the sampled SQL');
      await write({ kind: 'sample', beginEpochMs, endEpochMs, monotonicNs, readDurationMs,
        clusterBindingSpan: { beginEpochMs: cycleBeginEpochMs, endEpochMs: Date.now(),
          ownershipReadDurationMs: performance.now() - cycleBegin - readDurationMs },
        clusterBinding: after, snapshot });
      samples++;
      const stop = await readFile(stopPath).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stop) {
        assert.deepEqual(JSON.parse(stop), { schema: 'native-ingestion-resource-stop/v1', nonce: config.nonce });
        completed = true;
        break;
      }
      assert.ok(performance.now() - started < config.maxDurationMs, 'resource deadline reached');
      await delay(Math.max(0, config.intervalMs - (performance.now() - cycleBegin)));
    }
  } catch (error) {
    failure = error instanceof assert.AssertionError ? 'AssertionError' : 'ResourceCollectionError';
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => { failure = 'ObserverConnectionCloseError'; completed = false; });
    await output.sync();
    await output.close();
    const ownCpu = process.cpuUsage(startedCpu);
    const receipt = { schema: 'native-ingestion-pg-resources/v2', diagnosticOnly: true,
      completed: completed && !failure, errorClass: failure, failurePhase: failure ? phase : null, sampleCount: samples, bytes,
      sha256: digest.digest('hex'), elapsedMs: performance.now() - started,
      samplerNodeCpuMs: (ownCpu.user + ownCpu.system) / 1000,
      exactLockWaitClaim: false, exactLockHoldClaim: false, rowsExaminedClaim: false };
    await receiptOutput.writeFile(JSON.stringify(receipt, null, 2) + '\n');
    await receiptOutput.sync();
    await receiptOutput.close();
    console.log(JSON.stringify(receipt));
    if (!receipt.completed) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Resource collector setup failed; no arbitrary error details logged.'); process.exitCode = 1; });
}
