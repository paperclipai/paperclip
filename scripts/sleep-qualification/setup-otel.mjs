import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Explicit opt-in test setup. Leaves package manifests, lockfiles and other worktrees untouched.
const server = fileURLToPath(new URL('../../server/', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(server, 'package.json'), 'utf8'));
const names = ['@opentelemetry/sdk-node', '@opentelemetry/auto-instrumentations-node', '@opentelemetry/exporter-trace-otlp-http', '@opentelemetry/resources', '@opentelemetry/semantic-conventions'];
async function versionAt(root, name) {
  try { return JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return undefined; }
}
const missing = [];
for (const name of names) {
  const exact = manifest.peerDependencies[name];
  if (!/^\d+\.\d+\.\d+$/.test(exact ?? '')) throw new Error(`Exact existing peer version required for ${name}`);
  const installed = await versionAt(server, name);
  if (installed && installed !== exact) throw new Error(`Installed ${name} does not match ${exact}; refusing to replace it`);
  if (!installed) missing.push(name);
}
if (!missing.length) { process.stdout.write('All configured OTel peers already match the manifest.\n'); process.exit(0); }
const directory = await mkdtemp(path.join(tmpdir(), 'paperclip-sleep-otel-'));
await writeFile(path.join(directory, 'package.json'), JSON.stringify({ private: true, dependencies: Object.fromEntries(names.map(name => [name, manifest.peerDependencies[name]])) }, null, 2));
await new Promise((resolve, reject) => {
  const child = spawn('npm', ['install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], { stdio: 'inherit', shell: false });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`OTel fixture installation failed (${code})`)));
});
const resolved = Object.fromEntries(await Promise.all(names.map(async name => [name, await versionAt(directory, name)])));
for (const name of names) if (resolved[name] !== manifest.peerDependencies[name]) throw new Error(`Resolved ${name} differs from pinned peer`);
for (const name of missing) {
  const destination = path.join(server, 'node_modules', name);
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(path.join(directory, 'node_modules', name), destination, 'dir');
}
await writeFile(path.join(directory, 'qualification-setup.json'), JSON.stringify({ version: 1, packages: resolved, linked: missing }, null, 2));
process.stdout.write(`OTel fixture peers installed; retain ${directory}/qualification-setup.json and package-lock.json as setup evidence.\n`);
