import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mode = metadata => metadata.mode & 0o777;
const stable = (left, right) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => left[key] === right[key]);

function readArtifact(file, maximumBytes) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximumBytes) throw new Error('Provider artifact must be a bounded regular file');
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !stable(before, opened)) throw new Error('Provider artifact changed before reading');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('Provider artifact changed while reading');
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, offset) || !stable(opened, fstatSync(descriptor))) throw new Error('Provider artifact changed while reading');
    return { bytes, metadata: opened, path: file, mode: mode(opened), sha256: hash(bytes) };
  } finally { closeSync(descriptor); }
}

// The workflow trusts setup-node's current executable. Snapshot those same
// bytes into an owned location; never change the shared hosted tool cache.
export function stageExecutableSnapshot(source, directory) {
  if (!isAbsolute(directory) || /[\r\n]/u.test(directory)) throw new Error('Provider Node needs an absolute owned directory');
  const original = readArtifact(source, 256 * 1024 * 1024);
  if (!(original.mode & 0o111)) throw new Error('Provider Node source is not executable');
  mkdirSync(directory, { mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
    const destination = join(directory, 'node');
    writeFileSync(destination, original.bytes, { flag: 'wx', mode: 0o500 });
    chmodSync(destination, 0o500);
    const copied = readArtifact(destination, 256 * 1024 * 1024);
    const parent = lstatSync(directory);
    if (copied.sha256 !== original.sha256 || copied.mode !== 0o500 || !parent.isDirectory() || mode(parent) !== 0o700
        || copied.metadata.uid !== process.geteuid() || parent.uid !== process.geteuid()) throw new Error('Provider Node snapshot is not private and byte-identical');
    return { source: { path: source, mode: original.mode, sha256: original.sha256 },
      staged: { path: destination, mode: copied.mode, sha256: copied.sha256 }, directoryMode: mode(parent) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

export function stageProviderNode({ directory, sidecar }) {
  if (process.platform !== 'linux') throw new Error('Protocol provider Node staging requires Linux');
  const sidecarArtifact = readArtifact(sidecar, 16 * 1024 * 1024);
  if (sidecarArtifact.mode & 0o022) throw new Error('Provider sidecar must not be group- or world-writable');
  const snapshot = stageExecutableSnapshot(process.execPath, directory);
  try {
    const probe = JSON.parse(execFileSync(snapshot.staged.path, ['--input-type=module', '-e',
      'import {readFileSync,lstatSync} from "node:fs";import {createHash} from "node:crypto";process.stdout.write(JSON.stringify({execPath:process.execPath,version:process.version,mode:lstatSync(process.execPath).mode&511,sha256:createHash("sha256").update(readFileSync(process.execPath)).digest("hex")}));'],
    { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] }));
    if (probe.execPath !== snapshot.staged.path || probe.version !== process.version || probe.mode !== 0o500 || probe.sha256 !== snapshot.source.sha256) throw new Error('Provider Node did not execute the admitted bytes');
    return { schema: 'paperclip.runner-provider-node/v1', platform: process.platform, arch: process.arch, version: probe.version,
      ...snapshot, sidecar: { path: sidecar, mode: sidecarArtifact.mode, sha256: sidecarArtifact.sha256 } };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5 || !process.env.GITHUB_PATH) throw new Error('Provider Node staging needs directory, sidecar, receipt and GitHub path context');
    const receipt = stageProviderNode({ directory: process.argv[2], sidecar: process.argv[3] });
    writeFileSync(process.argv[4], `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    appendFileSync(process.env.GITHUB_PATH, `${process.argv[2]}\n`);
    console.log(JSON.stringify(receipt));
  } catch { console.error('Provider Node staging failed before credentials or provider execution.'); process.exitCode = 1; }
}
