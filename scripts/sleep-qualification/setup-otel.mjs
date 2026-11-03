import { lstat, mkdtemp, mkdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Explicit opt-in test setup. No manifests, lockfiles or other worktrees change.
const server = fileURLToPath(new URL('../../server/', import.meta.url));
export const otelPeerNames = ['@opentelemetry/sdk-node', '@opentelemetry/auto-instrumentations-node', '@opentelemetry/exporter-trace-otlp-http', '@opentelemetry/resources', '@opentelemetry/semantic-conventions'];
const ledgerPath = root => path.join(root, 'node_modules', '.paperclip-sleep-otel-links.json');
async function entryAt(destination) {
  try { return await lstat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function versionAt(root, name) {
  try { return JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return undefined; }
}
async function readOwnership(root) {
  const file = ledgerPath(root), entry = await entryAt(file);
  if (!entry) return [];
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('OTel ownership ledger must be a regular file');
  const record = JSON.parse(await readFile(file, 'utf8'));
  if (record.version !== 1 || record.serverDirectory !== root || !Array.isArray(record.links)
    || record.links.length > otelPeerNames.length || new Set(record.links.map(link => link.name)).size !== record.links.length
    || record.links.some(link => !otelPeerNames.includes(link.name) || typeof link.target !== 'string'
      || !path.isAbsolute(link.target) || path.resolve(link.target) !== link.target
      || !link.target.endsWith(path.join('node_modules', link.name)))) throw new Error('Invalid OTel ownership ledger');
  return record.links;
}
async function writeOwnership(root, links) {
  const file = ledgerPath(root);
  if (!links.length) { await rm(file, { force: true }); return; }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, serverDirectory: root, links }, null, 2), { flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
async function ownsLink(destination, record) {
  const entry = await entryAt(destination);
  return Boolean(record && entry?.isSymbolicLink()
    && path.resolve(path.dirname(destination), await readlink(destination)) === record.target);
}
async function installWithNpm(directory) {
  await new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], { stdio: 'inherit', shell: false });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`OTel fixture installation failed (${code})`)));
  });
}

/** Only the exact recorded symlink may be removed; install prefixes retain evidence. */
export async function cleanupSleepOtelLinks({ serverDirectory = server } = {}) {
  const root = path.resolve(serverDirectory), records = await readOwnership(root), remaining = [], removed = [], errors = [];
  for (const record of records) {
    const destination = path.join(root, 'node_modules', record.name);
    if (!await entryAt(destination)) continue;
    if (!await ownsLink(destination, record)) {
      remaining.push(record); errors.push(new Error(`Refusing to clean unrelated ${record.name}`)); continue;
    }
    await unlink(destination); removed.push(record.name);
  }
  await writeOwnership(root, remaining);
  if (errors.length) throw new AggregateError(errors, 'Some OTel destinations no longer match owned links');
  return { removed, installPrefixes: [...new Set(records.map(record => path.dirname(path.dirname(path.dirname(record.target)))))], boundary: 'Only recorded matching symlinks removed; temporary install prefixes are not deleted' };
}

export async function setupSleepOtelPeers({ serverDirectory = server, temporaryRoot = tmpdir(), install = installWithNpm } = {}) {
  const root = path.resolve(serverDirectory), manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const owned = await readOwnership(root), missing = [];
  for (const name of otelPeerNames) {
    const exact = manifest.peerDependencies[name];
    if (!/^\d+\.\d+\.\d+$/.test(exact ?? '')) throw new Error(`Exact existing peer version required for ${name}`);
    const installed = await versionAt(root, name);
    if (installed && installed !== exact) throw new Error(`Installed ${name} does not match ${exact}; refusing to replace it`);
    if (installed) continue;
    const destination = path.join(root, 'node_modules', name);
    if (await entryAt(destination) && !await ownsLink(destination, owned.find(link => link.name === name))) {
      throw new Error(`Refusing to replace unrelated ${name}; restore its target or verify ownership before removing the unrecorded entry`);
    }
    missing.push(name);
  }
  if (!missing.length) return { linked: [], alreadyInstalled: true };
  const directory = await mkdtemp(path.join(temporaryRoot, 'paperclip-sleep-otel-'));
  let linked = 0;
  try {
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ private: true, dependencies: Object.fromEntries(otelPeerNames.map(name => [name, manifest.peerDependencies[name]])) }, null, 2));
    await install(directory);
    const resolved = Object.fromEntries(await Promise.all(otelPeerNames.map(async name => [name, await versionAt(directory, name)])));
    for (const name of otelPeerNames) if (resolved[name] !== manifest.peerDependencies[name]) throw new Error(`Resolved ${name} differs from pinned peer`);
    const records = [...owned];
    for (const name of missing) {
      const destination = path.join(root, 'node_modules', name), previous = owned.find(record => record.name === name);
      await mkdir(path.dirname(destination), { recursive: true });
      if (await entryAt(destination)) {
        if (!await ownsLink(destination, previous)) throw new Error(`OTel destination changed; refusing to replace ${name}`);
        await unlink(destination);
      }
      const target = path.join(directory, 'node_modules', name);
      await symlink(target, destination, 'dir'); linked++;
      const updated = [...records.filter(record => record.name !== name), { name, target }];
      try { await writeOwnership(root, updated); }
      catch (error) {
        if (await ownsLink(destination, { name, target })) { await unlink(destination); linked--; }
        throw error;
      }
      records.splice(0, records.length, ...updated);
    }
    const receipt = { version: 1, directory, packages: resolved, linked: missing, ownershipLedger: ledgerPath(root), cleanup: 'node scripts/sleep-qualification/setup-otel.mjs --cleanup' };
    await writeFile(path.join(directory, 'qualification-setup.json'), JSON.stringify(receipt, null, 2));
    return receipt;
  } catch (error) {
    // A prefix with published links stays available for explicit owned cleanup.
    if (!linked) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== '--cleanup')) throw new Error('Usage: node scripts/sleep-qualification/setup-otel.mjs [--cleanup]');
  const receipt = args[0] === '--cleanup' ? await cleanupSleepOtelLinks() : await setupSleepOtelPeers();
  process.stdout.write(JSON.stringify(receipt) + '\n');
}
