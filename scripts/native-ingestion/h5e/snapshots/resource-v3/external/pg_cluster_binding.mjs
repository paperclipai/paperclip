// Local embedded PostgreSQL ownership proof. Importing performs no I/O.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import path from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value && value !== '/';
const within = (file, directory) => file.startsWith(directory + path.sep);
const port = value => Number.isInteger(value) && value > 0 && value <= 65535;

export function validateClusterConfig(config) {
  for (const key of ['ownedServerHomePath', 'ownedServerConfigPath', 'expectedDataDirectory']) assert.ok(absolute(config[key]), `${key} required`);
  assert.ok(within(config.ownedServerConfigPath, config.ownedServerHomePath));
  assert.ok(within(config.expectedDataDirectory, config.ownedServerHomePath));
  assert.ok(isHash(config.ownedServerConfigSha256));
  assert.ok(isHash(config.expectedPostgresExecutableSha256));
  assert.ok(port(config.expectedPort) && port(config.expectedConfiguredPort));
  assert.equal(config.expectedDatabaseName, 'paperclip');
  assert.ok(Number.isInteger(config.expectedDatabaseOid) && config.expectedDatabaseOid > 0);
  assert.ok(Number.isInteger(config.expectedPostmasterPid) && config.expectedPostmasterPid > 1);
  assert.match(config.expectedPostmasterBirthTicks, /^[0-9]+$/);
  assert.match(config.expectedBootId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(Object.hasOwn(config, 'expectedPostgresCgroup'), 'Explicit scope or null required');
  if (config.expectedPostgresCgroup !== null) {
    const scope = config.expectedPostgresCgroup;
    assert.ok(absolute(scope.path) && within(scope.path, '/sys/fs/cgroup'));
    assert.ok(Number.isSafeInteger(scope.inode) && scope.inode > 0);
    assert.ok(isHash(scope.qualificationReceiptSha256));
  }
  return config;
}

// Validate and materialize explicit options; never hand the URI or PG* defaults
// to the driver. No connection/credential value is returned in recorded proofs.
export function localConnectionOptions(value, config) {
  validateClusterConfig(config);
  const url = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, '127.0.0.1', 'Only explicit local IPv4 TCP is supported');
  assert.equal(url.search, '', 'Connection overrides are forbidden');
  assert.equal(url.hash, '');
  assert.ok(url.port && port(Number(url.port)), 'Explicit TCP port required');
  assert.equal(Number(url.port), config.expectedPort);
  assert.equal(decodeURIComponent(url.pathname.slice(1)), config.expectedDatabaseName);
  const username = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
  assert.ok(username && password, 'Explicit credentials required; no environment fallback');
  return { host: '127.0.0.1', port: config.expectedPort, database: config.expectedDatabaseName,
    username, password, ssl: false };
}

export function parseProcIdentity(text) {
  const opening = text.indexOf('('), closing = text.lastIndexOf(')');
  assert.ok(opening > 0 && closing > opening);
  const pid = Number(text.slice(0, opening).trim()), fields = text.slice(closing + 1).trim().split(/\s+/);
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && fields.length >= 20);
  assert.ok(!['Z', 'X', 'x'].includes(fields[0]), 'PostgreSQL process is not live');
  assert.match(fields[19], /^[0-9]+$/);
  const ppid = Number(fields[1]);
  assert.ok(Number.isSafeInteger(ppid) && ppid >= 0);
  return { pid, ppid, starttimeTicks: fields[19] };
}

export function parseUnifiedCgroup(text) {
  const rows = text.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(rows.length, 1, 'Unified cgroup-v2 namespace required');
  assert.ok(rows[0].startsWith('0::/'));
  const value = rows[0].slice(3);
  assert.equal(path.posix.normalize(value), value);
  assert.ok(!value.includes('\0'));
  return value;
}

const fingerprint = metadata => ({ device: String(metadata.dev), inode: String(metadata.ino),
  bytes: metadata.size, mtimeMs: metadata.mtimeMs });
const processKey = row => ({ pid: row.pid, ppid: row.ppid, starttimeTicks: row.starttimeTicks });

export function createClusterObserver(config, io = filesystem) {
  validateClusterConfig(config);
  const executableCache = new Map();
  const text = async (file, maximum = 65536) => {
    const bytes = await io.readFile(file);
    assert.ok(bytes.byteLength <= maximum, 'Ownership metadata exceeds bound');
    return bytes.toString('utf8');
  };
  const readProcess = async pid => {
    const base = `/proc/${pid}`;
    const first = parseProcIdentity(await text(base + '/stat'));
    assert.equal(first.pid, pid);
    const executable = await io.realpath(base + '/exe');
    const before = fingerprint(await io.stat(base + '/exe'));
    assert.ok(Number.isSafeInteger(before.bytes) && before.bytes > 0 && before.bytes <= 64 * 1024 * 1024);
    const key = JSON.stringify(before);
    if (!executableCache.has(key)) {
      assert.ok(executableCache.size < 8, 'Executable identity cache exceeded');
      executableCache.set(key, hash(await io.readFile(base + '/exe')));
    }
    const executableSha256 = executableCache.get(key);
    assert.equal(executableSha256, config.expectedPostgresExecutableSha256);
    const cgroup = parseUnifiedCgroup(await text(base + '/cgroup'));
    const pidNamespace = await io.readlink(base + '/ns/pid'), networkNamespace = await io.readlink(base + '/ns/net');
    const last = parseProcIdentity(await text(base + '/stat'));
    assert.deepEqual(processKey(last), processKey(first), 'Process birth/parent changed during read');
    assert.deepEqual(fingerprint(await io.stat(base + '/exe')), before, 'Process executable changed during read');
    assert.equal(await io.realpath(base + '/exe'), executable);
    return { ...last, executable, executableSha256, executableFingerprint: before, cgroup, pidNamespace, networkNamespace };
  };
  return async observerPid => {
    assert.ok(Number.isSafeInteger(observerPid) && observerPid > 1 && observerPid !== config.expectedPostmasterPid);
    const bootId = (await text('/proc/sys/kernel/random/boot_id', 128)).trim();
    assert.equal(bootId, config.expectedBootId);
    const home = await io.realpath(config.ownedServerHomePath);
    assert.equal(home, config.ownedServerHomePath);
    const configuration = await io.realpath(config.ownedServerConfigPath);
    assert.equal(configuration, config.ownedServerConfigPath);
    const configBytes = await io.readFile(configuration);
    assert.ok(configBytes.byteLength <= 1024 * 1024);
    assert.equal(hash(configBytes), config.ownedServerConfigSha256);
    const stored = JSON.parse(configBytes);
    assert.equal(stored.database?.mode, 'embedded-postgres');
    assert.ok(path.isAbsolute(stored.database.embeddedPostgresDataDir));
    assert.equal(await io.realpath(stored.database.embeddedPostgresDataDir), config.expectedDataDirectory);
    assert.equal(await io.realpath(config.expectedDataDirectory), config.expectedDataDirectory);
    assert.equal(stored.database.embeddedPostgresPort, config.expectedConfiguredPort);
    const pidFile = (await text(path.join(config.expectedDataDirectory, 'postmaster.pid'), 8192)).trim().split(/\r?\n/);
    assert.ok(pidFile.length >= 4);
    assert.equal(Number(pidFile[0]), config.expectedPostmasterPid);
    assert.equal(await io.realpath(pidFile[1]), config.expectedDataDirectory);
    assert.match(pidFile[2], /^[0-9]+$/);
    assert.equal(Number(pidFile[3]), config.expectedPort);
    const namespace = { pid: await io.readlink('/proc/self/ns/pid'), network: await io.readlink('/proc/self/ns/net') };
    assert.match(namespace.pid, /^pid:\[[0-9]+\]$/);
    assert.match(namespace.network, /^net:\[[0-9]+\]$/);
    const postmaster = await readProcess(config.expectedPostmasterPid);
    assert.equal(postmaster.starttimeTicks, config.expectedPostmasterBirthTicks);
    const observer = await readProcess(observerPid);
    assert.equal(observer.ppid, postmaster.pid, 'SQL backend is not a direct child of the owned postmaster');
    assert.equal(observer.executable, postmaster.executable);
    assert.deepEqual(observer.executableFingerprint, postmaster.executableFingerprint);
    assert.equal(observer.cgroup, postmaster.cgroup, 'Observer escaped the postmaster cgroup');
    for (const row of [postmaster, observer]) {
      assert.equal(row.pidNamespace, namespace.pid, 'Foreign PID namespace');
      assert.equal(row.networkNamespace, namespace.network, 'Foreign network namespace');
    }
    let scope = null;
    if (config.expectedPostgresCgroup) {
      scope = config.expectedPostgresCgroup;
      assert.equal(await io.realpath(scope.path), scope.path);
      assert.equal((await io.stat(scope.path)).ino, scope.inode);
      assert.equal(postmaster.cgroup, scope.path.slice('/sys/fs/cgroup'.length));
    }
    assert.deepEqual(processKey(parseProcIdentity(await text(`/proc/${postmaster.pid}/stat`))), processKey(postmaster));
    assert.deepEqual(processKey(parseProcIdentity(await text(`/proc/${observer.pid}/stat`))), processKey(observer));
    assert.equal((await text('/proc/sys/kernel/random/boot_id', 128)).trim(), bootId);
    return { bootId, namespace, ownedConfigSha256: config.ownedServerConfigSha256,
      dataDirectory: config.expectedDataDirectory, configuredPreferredPort: config.expectedConfiguredPort,
      selectedPort: config.expectedPort, pidFileStartEpochSeconds: pidFile[2],
      postmaster, observer, scope };
  };
}

export function assertClusterBinding(identity, observed, config, previous = null) {
  validateClusterConfig(config);
  assert.ok(Number.isInteger(identity.serverVersion) && identity.serverVersion >= 140000);
  assert.equal(identity.databaseOid, config.expectedDatabaseOid);
  assert.equal(identity.databaseName, config.expectedDatabaseName);
  assert.equal(identity.dataDirectory, config.expectedDataDirectory);
  assert.equal(identity.configuredServerPort, config.expectedPort);
  assert.equal(identity.serverAddress, '127.0.0.1');
  assert.equal(identity.clientAddress, '127.0.0.1');
  assert.equal(identity.serverPort, config.expectedPort);
  assert.equal(identity.transactionReadOnly, 'on');
  assert.ok(Number.isFinite(Number(identity.postmasterStartEpochMs)) && Number(identity.postmasterStartEpochMs) > 0);
  assert.equal(identity.observerBackendPid, observed.observer.pid);
  assert.equal(observed.bootId, config.expectedBootId);
  assert.equal(observed.postmaster.pid, config.expectedPostmasterPid);
  assert.equal(observed.postmaster.starttimeTicks, config.expectedPostmasterBirthTicks);
  assert.equal(observed.observer.ppid, observed.postmaster.pid);
  assert.equal(observed.postmaster.executableSha256, config.expectedPostgresExecutableSha256);
  assert.equal(observed.observer.executableSha256, config.expectedPostgresExecutableSha256);
  const sqlIdentity = Object.fromEntries(['serverVersion', 'databaseOid', 'databaseName', 'dataDirectory',
    'configuredServerPort', 'serverAddress', 'clientAddress', 'serverPort', 'transactionReadOnly',
    'observerBackendPid'].map(key => [key, identity[key]]));
  sqlIdentity.postmasterStartEpochMs = String(identity.postmasterStartEpochMs);
  const binding = { sqlIdentity, observed };
  if (previous) assert.deepEqual(binding, previous, 'SQL cluster or OS backend ownership changed');
  return binding;
}
