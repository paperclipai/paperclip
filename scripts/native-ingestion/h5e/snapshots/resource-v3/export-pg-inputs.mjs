// Read-only installed-artifact/host metadata export; no PG, unit or app starts.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hash, json, shaFile } from './resource-contract.mjs';
import { controls } from './pg-service.mjs';
async function main() {
  if (!process.argv.includes('--export')) { console.log(JSON.stringify({ sourceOnly: true, starts: 0,
    action: 'Linux quiet-window readonly metadata export only; expected child-scope controls remain unset until actual accounting qualification' })); return; }
  const option = key => process.argv.find(value => value.startsWith('--' + key + '='))?.slice(key.length + 3);
  const appRoot = await realpath(option('app-root')), output = option('output');
  assert.equal(process.platform, 'linux'); assert.equal(userInfo().username, 'ubuntu');
  const require = createRequire(path.join(appRoot, 'server/package.json'));
  const embedded = path.dirname(path.dirname(require.resolve('embedded-postgres')));
  const source = await json(new URL('./embedded-source-pins.json', import.meta.url));
  for (const [name, expected] of Object.entries(source.files)) assert.equal(await shaFile(path.join(embedded, name)), expected);
  const nativeEntry = await realpath(createRequire(path.join(embedded, 'package.json')).resolve('@embedded-postgres/linux-x64'));
  const { default: binaries } = await import(pathToFileURL(path.join(embedded, 'dist/binary.js')).href);
  const bin = await binaries(), postgresBinary = await realpath(bin.postgres), initdbBinary = await realpath(bin.initdb);
  const detectPortEntry = await realpath(require.resolve('detect-port'));
  const parentControls = await controls('/sys/fs/cgroup/system.slice');
  const systemdCliVersion = (await promisify(execFile)('/usr/bin/systemctl', ['--version'], { timeout: 5000 })).stdout.trim();
  const result = { sourceOnlyMetadata: true, servingQualified: false, appRoot,
    pg: { user: 'ubuntu', group: 'ubuntu', uid: process.getuid(), gid: process.getgid(), postgresBinary,
      postgresSha256: await shaFile(postgresBinary), initdbBinary, initdbSha256: await shaFile(initdbBinary),
      nativeEntry, nativeEntrySha256: await shaFile(nativeEntry), detectPortEntry, detectPortSha256: await shaFile(detectPortEntry),
      parentControlsSha256: hash(JSON.stringify(parentControls)), expectedEffectiveControls: null,
      supervision: 'root-owned-systemd-exec-prestart-supported-reuse' },
    parentControls, systemdCliVersion, nodeExecutable: await realpath(process.execPath),
    nodeExecutableSha256: await shaFile(process.execPath), bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    stillRequired: ['Actual empty fresh unit/root-permission/exited-child accounting qualification and exact leaf control values',
      'Root and independent source review plus concrete serving SMALL release', 'Matched completed FULL diagnostics; no event outcomes were created'] };
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ metadataOnly: true, output, sha256: await shaFile(output), serviceStarts: 0 }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
