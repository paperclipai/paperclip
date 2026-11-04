import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { mkdir, readFile, writeFile, stat, realpath, readdir, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validateExitProof } from './pg-exit-receipt.mjs';
import { loadRelease, hash, json, shaFile, CONTROL_FILES } from './resource-contract.mjs';
import { parseProcIdentity, parseUnifiedCgroup } from './external/pg_cluster_binding.mjs';

const execute = promisify(execFile);
const showKeys = ['Id', 'Type', 'User', 'Group', 'MainPID', 'ControlGroup', 'InvocationID', 'LoadState', 'ActiveState', 'SubState',
  'Transient', 'Delegate', 'NoNewPrivileges', 'ProtectControlGroups', 'CapabilityBoundingSet', 'AmbientCapabilities',
  'CPUAccounting', 'MemoryAccounting', 'KillSignal', 'RemainAfterExit', 'Result', 'RuntimeMaxUSec', 'TimeoutStopUSec', 'KillMode', 'Restart'];
export const unitName = nonce => { assert.match(nonce, /^[a-z0-9-]{8,64}$/); return `paperclip-ingestion-pgdiag-${nonce}.service`; };
export function environmentFile(environment) {
  return Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    assert.match(key, /^[A-Za-z_][A-Za-z0-9_]*$/); assert.equal(typeof value, 'string'); assert.equal(/[\0\r\n]/.test(value), false);
    return `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  }).join('\n') + '\n';
}
export const environmentHash = value => hash(JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
export function systemdArgument(value) {
  assert.equal(typeof value, 'string'); assert.equal(/[\0\r\n%$]/.test(value), false);
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}
export function serviceCommand(release, dataDir, port, envFile) {
  assert.ok([dataDir, envFile, release.pg.postgresBinary].every(value => path.isAbsolute(value) && !/[\0\r\n%]/.test(value)));
  assert.equal(/\s/.test(envFile), false, 'Unambiguous private EnvironmentFile path required');
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const exitCommand = ['/usr/bin/env', '-u', 'NODE_OPTIONS', '--', release.nodeExecutable, fileURLToPath(new URL('./pg-exit-receipt.mjs', import.meta.url)),
    '--record-systemd-exit', '--release=' + release.releaseFile, '--release-sha256=' + release.releaseSha256].map(systemdArgument).join(' ');
  return ['/usr/bin/systemd-run', '--system', '--quiet', '--unit=' + unitName(release.nonce), '--service-type=exec',
    '--property=User=ubuntu', '--property=Group=ubuntu', '--property=Delegate=no', '--property=NoNewPrivileges=yes',
    '--property=ProtectControlGroups=yes', '--property=CapabilityBoundingSet=', '--property=AmbientCapabilities=',
    '--property=CPUAccounting=yes', '--property=MemoryAccounting=yes', '--property=TasksAccounting=yes',
    '--property=KillMode=control-group', '--property=KillSignal=SIGINT', '--property=TimeoutStopSec=30s',
    '--property=RuntimeMaxSec=1800s', '--property=Restart=no', '--property=RemainAfterExit=yes', '--property=SetLoginEnvironment=no',
    '--property=UnsetEnvironment=INVOCATION_ID JOURNAL_STREAM SYSTEMD_EXEC_PID NOTIFY_SOCKET LISTEN_FDS LISTEN_PID LISTEN_FDNAMES',
    '--property=ExecStopPost=' + exitCommand,
    '--property=EnvironmentFile=' + envFile, '--property=WorkingDirectory=' + release.appRoot,
    '--', release.pg.postgresBinary, '-D', dataDir, '-p', String(port)];
}
export function parseShow(text) {
  const result = {};
  for (const line of text.trim().split('\n')) { const at = line.indexOf('='); assert.ok(at > 0); const key = line.slice(0, at); assert.ok(showKeys.includes(key)); assert.equal(Object.hasOwn(result, key), false); result[key] = line.slice(at + 1); }
  return result;
}
export function microseconds(value) {
  if (/^[0-9]+$/.test(value)) return Number(value);
  const factors = { us: 1, ms: 1000, s: 1000000, min: 60000000, h: 3600000000 };
  const tokens = value.trim().split(/\s+/); let total = 0;
  for (const token of tokens) { const match = token.match(/^([0-9]+(?:\.[0-9]+)?)(us|ms|s|min|h)$/); assert.ok(match, 'Unqualified systemd duration'); total += Number(match[1]) * factors[match[2]]; }
  assert.ok(Number.isSafeInteger(total)); return total;
}
export function validateUnit(value, release, process, pidFile) {
  for (const [key, expected] of Object.entries({ Id: unitName(release.nonce), Type: 'exec', User: 'ubuntu', Group: 'ubuntu',
    LoadState: 'loaded', ActiveState: 'active', SubState: 'running', Transient: 'yes', Delegate: 'no', NoNewPrivileges: 'yes',
    ProtectControlGroups: 'yes', CapabilityBoundingSet: '', AmbientCapabilities: '', CPUAccounting: 'yes', MemoryAccounting: 'yes',
    KillSignal: '2', RemainAfterExit: 'yes', KillMode: 'control-group', Restart: 'no' })) assert.equal(value[key], expected, `PG unit ${key}`);
  assert.equal(microseconds(value.RuntimeMaxUSec), 1800000000); assert.equal(microseconds(value.TimeoutStopUSec), 30000000);
  assert.equal(Number(value.MainPID), process.pid); assert.equal(Number(pidFile[0]), process.pid);
  assert.equal(value.ControlGroup, '/system.slice/' + unitName(release.nonce));
  assert.match(value.InvocationID, /^[a-f0-9]{32}$/);
}
export function validateStatus(text, release) {
  const read = key => text.split('\n').find(row => row.startsWith(key + ':'))?.split(':')[1].trim();
  assert.ok(read('Uid')?.split(/\s+/).every(id => Number(id) === release.pg.uid));
  assert.ok(read('Gid')?.split(/\s+/).every(id => Number(id) === release.pg.gid));
  assert.equal(read('NoNewPrivs'), '1'); assert.match(read('CapEff'), /^0+$/); assert.match(read('CapBnd'), /^0+$/);
}
export async function controls(directory) {
  return Object.fromEntries(await Promise.all(CONTROL_FILES.map(async name => {
    try { return [name, (await readFile(path.join(directory, name), 'utf8')).trim()]; }
    catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error; }
  })));
}
async function systemctl(release, ...args) {
  return execute('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', ...args, unitName(release.nonce)], { timeout: 40_000, maxBuffer: 1024 * 1024 });
}
export async function serviceState(release, allowMissing = false) {
  try { return parseShow((await systemctl(release, 'show', '--property=' + showKeys.join(','))).stdout); }
  catch (error) {
    if (allowMissing && error.code === 1 && typeof error.stdout === 'string') {
      const value = parseShow(error.stdout); if (value.LoadState === 'not-found') return value;
    }
    throw error;
  }
}
export async function verifyPgService(release, receipt, expectedEnvironment = null) {
  const unit = await serviceState(release), pidFile = (await readFile(path.join(receipt.dataDir, 'postmaster.pid'), 'utf8')).trim().split(/\r?\n/);
  const current = parseProcIdentity(await readFile(`/proc/${receipt.pid}/stat`, 'utf8'));
  assert.equal(current.starttimeTicks, receipt.starttimeTicks); validateUnit(unit, release, current, pidFile);
  assert.equal(unit.InvocationID, receipt.invocationId); assert.equal(await shaFile(`/proc/${current.pid}/exe`), release.pg.postgresSha256);
  assert.equal(await realpath(`/proc/${current.pid}/exe`), release.pg.postgresBinary);
  assert.equal(parseUnifiedCgroup(await readFile(`/proc/${current.pid}/cgroup`, 'utf8')), unit.ControlGroup);
  assert.equal((await stat(receipt.cgroupPath)).ino, receipt.cgroupInode);
  for (const file of [receipt.cgroupPath, path.join(receipt.cgroupPath, 'cgroup.procs'), '/sys/fs/cgroup/system.slice/cgroup.procs']) {
    const info = await stat(file); assert.equal(info.uid, 0); assert.equal(info.mode & 0o022, 0, 'Application can migrate cgroups');
  }
  validateStatus(await readFile(`/proc/${current.pid}/status`, 'utf8'), release);
  const mount = (await readFile(`/proc/${current.pid}/mountinfo`, 'utf8')).split('\n').find(line => line.split(' ')[4] === '/sys/fs/cgroup');
  assert.ok(mount && mount.split(' ')[5].split(',').includes('ro') && mount.includes(' - cgroup2 '), 'PG cgroup mount must be read-only');
  assert.deepEqual(await controls(receipt.cgroupPath), release.pg.expectedEffectiveControls);
  assert.equal(hash(JSON.stringify(await controls('/sys/fs/cgroup/system.slice'))), release.pg.parentControlsSha256);
  const actualEnvironment = Object.fromEntries((await readFile(`/proc/${current.pid}/environ`, 'utf8')).split('\0').filter(Boolean).map(row => { const at = row.indexOf('='); return [row.slice(0, at), row.slice(at + 1)]; }));
  assert.equal(environmentHash(actualEnvironment), expectedEnvironment ? environmentHash(expectedEnvironment) : receipt.environmentSha256, 'PG environment differs from normal startup');
  assert.equal((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), receipt.bootId);
  return { verifiedAtMs: Date.now(), unit, controls: release.pg.expectedEffectiveControls, environmentSha256: environmentHash(actualEnvironment),
    cpu: await readFile(path.join(receipt.cgroupPath, 'cpu.stat'), 'utf8'), cgroupMembers: await readFile(path.join(receipt.cgroupPath, 'cgroup.procs'), 'utf8') };
}

export async function prestartAtNormalBoundary({ dataDir, configuredPort }) {
  const context = await loadRelease(process.env.PAPERCLIP_RESOURCE_RELEASE_FILE, process.env.PAPERCLIP_RESOURCE_RELEASE_SHA256);
  const { release, dependency } = context;
  release.releaseFile = process.env.PAPERCLIP_RESOURCE_RELEASE_FILE; release.releaseSha256 = process.env.PAPERCLIP_RESOURCE_RELEASE_SHA256; assert.equal(process.getuid(), release.pg.uid); assert.equal(userInfo().username, 'ubuntu');
  const home = await realpath(process.env.PAPERCLIP_HOME), configuration = await realpath(process.env.PAPERCLIP_CONFIG);
  assert.ok(configuration.startsWith(home + path.sep)); assert.ok(dataDir.startsWith(home + path.sep));
  const storedBytes = await readFile(configuration), stored = JSON.parse(storedBytes);
  assert.equal(stored.database.mode, 'embedded-postgres'); assert.equal(path.resolve(stored.database.embeddedPostgresDataDir), dataDir);
  assert.equal(stored.database.embeddedPostgresPort, configuredPort);
  const existing = await serviceState(release, true); assert.equal(existing.LoadState, 'not-found', 'Refuse existing unit');
  const cgroupPath = '/sys/fs/cgroup/system.slice/' + unitName(release.nonce);
  await assert.rejects(stat(cgroupPath), error => error.code === 'ENOENT');
  try { await mkdir(dataDir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  assert.deepEqual(await readdir(dataDir), [], 'Only fresh uninitialized PG is allowed');
  const require = createRequire(path.join(release.appRoot, 'server/package.json'));
  const embedded = path.dirname(path.dirname(require.resolve('embedded-postgres')));
  for (const [file, expected] of Object.entries(dependency.files)) assert.equal(await shaFile(path.join(embedded, file)), expected);
  assert.equal(JSON.parse(await readFile(path.join(embedded, 'package.json'), 'utf8')).version, dependency.version);
  const { default: getBinaries } = await import(pathToFileURL(path.join(embedded, 'dist/binary.js')).href);
  const resolvedNativeEntry = await realpath(createRequire(path.join(embedded, 'package.json')).resolve('@embedded-postgres/linux-x64'));
  assert.equal(resolvedNativeEntry, release.pg.nativeEntry); assert.equal(await shaFile(resolvedNativeEntry), release.pg.nativeEntrySha256);
  const binaries = await getBinaries();
  assert.equal(await realpath(binaries.postgres), release.pg.postgresBinary); assert.equal(await realpath(binaries.initdb), release.pg.initdbBinary);
  assert.equal(await realpath(require.resolve('detect-port')), release.pg.detectPortEntry);
  const detectPort = require('detect-port'); const port = await (detectPort.default ?? detectPort)(configuredPort);
  const env = { ...process.env, LC_MESSAGES: 'C' }, passwordFile = path.join(release.output, 'owned-initdb-password');
  const envFile = path.join(release.output, 'owned-pg-environment');
  await writeFile(path.join(release.output, 'pg-ownership.json'), JSON.stringify({ unit: unitName(release.nonce), dataDir, home,
    configuration, selectedPort: port, envFile, passwordFile, sourceReleaseSha256: process.env.PAPERCLIP_RESOURCE_RELEASE_SHA256,
    unitAbsentBefore: true, initializedAtMs: Date.now(), controlled: true }), { flag: 'wx', mode: 0o600 });
  await writeFile(passwordFile, 'paperclip\n', { flag: 'wx', mode: 0o600 });
  try {
    await execute(release.pg.initdbBinary, ['--pgdata=' + dataDir, '--auth=password', '--username=paperclip', '--pwfile=' + passwordFile,
      '--lc-messages=C', '--encoding=UTF8', '--locale=C', '--lc-messages=C'], { env, cwd: release.appRoot, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  } finally { await unlink(passwordFile); }
  await writeFile(envFile, environmentFile(env), { flag: 'wx', mode: 0o600 });
  const command = serviceCommand(release, dataDir, port, envFile);
  await writeFile(path.join(release.output, 'pg-start-attempt.json'), JSON.stringify({ nonce: release.nonce,
    sourceReleaseSha256: release.releaseSha256, unit: unitName(release.nonce), command, attemptedAtMs: Date.now() }), { flag: 'wx', mode: 0o600 });
  await execute('/usr/bin/sudo', ['-n', ...command], { env, timeout: 20_000, maxBuffer: 1024 * 1024 });
  const deadline = Date.now() + 60_000; let receipt;
  while (Date.now() < deadline) {
    const unit = await serviceState(release);
    assert.ok(['activating', 'active'].includes(unit.ActiveState), 'PG unit left startup/running');
    try {
      const lines = (await readFile(path.join(dataDir, 'postmaster.pid'), 'utf8')).trim().split(/\r?\n/);
      if (lines[7]?.trim() !== 'ready') { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
      const pid = Number(lines[0]), identity = parseProcIdentity(await readFile(`/proc/${pid}/stat`, 'utf8'));
      validateUnit(unit, release, identity, lines);
      assert.equal(await realpath(lines[1]), await realpath(dataDir)); assert.equal(Number(lines[3]), port);
      receipt = { schema: 'native-ingestion-systemd-pg-service/v1', diagnosticOnly: true, sourceReleaseSha256: process.env.PAPERCLIP_RESOURCE_RELEASE_SHA256,
        nonce: release.nonce, unit: unitName(release.nonce), exitWriterSha256: await shaFile(fileURLToPath(new URL('./pg-exit-receipt.mjs', import.meta.url))), pid, starttimeTicks: identity.starttimeTicks,
        invocationId: unit.InvocationID, bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
        dataDir: await realpath(dataDir), preferredPort: configuredPort, selectedPort: port, home, configuration, configurationSha256: hash(storedBytes),
        postgresExecutable: release.pg.postgresBinary, postgresSha256: release.pg.postgresSha256,
        cgroupPath, cgroupInode: (await stat(cgroupPath)).ino, environmentSha256: environmentHash(env),
        changedSupervision: 'Normal embedded initialization/argv/env; direct root-owned systemd service starts PG before normal supported reuse; private controller owns shutdown after app teardown',
        accountingEpoch: 'Fresh transient unit/path absent before direct exec; membership established by systemd before PG can fork; startup charged but outside all measured epoch differences' };
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(receipt, 'PG readiness deadline');
  await writeFile(path.join(release.output, 'pg-service.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  receipt.readyProof = await verifyPgService(release, receipt, env);
  await writeFile(path.join(release.output, 'pg-service.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
}

export function validateCleanupUnit(release, ownership, unit, identity, argv, receipt) {
  assert.equal(ownership.unit, unitName(release.nonce)); assert.equal(ownership.unitAbsentBefore, true);
  assert.equal(ownership.sourceReleaseSha256, release.releaseSha256);
  assert.equal(unit.Id, ownership.unit); assert.equal(unit.Transient, 'yes'); assert.equal(unit.User, 'ubuntu');
  assert.equal(Number(unit.MainPID), identity.pid);
  assert.deepEqual(argv, [release.pg.postgresBinary, '-D', ownership.dataDir, '-p', String(ownership.selectedPort)]);
  if (receipt) {
    assert.equal(receipt.sourceReleaseSha256, release.releaseSha256); assert.equal(receipt.nonce, release.nonce);
    assert.equal(identity.pid, receipt.pid); assert.equal(identity.starttimeTicks, receipt.starttimeTicks);
    assert.equal(unit.InvocationID, receipt.invocationId);
  }
}

export async function stopPgService(release) {
  let receipt, ownership, before, unit, stopped, exitProof, primary, unitNeverStarted = false, scopeAbsent = false, pidAbsent = false;
  const secondary = [], privateCleanup = [], expectedFiles = ['owned-pg-environment', 'owned-initdb-password'].map(name => path.join(release.output, name));
  const optionalJson = async name => {
    try { return await json(path.join(release.output, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  };
  try {
    receipt = await optionalJson('pg-service.json'); ownership = await json(path.join(release.output, 'pg-ownership.json'));
    assert.equal(ownership.unit, unitName(release.nonce)); assert.equal(ownership.unitAbsentBefore, true);
    assert.equal(ownership.sourceReleaseSha256, release.releaseSha256);
    assert.deepEqual([ownership.envFile, ownership.passwordFile], expectedFiles);
    const attempt = await optionalJson('pg-start-attempt.json');
    if (attempt) { assert.equal(attempt.nonce, release.nonce); assert.equal(attempt.sourceReleaseSha256, release.releaseSha256); assert.equal(attempt.unit, ownership.unit); }
    unit = await serviceState(release, true);
    if (Number(unit.MainPID) > 0) {
      const pid = Number(unit.MainPID), identity = parseProcIdentity(await readFile(`/proc/${pid}/stat`, 'utf8'));
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      validateCleanupUnit(release, ownership, unit, identity, argv, receipt);
      assert.equal(await shaFile(`/proc/${pid}/exe`), release.pg.postgresSha256);
      assert.equal(await realpath(`/proc/${pid}/exe`), release.pg.postgresBinary);
      try {
        const pidFile = (await readFile(path.join(ownership.dataDir, 'postmaster.pid'), 'utf8')).split(/\r?\n/);
        assert.equal(Number(pidFile[0]), pid); assert.equal(await realpath(pidFile[1]), await realpath(ownership.dataDir));
      } catch (error) { if (error.code !== 'ENOENT' || receipt) throw error; }
      before = { unit, identity, cpu: receipt ? await readFile(path.join(receipt.cgroupPath, 'cpu.stat'), 'utf8') : null };
    }
    if (unit.LoadState !== 'not-found') await systemctl(release, 'stop');
    // ExecStopPost already captured authentic exit metadata before unit GC.
    // Missing state proves absence only, never a successful exit.
    stopped = await serviceState(release, true);
    assert.ok(stopped.LoadState === 'not-found' || ['inactive', 'failed'].includes(stopped.ActiveState));
    if (stopped.LoadState !== 'not-found') assert.equal(Number(stopped.MainPID), 0);
    const known = receipt ?? before?.identity;
    if (known) { await assert.rejects(readFile(`/proc/${known.pid}/stat`), error => error.code === 'ENOENT'); pidAbsent = true; }
    const scope = path.join('/sys/fs/cgroup/system.slice', unitName(release.nonce)), deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { await stat(scope); } catch (error) { if (error.code === 'ENOENT') { scopeAbsent = true; break; } throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(scopeAbsent, true, 'PG scope did not retire');
    unitNeverStarted = !receipt && !attempt && unit.LoadState === 'not-found';
    if (!unitNeverStarted) {
      assert.ok(receipt, 'UNKNOWN PG shutdown: no ready identity receipt'); assert.equal(pidAbsent, true);
      const file = path.join(release.output, 'pg-systemd-exit.json'), info = await lstat(file);
      assert.ok(info.isFile() && info.uid === process.getuid() && !(info.mode & 0o077), 'Private regular exit receipt required');
      const bytes = await readFile(file); assert.ok(bytes.length <= 65536); exitProof = JSON.parse(bytes);
      validateExitProof(exitProof, release, receipt, await shaFile(path.join(release.output, 'pg-service.json')),
        await shaFile(fileURLToPath(new URL('./pg-exit-receipt.mjs', import.meta.url))));
    }
  } catch (error) { primary = error; }
  finally {
    // These exact private paths belong to this release's newly created output;
    // never let unit GC or a failed ownership proof retain their environment.
    for (const file of expectedFiles) {
      try { await unlink(file); privateCleanup.push({ file, removed: true }); }
      catch (error) {
        if (error.code === 'ENOENT') privateCleanup.push({ file, absent: true });
        else { primary ??= error; secondary.push({ phase: 'private-file-cleanup', error: String(error.message) }); }
      }
    }
  }
  const result = { complete: !primary, verifiedAtMs: Date.now(), beforeStop: before, stopped, scopeAbsent, pidAbsent,
    unitNeverStarted, normalPgShutdown: exitProof?.normalPgShutdown === true && !primary,
    exitProof: exitProof ?? null, shutdownClassification: unitNeverStarted ? 'NEVER_STARTED' : exitProof && !primary ? 'NORMAL' : 'UNKNOWN',
    privateCleanup, privateEnvironmentRemoved: privateCleanup.length === 2, secondary,
    failure: primary ? String(primary.message) : null, shutdownCpuIncludedInEventRatios: false };
  try { await writeFile(path.join(release.output, 'pg-cleanup.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { primary ??= error; }
  if (primary) throw primary; return result;
}
