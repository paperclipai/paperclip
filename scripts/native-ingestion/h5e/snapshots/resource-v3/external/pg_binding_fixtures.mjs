// Pure synthetic inputs. No filesystem, process or database inspection.
import { createHash } from 'node:crypto';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function procStat(pid, ppid, birth, state = 'S') {
  const fields = [state, ppid, pid, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, birth, 0, 1];
  return `${pid} (postgres ) name) ${fields.join(' ')}`;
}
export function fixture() {
  const binary = Buffer.from('qualified-unit-postgres-executable');
  const stored = { database: { mode: 'embedded-postgres', embeddedPostgresDataDir: '/owned/db', embeddedPostgresPort: 55432 } };
  const storedBytes = Buffer.from(JSON.stringify(stored));
  const hash = 'a'.repeat(64);
  const config = { schema: 'native-ingestion-pg-resource-config/v2', diagnosticOnly: true, nonce: 'pure_test_nonce',
    intervalMs: 1000, maxDurationMs: 1800000, maxOutputBytes: 64000000,
    expectedBootId: '00000000-0000-4000-8000-000000000001',
    owningReleaseSha256: hash, qualifiedBuildSha256: hash, driverIndexSha256: hash,
    driverConnectionSha256: hash, driverPackageSha256: hash, snapshotSqlSha256: hash, clusterBindingModuleSha256: hash,
    driverIndexPath: '/unit/postgres/src/index.js', driverConnectionPath: '/unit/postgres/src/connection.js',
    expectedDatabaseOid: 42, expectedDatabaseName: 'paperclip', expectedPostmasterPid: 100,
    expectedPostmasterBirthTicks: '50', expectedPostgresExecutableSha256: digest(binary),
    ownedServerHomePath: '/owned', ownedServerConfigPath: '/owned/instance/config.json',
    ownedServerConfigSha256: digest(storedBytes), expectedDataDirectory: '/owned/db',
    expectedPort: 55432, expectedConfiguredPort: 55432,
    expectedPostgresCgroup: { path: '/sys/fs/cgroup/unit-pg', inode: 55, qualificationReceiptSha256: hash } };
  const identity = { serverVersion: 180000, databaseOid: 42, databaseName: 'paperclip', observerBackendPid: 300,
    postmasterStartEpochMs: 1000000.123, dataDirectory: '/owned/db', configuredServerPort: 55432,
    serverAddress: '127.0.0.1', clientAddress: '127.0.0.1', serverPort: 55432, transactionReadOnly: 'on' };
  const files = new Map([
    ['/owned/instance/config.json', storedBytes], ['/owned/db/postmaster.pid', Buffer.from('100\n/owned/db\n1000\n55432\n')],
    ['/proc/sys/kernel/random/boot_id', Buffer.from(config.expectedBootId)],
  ]);
  const links = new Map([['/proc/self/ns/pid', 'pid:[1]'], ['/proc/self/ns/net', 'net:[2]']]);
  const paths = new Map();
  const metadata = { dev: 1, ino: 10, size: binary.length, mtimeMs: 1000 };
  const stats = new Map([['/sys/fs/cgroup/unit-pg', { ino: 55 }]]);
  for (const [pid, ppid, birth] of [[100, 1, '50'], [300, 100, '60']]) {
    files.set(`/proc/${pid}/stat`, Buffer.from(procStat(pid, ppid, birth)));
    files.set(`/proc/${pid}/exe`, binary);
    files.set(`/proc/${pid}/cgroup`, Buffer.from('0::/unit-pg\n'));
    links.set(`/proc/${pid}/ns/pid`, 'pid:[1]'); links.set(`/proc/${pid}/ns/net`, 'net:[2]');
    paths.set(`/proc/${pid}/exe`, '/unit/postgres/bin/postgres');
    stats.set(`/proc/${pid}/exe`, { ...metadata });
  }
  const calls = [];
  const missing = () => Object.assign(new Error('synthetic_missing'), { code: 'ENOENT' });
  const io = { readFile: async name => { calls.push(['read', name]); if (!files.has(name)) throw missing(); return files.get(name); },
    realpath: async name => { calls.push(['realpath', name]); return paths.get(name) ?? name; },
    readlink: async name => { calls.push(['readlink', name]); if (!links.has(name)) throw missing(); return links.get(name); },
    stat: async name => { calls.push(['stat', name]); if (!stats.has(name)) throw missing(); return stats.get(name); } };
  const setStored = value => {
    const bytes = Buffer.from(JSON.stringify(value)); files.set(config.ownedServerConfigPath, bytes);
    config.ownedServerConfigSha256 = digest(bytes);
  };
  const snapshot = () => ({ ...identity, serverEpochMs: 1234, activityCapExceeded: false, lockCapExceeded: false,
    activity: [], locks: [], databaseStats: { stats_reset: null } });
  return { config, stored, identity, files, links, paths, stats, calls, io, setStored, snapshot };
}
