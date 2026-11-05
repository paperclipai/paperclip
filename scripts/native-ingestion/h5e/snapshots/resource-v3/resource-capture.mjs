import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile, readdir, open, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { loadRelease, json, hash, shaFile } from './resource-contract.mjs';
import { finalizeCounterCapture } from './counter-capture-client.mjs';
import { verifyPgService } from './pg-service.mjs';
import { createClusterObserver, assertClusterBinding, parseProcIdentity } from './external/pg_cluster_binding.mjs';

let state;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
async function lines(file) {
  const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  assert.ok(Buffer.byteLength(text) <= 64 * 1024 * 1024);
  return text.split('\n').slice(0, -1).filter(Boolean).map(row => JSON.parse(row));
}
async function poll(label, read, accept, timeout = 8000) {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (accept(value)) return value; await pause(50); } while (Date.now() < deadline);
  throw new Error('resource_capture_timeout_' + label);
}
async function launchCollector(executable, args, environment, stem, owner) {
  const output = await open(stem + '.log', 'wx', 0o600);
  let child;
  try { child = spawn(executable, args, { env: environment, stdio: ['ignore', output.fd, output.fd] }); }
  catch (error) { await output.close().catch(() => {}); throw error; }
  const collector = { child, identity: null, stem, exitSettled: false, startupError: null };
  // No await may appear between spawn and listeners/ownership registration.
  collector.exit = new Promise(resolve => {
    child.once('error', error => {
      collector.spawnError = error;
      if (child.pid === undefined) { collector.exitSettled = true; resolve({ code: null, signal: 'spawn_error', error: String(error.message) }); }
    });
    child.once('close', (code, signal) => { collector.exitSettled = true; resolve({ code, signal }); });
  });
  owner.children.push(collector);
  try {
    await output.close();
    collector.identity = await poll('collector_birth', async () => {
      if (collector.spawnError) throw collector.spawnError;
      assert.equal(collector.exitSettled, false, 'Collector exited before birth capture');
      try { return parseProcIdentity(await readFile(`/proc/${child.pid}/stat`, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }, Boolean);
    return collector;
  } catch (error) {
    collector.startupError = String(error.message);
    try { await retireCollector(collector, owner.release.nonce); }
    catch (cleanupError) { collector.cleanupFailure = String(cleanupError.message); }
    throw error;
  }
}
async function awaitExit(collector) {
  let timer;
  try { return await Promise.race([collector.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('resource_collector_exit_timeout')), 7000); })]); }
  finally { clearTimeout(timer); }
}
async function requestCollectorStop(collector, nonce) {
  const filename = collector.stem + '.stop.json', temporary = filename + '.tmp';
  try { await save(temporary, { schema: 'native-ingestion-resource-stop/v1', nonce }); await rename(temporary, filename); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await json(filename); assert.equal(existing.schema, 'native-ingestion-resource-stop/v1'); assert.equal(existing.nonce, nonce);
  }
}
async function retireCollector(collector, nonce) {
  if (collector.exitSettled) return collector.exit;
  // The nonce-bound stop path is safe even if /proc birth capture failed. Never
  // fall back to signalling an unqualified numeric PID.
  await requestCollectorStop(collector, nonce);
  try { return await awaitExit(collector); }
  catch (error) {
    if (collector.exitSettled) return collector.exit;
    if (!collector.identity) throw new Error('Collector retirement UNKNOWN: birth unavailable; cooperative join failed', { cause: error });
    const current = parseProcIdentity(await readFile(`/proc/${collector.identity.pid}/stat`, 'utf8'));
    assert.equal(current.starttimeTicks, collector.identity.starttimeTicks, 'Refuse collector PID reuse');
    if (!collector.exitSettled) collector.child.kill('SIGTERM');
    return awaitExit(collector);
  }
}
async function stop(collector, filename, nonce) {
  assert.equal(filename, collector.stem + '.stop.json');
  await requestCollectorStop(collector, nonce);
  const exit = await awaitExit(collector); assert.equal(exit.code, 0); assert.equal(exit.signal, null);
  const receipt = await json(collector.stem + '.jsonl.receipt.json');
  assert.equal(receipt.completed, true); assert.equal(receipt.errorClass, null);
  assert.equal(receipt.sha256, await shaFile(collector.stem + '.jsonl'));
  return receipt;
}
async function databaseIdentity(release, pg, configuration) {
  const require = createRequire(path.join(release.appRoot, 'packages/db/package.json'));
  const postgres = require('postgres');
  const sql = postgres({ host: '127.0.0.1', port: pg.selectedPort, database: 'paperclip', username: 'paperclip', password: 'paperclip',
    ssl: false, max: 1, prepare: false, connect_timeout: 5,
    connection: { application_name: 'native-ingestion-resource-setup', options: '-c default_transaction_read_only=on -c statement_timeout=1000' } });
  try {
    const [row] = await sql`select json_build_object('serverVersion',current_setting('server_version_num')::int,
      'databaseOid',(select oid from pg_database where datname=current_database()),'databaseName',current_database(),
      'observerBackendPid',pg_backend_pid(),'postmasterStartEpochMs',extract(epoch from pg_postmaster_start_time())*1000,
      'dataDirectory',current_setting('data_directory'),'configuredServerPort',current_setting('port')::int,
      'serverAddress',inet_server_addr()::text,'clientAddress',inet_client_addr()::text,'serverPort',inet_server_port(),
      'transactionReadOnly',current_setting('transaction_read_only')) as identity`;
    configuration.expectedDatabaseOid = row.identity.databaseOid;
    const observed = await createClusterObserver(configuration)(row.identity.observerBackendPid);
    return assertClusterBinding(row.identity, observed, configuration);
  } finally { await sql.end({ timeout: 5 }); }
}

export async function startResourceCapture() {
  assert.equal(state, undefined, 'One capture owner');
  const context = await loadRelease(process.env.PAPERCLIP_RESOURCE_RELEASE_FILE, process.env.PAPERCLIP_RESOURCE_RELEASE_SHA256);
  const { release, root, pins } = context, directory = path.join(release.output, 'profile');
  const names = (await readdir(directory)).filter(name => /^app-\d+\.metadata\.json$/.test(name)); assert.equal(names.length, 1);
  const metadata = await json(path.join(directory, names[0]));
  assert.equal(metadata.appRoot, release.appRoot); assert.equal(metadata.variant, release.variant); assert.equal(metadata.sourceRevision, release.build.revision);
  const pg = await json(path.join(release.output, 'pg-service.json'));
  assert.equal(pg.sourceReleaseSha256, process.env.PAPERCLIP_RESOURCE_RELEASE_SHA256); assert.equal(pg.configuration, metadata.configPath);
  const serviceProof = await verifyPgService(release, pg);
  // Normal source selects the recorded live postmaster through its supported
  // embedded reuse branch. Keep an independent emitted application log proof.
  await poll('ordinary_reuse', async () => readFile(path.join(release.output, 'playwright.log'), 'utf8'),
    text => text.includes(`reusing existing process (pid=${pg.pid}, port=${pg.selectedPort})`));
  const app = parseProcIdentity(await readFile(`/proc/${metadata.pid}/stat`, 'utf8'));
  const appExecutable = await realpath(`/proc/${app.pid}/exe`), appSha = await shaFile(`/proc/${app.pid}/exe`);
  assert.equal(appExecutable, await realpath(release.nodeExecutable));
  const definitionsSha = await shaFile(path.join(root, 'DEFINITIONS.md')), scopeSha = await shaFile(path.join(release.output, 'pg-service.json'));
  const pgScope = { path: pg.cgroupPath, inode: pg.cgroupInode, qualificationReceiptSha256: scopeSha };
  const procConfig = { schema: 'native-ingestion-external-config/v1', diagnosticOnly: true, nonce: release.nonce,
    expectedBootId: pg.bootId, intervalMs: 1000, maxDurationMs: release.maxDurationMs, maxOwnedProcesses: 2048,
    maxScanProcesses: 65536, maxOutputBytes: 64 * 1024 * 1024, owningReleaseSha256: process.env.PAPERCLIP_RESOURCE_RELEASE_SHA256,
    qualifiedBuildSha256: release.build.qualifiedReceiptSha256, counterDefinitionsSha256: definitionsSha,
    roots: [{ role: 'server-node', pid: app.pid, starttimeTicks: app.starttimeTicks, exeSha256: appSha },
      { role: 'postgres-postmaster', pid: pg.pid, starttimeTicks: pg.starttimeTicks, exeSha256: pg.postgresSha256 }],
    runnerExecutableSha256: [release.build.binarySha256], cgroups: [{ role: 'postgres-cluster', ...pgScope }] };
  const pgRoot = await realpath(path.join(release.appRoot, 'packages/db/node_modules/postgres'));
  const pgConfig = { schema: 'native-ingestion-pg-resource-config/v2', diagnosticOnly: true, nonce: release.nonce,
    expectedBootId: pg.bootId, intervalMs: 1000, maxDurationMs: release.maxDurationMs, maxOutputBytes: 64 * 1024 * 1024,
    owningReleaseSha256: process.env.PAPERCLIP_RESOURCE_RELEASE_SHA256, qualifiedBuildSha256: release.build.qualifiedReceiptSha256,
    driverIndexPath: path.join(pgRoot, 'src/index.js'), driverConnectionPath: path.join(pgRoot, 'src/connection.js'),
    driverIndexSha256: pins.postgres.files['src/index.js'], driverConnectionSha256: pins.postgres.files['src/connection.js'],
    driverPackageSha256: pins.postgres.files['package.json'], snapshotSqlSha256: await shaFile(path.join(root, 'external/pg-snapshot.sql')),
    clusterBindingModuleSha256: await shaFile(path.join(root, 'external/pg_cluster_binding.mjs')),
    expectedDatabaseOid: 0, expectedDatabaseName: 'paperclip', expectedPostmasterPid: pg.pid, expectedPostmasterBirthTicks: pg.starttimeTicks,
    expectedPostgresExecutableSha256: pg.postgresSha256, ownedServerHomePath: pg.home, ownedServerConfigPath: pg.configuration,
    ownedServerConfigSha256: pg.configurationSha256, expectedDataDirectory: pg.dataDir, expectedConfiguredPort: pg.preferredPort,
    expectedPort: pg.selectedPort, expectedPostgresCgroup: pgScope };
  const initialBinding = await databaseIdentity(release, pg, pgConfig);
  await save(path.join(release.output, 'external-proc-config.json'), procConfig);
  await save(path.join(release.output, 'external-pg-config.json'), pgConfig);
  await save(path.join(release.output, 'process-registry.json'), { schema: 'native-ingestion-process-registry/v1', nonce: release.nonce, sequence: 0, identities: [] });
  const environment = { ...process.env }; delete environment.NODE_OPTIONS;
  const procStem = path.join(release.output, 'external-proc'), pgStem = path.join(release.output, 'external-pg');
  state = { ...context, pg, metadata, procStem, pgStem, children: [] };
  try {
  state.proc = await launchCollector(release.pythonExecutable, [path.join(root, 'external/external_resources.py'),
    '--config', path.join(release.output, 'external-proc-config.json'), '--registry', path.join(release.output, 'process-registry.json'),
    '--output', procStem + '.jsonl', '--stop-file', procStem + '.stop.json', '--execute'], environment, procStem, state);
  state.sql = await launchCollector(release.nodeExecutable, [path.join(root, 'external/pg_resources.mjs'), '--config',
    path.join(release.output, 'external-pg-config.json'), '--output', pgStem + '.jsonl', '--stop-file', pgStem + '.stop.json', '--execute'],
    { ...environment, NATIVE_INGESTION_PG_URL: `postgres://paperclip:paperclip@127.0.0.1:${pg.selectedPort}/paperclip` }, pgStem, state);
  } catch (error) {
    state.startupFailure = error;
    for (const collector of state.children) if (!collector.exitSettled && !collector.cleanupFailure) {
      try { collector.retirement = await retireCollector(collector, release.nonce); }
      catch (cleanupError) { collector.cleanupFailure = String(cleanupError.message); }
    }
    throw error;
  }
  const procRows = await poll('proc_ready', () => lines(procStem + '.jsonl'), rows => rows.some(row => row.kind === 'sample'));
  const pgRows = await poll('pg_ready', () => lines(pgStem + '.jsonl'), rows => rows.some(row => row.kind === 'sample'));
  assert.equal(procRows[0].configSha256, await shaFile(path.join(release.output, 'external-proc-config.json')));
  assert.equal(pgRows[0].configSha256, await shaFile(path.join(release.output, 'external-pg-config.json')));
  assert.equal(pgRows[0].clusterBinding.observed.postmaster.pid, pg.pid);
  await save(path.join(release.output, 'resource-capture-ready.json'), { ready: true, readyAtMs: Date.now(), diagnosticOnly: true,
    serviceProof, initialBinding, appIdentity: app, appExecutableSha256: appSha, definitionsSha256: definitionsSha,
    procFirstSample: procRows.find(row => row.kind === 'sample'), pgFirstSample: pgRows.find(row => row.kind === 'sample'),
    providerRoleAccounting: 'Unknown child roles remain unclassified; proc CPU is lower bound only; no provider full-CPU claim' });
}

export async function finishResourceCapture() {
  assert.ok(state, 'Capture did not start');
  const { release } = state, requestedAtMs = Date.now(); let primary = state.startupFailure, procReceipt, sqlReceipt, counter;
  try {
    if (primary) throw primary;
    // The owning test has finished, so this is strictly after every frozen case's
    // independent verification boundary; no emission is held for collection.
    await poll('final_outer_bracket', () => lines(state.procStem + '.jsonl'), rows => rows.some(row => row.kind === 'sample' && row.beginEpochMs > requestedAtMs));
    await poll('final_sql_outer_bracket', () => lines(state.pgStem + '.jsonl'), rows => rows.some(row => row.kind === 'sample' && row.beginEpochMs > requestedAtMs));
    procReceipt = await stop(state.proc, state.procStem + '.stop.json', release.nonce);
    sqlReceipt = await stop(state.sql, state.pgStem + '.stop.json', release.nonce);
    const service = await verifyPgService(release, state.pg);
    await save(path.join(release.output, 'pg-final-before-app-teardown.json'), { verifiedAtMs: Date.now(), service,
      shutdownCpuIncludedInEventRatios: false });
    counter = await finalizeCounterCapture();
  } catch (error) { primary = error; }
  finally {
    for (const collector of state.children) {
      try { collector.retirement = await retireCollector(collector, release.nonce); }
      catch (error) { collector.cleanupFailure = String(error.message); primary ??= error; }
    }
  }
  const receipt = { diagnosticOnly: true, performanceAcceptanceEligible: false, finalizedBeforeNormalAppTeardown: true,
    requestedAtMs, finalizedAtMs: Date.now(), complete: !primary, procReceipt, sqlReceipt, counter,
    failure: primary ? String(primary.message) : null,
    collectors: state.children.map(item => ({ pid: item.child.pid, identity: item.identity, exitSettled: item.exitSettled,
      startupError: item.startupError, cleanupFailure: item.cleanupFailure ?? null, retirement: item.retirement ?? null })) };
  await save(path.join(release.output, 'COMBINED-resource-before-teardown.json'), receipt);
  if (primary) throw primary; return receipt;
}
