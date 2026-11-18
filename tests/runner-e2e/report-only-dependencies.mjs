// Explicit reporting checkout preparation only. Never call on a product/SDK build.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const extras = new Map([
  ['@grpc/grpc-js@1.14.5', 'patches/@grpc__grpc-js@1.14.5.patch'],
  ['@photon-ai/advanced-imessage@2.2.0', 'patches/@photon-ai__advanced-imessage@2.2.0.patch'],
]);
const fail = () => { throw new Error('Reporting dependency configuration is not compatible with the reviewed lock'); };
function scalar(value) {
  if (value.startsWith('"')) { const parsed = JSON.parse(value); if (typeof parsed !== 'string') fail(); return parsed; }
  if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
  if (!/^[A-Za-z0-9@_./+*^~<>=:|()%,-]+$/.test(value)) fail();
  return value;
}
function block(text, name) {
  if (text.length > 8 * 1024 * 1024 || text.includes('\r') || text.includes('\t')) fail();
  const lines = text.split('\n'), starts = lines.flatMap((line, i) => line === name + ':' ? [i] : []);
  if (starts.length !== 1) fail();
  const start = starts[0] + 1;
  let end = start;
  while (end < lines.length && (!lines[end] || lines[end].startsWith(' ') || lines[end].startsWith('#'))) end++;
  return { lines, start, end, body: lines.slice(start, end).filter(line => line && !line.trimStart().startsWith('#')) };
}
function put(map, key, value) { if (map.has(key)) fail(); map.set(key, value); }
function patchInventory(lock, hashes) {
  const lines = block(lock, 'patchedDependencies').body, entries = new Map();
  for (let i = 0; i < lines.length; i += 3) {
    const key = /^  (.+):$/.exec(lines[i] ?? ''), digest = /^    hash: ([a-z0-9]+)$/.exec(lines[i + 1] ?? ''), file = /^    path: (.+)$/.exec(lines[i + 2] ?? '');
    if (!key || !digest || !file) fail();
    const name = scalar(key[1]), filePath = scalar(file[1]);
    if (!/^patches\/[A-Za-z0-9@_.+-]+\.patch$/.test(filePath)) fail();
    put(entries, name, filePath);
    hashes.set(name, digest[1]);
  }
  if (!entries.size) fail();
  return entries;
}
function configurationExtras(entries, reviewed) {
  for (const [name, file] of reviewed) if (entries.get(name) !== file) fail();
  const remove = [];
  for (const [name, file] of entries) {
    if (reviewed.has(name)) continue;
    if (extras.get(name) !== file) fail();
    remove.push(name);
  }
  return remove.sort();
}
// Read only named entries from the authenticated canonical importer inventory.
// This does not reconstruct importers, resolve versions, or admit unknown drift.
function reviewedDependency(lock, importer, name) {
  const lines = block(lock, 'importers').body;
  const starts = lines.flatMap((line, i) => line === `  ${importer}:` ? [i] : []);
  if (starts.length !== 1) fail();
  let end = starts[0] + 1;
  while (end < lines.length && !/^  \S/.test(lines[end])) end++;
  const body = lines.slice(starts[0] + 1, end);
  const group = body.indexOf('    dependencies:');
  if (group < 0) fail();
  let groupEnd = group + 1;
  while (groupEnd < body.length && !/^    \S/.test(body[groupEnd])) groupEnd++;
  const entries = body.slice(group + 1, groupEnd);
  const matches = entries.flatMap((line, i) => {
    const match = /^      (.+):$/.exec(line);
    return match && scalar(match[1]) === name ? [i] : [];
  });
  if (matches.length === 0) return null;
  if (matches.length !== 1) fail();
  const i = matches[0], specifier = /^        specifier: (.+)$/.exec(entries[i + 1] ?? ''), version = /^        version: (.+)$/.exec(entries[i + 2] ?? '');
  if (!specifier || !version) fail();
  return { specifier: scalar(specifier[1]), version: scalar(version[1]) };
}
function reportingDbPins(lock, hashes, db, cli) {
  const postgres = reviewedDependency(lock, 'packages/db', 'postgres');
  const drizzle = reviewedDependency(lock, 'packages/db', 'drizzle-orm');
  const cliPostgres = reviewedDependency(lock, 'cli', 'postgres');
  // Already canonical is not drift: never constrain a trusted refresh to old versions.
  if (db.dependencies?.postgres === postgres?.specifier
      && db.dependencies?.['drizzle-orm'] === drizzle?.specifier
      && cli.dependencies?.postgres === cliPostgres?.specifier) return;
  const postgresVersion = `3.4.9(patch_hash=${hashes.get('postgres@3.4.9')})`;
  const serverDrizzle = reviewedDependency(lock, 'server', 'drizzle-orm');
  if (!postgres || !drizzle || postgres.version !== postgresVersion || serverDrizzle?.version !== drizzle.version
      || drizzle.version.split('(')[0] !== '0.45.2' || !drizzle.version.includes(`postgres@${postgresVersion}`)) fail();
  for (const [name, pin, entry] of [['postgres', '3.4.9', postgres], ['drizzle-orm', '0.45.2', drizzle]]) {
    if (![pin, `^${pin}`].includes(entry.specifier) || db.dependencies?.[name] !== pin) fail();
    db.dependencies[name] = entry.specifier;
  }
  if (cliPostgres === null) {
    // The reporting tools use cli/node_modules/tsx, never the product CLI.
    // The same canonical patched postgres remains owned by DB and Server.
    if (cli.dependencies?.postgres !== '3.4.9') fail();
    delete cli.dependencies.postgres;
  } else if (cliPostgres.specifier !== '3.4.9' || cliPostgres.version !== postgresVersion || cli.dependencies?.postgres !== '3.4.9') fail();
}
async function installWithReviewedPatches(root, install, ownership) {
  const policy = JSON.parse(await readFile(path.join(root, 'tests/runner-e2e/report-lock.json'), 'utf8'));
  if (![policy.outputSha256, policy.patchSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) fail();
  const lock = await readFile(path.join(root, 'pnpm-lock.yaml'));
  const patch = await readFile(path.join(root, 'tests/runner-e2e/report-lock.patch'));
  if (hash(lock) !== policy.outputSha256 || hash(patch) !== policy.patchSha256) fail();
  const hashes = new Map(), reviewed = patchInventory(lock.toString('utf8'), hashes);
  const packagePath = path.join(root, 'package.json'), workspacePath = path.join(root, 'pnpm-workspace.yaml');
  const packageBytes = await readFile(packagePath, 'utf8'), manifest = JSON.parse(packageBytes);
  const rootEntries = new Map(Object.entries(manifest.pnpm?.patchedDependencies ?? {}));
  const remove = configurationExtras(rootEntries, reviewed);
  const workspace = await readFile(workspacePath, 'utf8'), section = block(workspace, 'patchedDependencies');
  const workspaceEntries = new Map(), lineNames = new Map();
  for (let i = section.start; i < section.end; i++) {
    const line = section.lines[i]; if (!line || line.trimStart().startsWith('#')) continue;
    const match = /^  (.+): ([^\n]+)$/.exec(line); if (!match) fail();
    const name = scalar(match[1]); put(workspaceEntries, name, scalar(match[2])); lineNames.set(i, name);
  }
  if (JSON.stringify(configurationExtras(workspaceEntries, reviewed)) !== JSON.stringify(remove)) fail();
  const dbPath = path.join(root, 'packages/db/package.json'), cliPath = path.join(root, 'cli/package.json');
  const dbBytes = await readFile(dbPath, 'utf8'), cliBytes = await readFile(cliPath, 'utf8');
  const db = JSON.parse(dbBytes), cli = JSON.parse(cliBytes);
  reportingDbPins(lock.toString('utf8'), hashes, db, cli);
  const originals = new Map([[packagePath, packageBytes], [workspacePath, workspace], [dbPath, dbBytes], [cliPath, cliBytes]]);
  const writes = new Map();
  if (remove.length) {
    for (const name of remove) delete manifest.pnpm.patchedDependencies[name];
    writes.set(packagePath, JSON.stringify(manifest, null, 2) + '\n');
    writes.set(workspacePath, section.lines.filter((_, i) => !remove.includes(lineNames.get(i))).join('\n'));
  }
  for (const [file, value] of [[dbPath, db], [cliPath, cli]]) {
    if (JSON.stringify(value) !== JSON.stringify(JSON.parse(originals.get(file)))) writes.set(file, JSON.stringify(value, null, 2) + '\n');
  }
  // All whitelist/canonical-resolution validation precedes every config write.
  for (const [file, bytes] of originals) {
    const name = path.relative(root, file).split(path.sep).join('__') + '.before';
    await writeFile(path.join(ownership, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  let result, primary, failed = false;
  try {
    for (const [file, bytes] of writes) await writeFile(file, bytes);
    result = await install();
  } catch (error) { primary = error; failed = true; }
  // Restore all four Source files, even if an earlier write/restore failed.
  const cleanup = writes.size ? await Promise.allSettled([...originals].map(([file, bytes]) => writeFile(file, bytes))) : [];
  const errors = cleanup.filter(item => item.status === 'rejected').map(item => item.reason);
  if (errors.length) {
    const error = new AggregateError(failed ? [primary, ...errors] : errors, 'Reporting install or exact Source restoration failed');
    error.reportingRestorationFailed = true;
    throw error;
  }
  if (failed) throw primary;
  return result;
}

export async function withReportingDependencies(root, install) {
  // No stale-owner takeover: a crashed install must be inspected/restored first.
  const ownership = path.join(root, '.paperclip-reporting-dependencies');
  await mkdir(ownership, { mode: 0o700 });
  let result, primary, failed = false;
  try { result = await installWithReviewedPatches(root, install, ownership); }
  catch (error) { primary = error; failed = true; }
  // Preserve exact beforeimages and exclusive ownership if restoration failed.
  if (failed && primary?.reportingRestorationFailed) throw primary;
  try { await rm(ownership, { recursive: true }); }
  catch (error) {
    throw new AggregateError(failed ? [primary, error] : [error], 'Reporting install ownership cleanup failed');
  }
  if (failed) throw primary;
  return result;
}

export function reportingPnpmArguments(mode, args, environment = process.env) {
  if (mode === '--reporting-preflight') {
    if (args.length || ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_WEB_IDENTITY_TOKEN_FILE']
      .some(name => environment[name])) throw new Error('Reporting preflight requires a credential-free job and no caller options');
    return ['install', '--lockfile-only', '--frozen-lockfile', '--ignore-scripts', '--offline'];
  }
  const prefix = ['--', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'];
  if (mode !== '--reporting-install' || !prefix.every((value, i) => args[i] === value)
      || !(args.length === prefix.length || (args.length === prefix.length + 2
        && args[5] === '--store-dir' && typeof args[6] === 'string' && args[6]
        && !args[6].startsWith('-') && !args[6].includes('\0'))))
    throw new Error('Reporting install requires the fixed frozen, scripts-disabled command and optional own store');
  return args.slice(2);
}
