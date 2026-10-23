import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const catalogFile = 'registry-packages.json';
const packageName = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/;

export async function writePackedRegistryCatalog(directory) {
  const entries = [];
  for (const file of readdirSync(directory).filter(file => file.endsWith('.tgz')).sort()) {
    const archive = join(directory, file);
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], {
      encoding: 'utf8', maxBuffer: 1024 * 1024,
    }));
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    entries.push({ file, manifest, integrity: `sha512-${hash.digest('base64')}` });
  }
  assert.ok(entries.length, 'The registry requires actual packed artifacts');
  writeFileSync(join(directory, catalogFile), JSON.stringify(entries));
  return entries;
}

export async function startPackedRegistry(directory) {
  const entries = JSON.parse(readFileSync(join(directory, catalogFile), 'utf8'));
  const packages = new Map();
  for (const entry of entries) {
    assert.match(entry.file, /^[a-zA-Z0-9._-]+\.tgz$/);
    assert.match(entry.manifest.name, packageName);
    assert.equal(typeof entry.manifest.version, 'string');
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    assert.ok(!packages.has(entry.manifest.name), 'Duplicate packed package');
    packages.set(entry.manifest.name, entry);
  }
  let url;
  const server = createServer((request, response) => {
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    let path;
    try { path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1)); }
    catch { response.writeHead(400).end(); return; }
    const tarball = /^-\/(\d+)\.tgz$/.exec(path);
    if (tarball) {
      const entry = entries[Number(tarball[1])];
      if (!entry) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      pipeline(createReadStream(join(directory, entry.file)), response).catch(() => response.destroy());
      return;
    }
    if (!packageName.test(path)) { response.writeHead(404).end(); return; }
    const entry = packages.get(path);
    if (!entry) {
      response.writeHead(302, { location: `https://registry.npmjs.org/${path.replace('/', '%2f')}` }).end();
      return;
    }
    const { manifest, integrity } = entry;
    const version = { ...manifest, dist: { tarball: `${url}/-/${entries.indexOf(entry)}.tgz`, integrity } };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: version } }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    specs: entries.map(({ manifest }) => `${manifest.name}@${manifest.version}`),
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Usage: public-install-registry.mjs PACKED_ASSETS');
  const registry = await startPackedRegistry(process.argv[2]);
  try {
    const status = await new Promise((resolve, reject) => {
      const child = spawn('npm', ['install', '--registry', registry.url, '--replace-registry-host=never', '--ignore-scripts', '--omit=dev', ...registry.specs], { stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) => signal ? reject(new Error(`npm install received ${signal}`)) : resolve(code));
    });
    process.exitCode = status;
  } finally { await registry.close(); }
}
