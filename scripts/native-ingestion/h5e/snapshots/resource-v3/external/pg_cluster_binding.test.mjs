import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateClusterConfig, localConnectionOptions, createClusterObserver, assertClusterBinding,
  parseProcIdentity, parseUnifiedCgroup } from './pg_cluster_binding.mjs';
import { validateSnapshot } from './pg_resources.mjs';
import { fixture, procStat } from './pg_binding_fixtures.mjs';

test('actual V1 source accepts a same-OID wrong cluster; V2 rejects its URL, parent and data identity', async () => {
  const value = fixture();
  const startup = await readFile(new URL('./before-source/startup-cluster-check.v1.txt', import.meta.url), 'utf8');
  const snapshotSource = await readFile(new URL('./before-source/validate-snapshot.v1.txt', import.meta.url), 'utf8');
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const originalStartup = new AsyncFunction('assert', 'identity', 'config', 'readFile', startup);
  const originalSnapshot = Function('assert', snapshotSource.replace(/^export /, '') + '; return validateSnapshot;')(assert);
  const reads = [];
  // SQL belongs to another postmaster; original startup only checks unrelated owned PID100.
  await originalStartup(assert, { version: 180000, database_oid: 42, backend_pid: 300, postmaster_start: 'foreign' },
    value.config, async name => { reads.push(name); return procStat(100, 1, '50'); });
  assert.deepEqual(reads, ['/proc/100/stat']);
  assert.equal(originalSnapshot({ ...value.snapshot(), dataDirectory: '/foreign/db', serverPort: 55433 }, 42, 300).databaseOid, 42);
  assert.throws(() => localConnectionOptions('postgres://unit:unit@127.0.0.1:55433/paperclip', value.config));
  value.files.set('/proc/300/stat', Buffer.from(procStat(300, 200, '60')));
  await assert.rejects(createClusterObserver(value.config, value.io)(300), /direct child/);
  value.files.set('/proc/300/stat', Buffer.from(procStat(300, 100, '60')));
  const observed = await createClusterObserver(value.config, value.io)(300);
  assert.throws(() => assertClusterBinding({ ...value.identity, dataDirectory: '/foreign/db' }, observed, value.config));
});

test('valid owned cluster binds SQL, postmaster and backend and remains stable across repeated samples', async () => {
  const value = fixture(), observe = createClusterObserver(value.config, value.io);
  const before = await observe(300), binding = assertClusterBinding(value.identity, before, value.config);
  assert.equal(binding.observed.observer.ppid, 100);
  assert.equal(binding.observed.observer.starttimeTicks, '60');
  assert.equal(binding.observed.scope.inode, 55);
  const after = await observe(300);
  assert.deepEqual(assertClusterBinding(value.identity, after, value.config, binding), binding);
  assert.equal(validateSnapshot(value.snapshot(), value.config, binding, after).observerBackendPid, 300);
});

test('connection options require explicit local TCP, database and credentials without query/env overrides', () => {
  const { config } = fixture();
  assert.deepEqual(localConnectionOptions('postgres://unit:unit-pass@127.0.0.1:55432/paperclip', config),
    { host: '127.0.0.1', port: 55432, database: 'paperclip', username: 'unit', password: 'unit-pass', ssl: false });
  for (const url of ['postgres://unit:unit@localhost:55432/paperclip', 'postgres://unit:unit@[::1]:55432/paperclip',
    'postgres://unit:unit@remote.example:55432/paperclip', 'postgres://unit:unit@127.0.0.1/paperclip',
    'postgres://unit:unit@127.0.0.1:55432/foreign', 'postgres://unit:unit@127.0.0.1:55432/paperclip?host=foreign',
    'postgres://unit:unit@127.0.0.1:55432/paperclip#fragment', 'postgres://127.0.0.1:55432/paperclip']) {
    assert.throws(() => localConnectionOptions(url, config));
  }
});

test('same observer PID with a new birth is rejected on the next sample', async () => {
  const value = fixture(), observe = createClusterObserver(value.config, value.io);
  const binding = assertClusterBinding(value.identity, await observe(300), value.config);
  value.files.set('/proc/300/stat', Buffer.from(procStat(300, 100, '61')));
  const changed = await observe(300);
  assert.throws(() => assertClusterBinding(value.identity, changed, value.config, binding), /ownership changed/);
});

test('changed backend parent, root birth, dead state or missing process cannot preserve binding', async () => {
  for (const mutate of [v => v.files.set('/proc/300/stat', Buffer.from(procStat(300, 200, '60'))),
    v => v.files.set('/proc/100/stat', Buffer.from(procStat(100, 1, '51'))),
    v => v.files.set('/proc/300/stat', Buffer.from(procStat(300, 100, '60', 'Z'))),
    v => v.files.delete('/proc/300/stat'), v => v.files.delete('/proc/100/stat')]) {
    const value = fixture(); mutate(value);
    await assert.rejects(createClusterObserver(value.config, value.io)(300));
  }
});

test('postmaster reparenting after initial proof invalidates the later sample', async () => {
  const value = fixture(), observe = createClusterObserver(value.config, value.io);
  const binding = assertClusterBinding(value.identity, await observe(300), value.config);
  value.files.set('/proc/100/stat', Buffer.from(procStat(100, 2, '50')));
  const changed = await observe(300);
  assert.throws(() => assertClusterBinding(value.identity, changed, value.config, binding));
});

test('birth or parent changes during one process read are rejected', async () => {
  for (const changed of [procStat(300, 100, '61'), procStat(300, 200, '60')]) {
    const value = fixture(); let calls = 0;
    const readFile = value.io.readFile;
    const io = { ...value.io, readFile: async name => {
      if (name === '/proc/300/stat' && ++calls > 1) return Buffer.from(changed);
      return readFile(name);
    } };
    await assert.rejects(createClusterObserver(value.config, io)(300), /birth\/parent changed/);
  }
});

test('boot, PID namespace or network namespace disagreement is rejected', async () => {
  for (const mutate of [v => v.files.set('/proc/sys/kernel/random/boot_id', Buffer.from('00000000-0000-4000-8000-000000000002')),
    v => v.links.set('/proc/300/ns/pid', 'pid:[99]'), v => v.links.set('/proc/100/ns/net', 'net:[99]'),
    v => v.links.delete('/proc/300/ns/pid')]) {
    const value = fixture(); mutate(value);
    await assert.rejects(createClusterObserver(value.config, value.io)(300));
  }
});

test('actual backend executable hash or identity changes are rejected', async () => {
  const value = fixture();
  value.files.set('/proc/300/exe', Buffer.from('foreign postgres executable'));
  value.stats.set('/proc/300/exe', { dev: 1, ino: 11, size: 27, mtimeMs: 1001 });
  await assert.rejects(createClusterObserver(value.config, value.io)(300));
  const changed = fixture(); let reads = 0;
  const originalStat = changed.io.stat;
  const io = { ...changed.io, stat: async name => {
    const row = await originalStat(name);
    return name === '/proc/300/exe' && ++reads > 1 ? { ...row, ino: 99 } : row;
  } };
  await assert.rejects(createClusterObserver(changed.config, io)(300));
});

test('data-directory, configured preferred port, selected PID-file port and PID must match owned config', async () => {
  for (const mutate of [v => v.setStored({ database: { ...v.stored.database, embeddedPostgresDataDir: '/foreign/db' } }),
    v => v.setStored({ database: { ...v.stored.database, embeddedPostgresPort: 55433 } }),
    v => v.files.set('/owned/db/postmaster.pid', Buffer.from('101\n/owned/db\n1000\n55432\n')),
    v => v.files.set('/owned/db/postmaster.pid', Buffer.from('100\n/foreign/db\n1000\n55432\n')),
    v => v.files.set('/owned/db/postmaster.pid', Buffer.from('100\n/owned/db\n1000\n55433\n')),
    v => v.files.set('/owned/instance/config.json', Buffer.from('{}'))]) {
    const value = fixture(); mutate(value);
    await assert.rejects(createClusterObserver(value.config, value.io)(300));
  }
});

test('explicit normal selected-port fallback is allowed only when both preferred and actual ports are pinned', async () => {
  const value = fixture();
  value.config.expectedConfiguredPort = 55431;
  value.setStored({ database: { ...value.stored.database, embeddedPostgresPort: 55431 } });
  const observed = await createClusterObserver(value.config, value.io)(300);
  assert.equal(assertClusterBinding(value.identity, observed, value.config).observed.selectedPort, 55432);
});

test('SQL data directory, server/listen ports, endpoint, DB and readonly state are checked every sample', async () => {
  const value = fixture(), observe = createClusterObserver(value.config, value.io);
  const observed = await observe(300), binding = assertClusterBinding(value.identity, observed, value.config);
  for (const [key, entry] of [['dataDirectory', '/foreign/db'], ['configuredServerPort', 55433],
    ['serverPort', 55433], ['serverAddress', '::1'], ['clientAddress', '10.0.0.1'], ['databaseName', 'foreign'],
    ['transactionReadOnly', 'off'], ['postmasterStartEpochMs', 1000001.123]]) {
    assert.throws(() => validateSnapshot({ ...value.snapshot(), [key]: entry }, value.config, binding, observed));
  }
});

test('backend and postmaster must remain inside the explicitly pinned cgroup identity', async () => {
  for (const mutate of [v => v.files.set('/proc/300/cgroup', Buffer.from('0::/foreign\n')),
    v => v.files.set('/proc/100/cgroup', Buffer.from('0::/foreign\n')),
    v => v.stats.set('/sys/fs/cgroup/unit-pg', { ino: 56 })]) {
    const value = fixture(); mutate(value);
    await assert.rejects(createClusterObserver(value.config, value.io)(300));
  }
  const noAggregate = fixture(); noAggregate.config.expectedPostgresCgroup = null;
  const observed = await createClusterObserver(noAggregate.config, noAggregate.io)(300);
  assert.equal(observed.scope, null);
  assert.equal(assertClusterBinding(noAggregate.identity, observed, noAggregate.config).observed.observer.cgroup, '/unit-pg');
});

test('config excludes external DB mode, unowned directories and ambiguous namespace cgroups', () => {
  const { config } = fixture();
  validateClusterConfig(config);
  assert.throws(() => validateClusterConfig({ ...config, expectedDataDirectory: '/foreign/db' }));
  assert.throws(() => validateClusterConfig({ ...config, expectedPostgresCgroup: { ...config.expectedPostgresCgroup, path: '/sys/fs/cgroup' } }));
  assert.throws(() => parseUnifiedCgroup('1:cpu:/other\n0::/unit-pg\n'));
  assert.throws(() => parseUnifiedCgroup('0::/unit-pg/../foreign\n'));
  assert.deepEqual(parseProcIdentity(procStat(300, 100, '60')), { pid: 300, ppid: 100, starttimeTicks: '60' });
});

test('before-source fragments match the preserved V1 manifest and are self-contained', async () => {
  const manifest = JSON.parse(await readFile(new URL('./before-source/manifest.json', import.meta.url)));
  assert.equal(manifest.parentPacketSha256, 'd62a246808edb1d8de195aa0abd847feac139a58aa451faedbc8d35a4be8058b');
  for (const row of manifest.fragments) {
    const bytes = await readFile(new URL('./before-source/' + row.path, import.meta.url));
    assert.equal(bytes.length, row.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
  }
});
