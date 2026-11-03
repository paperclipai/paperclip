// Test-only assembly of the normal remote sandbox path. The sandbox plugin
// executes separate OS processes on this same host; TLS and runtime authority
// follow the production direct-outbound contract.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { createServer } from 'node:tls';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.PAPERCLIP_INGESTION_TRANSPORT, 'sandbox-remote-with-local-stop');
assert.ok(process.env.PAPERCLIP_HOME && process.env.PAPERCLIP_CONFIG);
assert.ok(!process.env.DATABASE_URL, 'Remote fixture requires its disposable embedded database');
assert.ok(!process.env.PAPERCLIP_RUNNER_STATE_DIR, 'H4 uses the normal owned instance journal directory');
assert.ok(path.resolve(process.env.PAPERCLIP_CONFIG).startsWith(`${path.resolve(process.env.PAPERCLIP_HOME)}${path.sep}`));
const ownedHome = await realpath(process.env.PAPERCLIP_HOME);
const ownedConfiguration = await realpath(process.env.PAPERCLIP_CONFIG);
assert.ok(ownedConfiguration.startsWith(`${ownedHome}${path.sep}`));
const configuration = JSON.parse(await readFile(ownedConfiguration, 'utf8'));
assert.equal(configuration.database.mode, 'embedded-postgres');
const databaseDirectory = path.resolve(configuration.database.embeddedPostgresDataDir);
assert.ok((await realpath(path.dirname(databaseDirectory))).startsWith(`${ownedHome}${path.sep}`));
try {
  const info = await lstat(databaseDirectory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await mkdir(databaseDirectory, { mode: 0o700 });
}
assert.ok((await realpath(databaseDirectory)).startsWith(`${ownedHome}${path.sep}`));
assert.ok(process.argv.includes('--compiled-entry=server/dist/index.js'));
const appRoot = process.cwd();
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8' }).trim();
const build = JSON.parse(await readFile(path.join(appRoot, 'server/dist/build-info.json'), 'utf8'));
assert.equal(build.commit, revision, 'Remote fixture requires the matching compiled application');
const directory = path.join(process.env.PAPERCLIP_HOME, 'ingestion-remote-fixture');
await mkdir(directory, { recursive: true, mode: 0o700 });
const key = path.join(directory, 'loopback-key.pem'), cert = path.join(directory, 'loopback-server.pem');
const caKey = path.join(directory, 'loopback-ca-key.pem'), ca = path.join(directory, 'loopback-ca.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
  '-keyout', caKey, '-out', ca, '-subj', '/CN=Paperclip ingestion fixture CA',
  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], { stdio: 'ignore' });
const request = path.join(directory, 'loopback-server.csr'), extensions = path.join(directory, 'loopback-server.ext');
await writeFile(extensions, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n', { mode: 0o600 });
execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
  '-keyout', key, '-out', request, '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
execFileSync('openssl', ['x509', '-req', '-in', request, '-CA', ca, '-CAkey', caKey, '-CAcreateserial',
  '-out', cert, '-days', '2', '-sha256', '-extfile', extensions], { stdio: 'ignore' });
execFileSync('openssl', ['verify', '-CAfile', ca, cert], { stdio: 'ignore' });
const fixture = path.resolve(import.meta.dirname, 'in-feed-codex.mjs');
const wrapper = path.join(directory, 'codex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(wrapper, `#!/bin/sh\nexport PAPERCLIP_INGESTION_FIXTURE_LAUNCHER=staged-remote\nexport PAPERCLIP_INGESTION_FIXTURE_PID=$$\nexec ${quote(process.execPath)} ${quote(fixture)} --ingestion-stream-fixture "$@"\n`, { mode: 0o700 });
const runner = process.env.PAPERCLIP_RUNNER_REMOTE_BINARY_PATH
  ?? path.join(appRoot, 'packages/paperclip-runner/runner/target/release/paperclip-runnerd');
const runnerMetadata = JSON.parse(execFileSync(runner, ['--build-metadata'], { encoding: 'utf8' }));
const sockets = new Set();
const proxy = createServer({ key: await readFile(key), cert: await readFile(cert) }, socket => {
  const upstream = createConnection({ host: '127.0.0.1', port: Number(process.env.PORT) });
  for (const connection of [socket, upstream]) {
    sockets.add(connection); connection.on('close', () => sockets.delete(connection));
    connection.on('error', () => { socket.destroy(); upstream.destroy(); });
  }
  socket.pipe(upstream).pipe(socket);
});
await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
const address = proxy.address();
assert.ok(address && typeof address !== 'string');
process.env.PAPERCLIP_RUNNER_PUBLIC_URL = `wss://127.0.0.1:${address.port}`;
process.env.PAPERCLIP_RUNNER_CA_BUNDLE_PATH = ca;
process.env.PAPERCLIP_RUNNER_REMOTE_BINARY_PATH = runner;
process.env.PAPERCLIP_RUNNER_REMOTE_CODEX_PATH = wrapper;
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const provenance = { transport: 'sandbox-remote', provisioning: 'First-party fake-plugin; separate OS processes on this same physical host',
  revision, buildRevision: build.commit, runnerPublicUrl: process.env.PAPERCLIP_RUNNER_PUBLIC_URL,
  tls: { peerVerification: true, caSha256: await hash(ca), serverCertificateSha256: await hash(cert), subjectAlternativeNames: ['127.0.0.1', 'localhost'] },
  runner: { path: runner, sha256: await hash(runner), metadata: runnerMetadata },
  provider: { wrapper, wrapperSha256: await hash(wrapper), node: process.execPath, nodeVersion: process.version, nodeSha256: await hash(process.execPath),
    fixture, fixtureSha256: await hash(fixture) } };
await writeFile(path.join(process.env.PAPERCLIP_HOME, 'ingestion-remote-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
const { startServer } = await import(pathToFileURL(path.join(appRoot, 'server/dist/index.js')).href);
try { await startServer(); }
catch (error) { for (const socket of sockets) socket.destroy(); proxy.close(); throw error; }
