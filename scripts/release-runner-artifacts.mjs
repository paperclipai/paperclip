// Data transfer for the existing release assembler. Producer jobs have no
// publishing credentials; consumers never execute binaries from the archive.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { runnerBinaryTarget } from '../packages/paperclip-runner/src/live/runner-binary.ts';
import { verifyReleaseProviderPack } from '../packages/paperclip-runner/scripts/release-provider-pack.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_RUNNER_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64'];
const dataPaths = [...RELEASE_RUNNER_TARGETS.map(target => `bin/${target}/paperclip-runnerd`),
  'bin/release-manifest.json', 'remote-provider-packs/linux-x64/provider-pack.json'];
const archivePaths = [...dataPaths, 'assembly-receipt.json'];
const maxBinary = 128 * 1024 * 1024;
const maxArchive = 3 * maxBinary + 2 * 1024 * 1024;
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const revision = value => assert.match(value ?? '', /^[a-f0-9]{40}$/, 'Runner artifacts require a full source SHA');
function file(path, limit = maxBinary) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, `Unsafe or oversized artifact ${path}`);
  return readFileSync(path);
}
function inside(root, path, limit = maxBinary) {
  const components = path.split('/');
  for (let length = 0; length < components.length; length++) {
    const directory = length === 0 ? root : join(root, ...components.slice(0, length));
    const stat = lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Artifact directories must not be symlinks');
  }
  return file(join(root, path), limit);
}
function destination(root, path) {
  assert.ok(archivePaths.includes(path), 'Unknown artifact destination');
  const components = path.split('/');
  for (let length = 0; length < components.length; length++) {
    const directory = length === 0 ? root : join(root, ...components.slice(0, length));
    if (!existsSync(directory)) mkdirSync(directory);
    const stat = lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Artifact output directories must not be symlinks');
  }
  const output = join(root, path);
  let existing;
  try { existing = lstatSync(output); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.ok(!existing || existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1,
    'Refuse to overwrite an artifact link or non-file');
  return output;
}
function newDirectory(path) {
  assert.ok(isAbsolute(path) && resolve(path) === path && path !== '/' && !existsSync(path), 'Artifact output must be a new absolute owned directory');
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
function writeJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); }
function imageProvenance(path, sourceRevision, requestedImage = '') {
  const [image] = JSON.parse(file(path, 512 * 1024));
  assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, 'amd64');
  assert.equal(image.Config?.Labels?.['org.opencontainers.image.revision'], sourceRevision);
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  if (requestedImage) {
    assert.match(requestedImage, /^ghcr\.io\/paperclipai\/paperclip@sha256:[a-f0-9]{64}$/);
    assert.ok(image.RepoDigests?.includes(requestedImage));
  }
  return { sourceRevision, platform: 'linux/amd64', imageId: image.Id, requestedImage, repoDigests: image.RepoDigests ?? [] };
}

function sourcePins(sourceRoot = repo) {
  return { profiles: file(join(sourceRoot, 'packages/paperclip-runner/acpx-profiles.json'), 512 * 1024),
    distributions: file(join(sourceRoot, 'packages/paperclip-runner/cursor-distributions.json'), 512 * 1024) };
}
// The unbuilt producer cannot import the compiled eval join. Check its same
// daemon contracts here, including the durable/remote capabilities needed by
// production. Metadata is a compatibility claim, not embedded source proof.
export function verifyReleaseDaemonMetadata(metadata) {
  assert.equal(metadata?.schema, 'paperclip-runner/runnerd-build-metadata/v1');
  assert.equal(metadata.binaryName, 'paperclip-runnerd', 'Unexpected release daemon name');
  assert.equal(metadata.packageName, '@paperclipai/paperclip-runner', 'Unexpected release daemon package');
  assert.ok(typeof metadata.packageVersion === 'string' && metadata.packageVersion.trim(), 'Missing daemon package version');
  for (const [field, expected] of [['binaryContractVersion', 2], ['nativeExecutionVersion', 1], ['harnessDriverVersion', 1]]) {
    assert.equal(metadata[field], expected, `Incompatible daemon ${field}`);
  }
  assert.equal(metadata.prp?.name, 'paperclip.runner', 'Incompatible daemon protocol family');
  assert.ok(Number.isSafeInteger(metadata.prp.minimumVersion) && metadata.prp.minimumVersion === 1 &&
    Number.isSafeInteger(metadata.prp.maximumVersion) && metadata.prp.maximumVersion >= 2, 'Incompatible daemon protocol versions');
  for (const [field, required] of [
    ['durableSessionCapabilities', ['unlimited_runtime', 'connection_lease_renewal']],
    ['prpTransportModes', ['dial_ws_loopback', 'dial_wss', 'listen_ws']],
  ]) {
    assert.ok(Array.isArray(metadata[field]) && required.every(capability => metadata[field].includes(capability)),
      `Missing release daemon ${field}`);
  }
  return metadata;
}
export function verifyRunnerReleaseData(files, sourceRevision, pins = sourcePins()) {
  revision(sourceRevision);
  assert.deepEqual([...files.keys()].sort(), [...archivePaths].sort(), 'Release archive must contain exactly the known data files');
  const receipt = JSON.parse(files.get('assembly-receipt.json'));
  assert.equal(receipt.schema, 'paperclip.runner.release-assembly.v1');
  assert.equal(receipt.sourceRevision, sourceRevision, 'Assembly source mismatch');
  assert.deepEqual(Object.keys(receipt.files ?? {}).sort(), [...dataPaths].sort());
  for (const path of dataPaths) assert.equal(digest(files.get(path)), receipt.files[path], `Assembly artifact digest mismatch: ${path}`);
  const manifest = JSON.parse(files.get('bin/release-manifest.json'));
  assert.equal(manifest.schema, 'paperclip.runner.release-binaries.v1');
  assert.equal(manifest.sourceRevision, sourceRevision, 'Daemon source mismatch');
  assert.deepEqual(Object.keys(manifest.platforms ?? {}).sort(), [...RELEASE_RUNNER_TARGETS].sort(), 'Missing or duplicate release target');
  assert.deepEqual(Object.keys(receipt.daemonMetadata ?? {}).sort(), [...RELEASE_RUNNER_TARGETS].sort(), 'Missing daemon compatibility receipt');
  for (const target of RELEASE_RUNNER_TARGETS) {
    const path = `bin/${target}/paperclip-runnerd`, artifact = manifest.platforms[target];
    assert.equal(artifact.path, `${target}/paperclip-runnerd`, 'Unsafe daemon path');
    assert.equal(runnerBinaryTarget(files.get(path)), target, 'Daemon architecture mismatch');
    assert.equal(digest(files.get(path)), artifact.sha256, 'Daemon digest mismatch');
    verifyReleaseDaemonMetadata(receipt.daemonMetadata[target]);
  }
  assert.equal(receipt.sourcePins?.profiles, digest(pins.profiles), 'Checked-out source profile snapshot mismatch');
  assert.equal(receipt.sourcePins?.distributions, digest(pins.distributions), 'Checked-out source distribution snapshot mismatch');
  const pack = verifyReleaseProviderPack(JSON.parse(files.get('remote-provider-packs/linux-x64/provider-pack.json')), sourceRevision,
    JSON.parse(pins.profiles), JSON.parse(pins.distributions));
  assert.equal(manifest.remoteProviderPack?.target, 'linux-x64');
  assert.equal(manifest.remoteProviderPack?.digest, pack.digest, 'Provider pack assembly identity mismatch');
  assert.equal(manifest.remoteProviderPack?.sourceRevision, sourceRevision);
  assert.equal(receipt.providerImage?.sourceRevision, sourceRevision, 'Provider image source mismatch');
  assert.equal(receipt.providerImage?.platform, 'linux/amd64');
  assert.match(receipt.providerImage?.imageId ?? '', /^sha256:[a-f0-9]{64}$/);
  if (receipt.providerImage.requestedImage) {
    assert.match(receipt.providerImage.requestedImage, /^ghcr\.io\/paperclipai\/paperclip@sha256:[a-f0-9]{64}$/);
    assert.ok(receipt.providerImage.repoDigests?.includes(receipt.providerImage.requestedImage), 'Provider image digest mismatch');
  }
  assert.deepEqual(receipt.linuxDaemonImage, receipt.providerImage, 'Linux daemon and provider pack must come from the same verified image');
  return receipt;
}

// A deliberately small ustar data envelope: no directories, links, extensions,
// executable hooks or arbitrary paths. Validate the entire envelope before any
// destination file exists, including compressed/uncompressed bounds and hashes.
export function readRunnerReleaseArchive(bytes, sourceRevision, checksum, pins) {
  assert.ok(bytes.length <= maxArchive, 'Release archive is oversized');
  assert.equal(digest(bytes), checksum, 'Release archive checksum mismatch');
  const tar = gunzipSync(bytes, { maxOutputLength: maxArchive });
  const files = new Map();
  const octal = bytes => {
    const value = bytes.toString('ascii').replace(/\0.*$/s, '').trim();
    assert.match(value, /^[0-7]+$/, 'Invalid archive numeric field');
    return parseInt(value, 8);
  };
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      assert.ok(tar.subarray(offset).every(byte => byte === 0), 'Unexpected archive trailer');
      break;
    }
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    assert.ok(archivePaths.includes(name) && !files.has(name), 'Unsafe, unexpected or duplicate archive path');
    assert.ok(header.subarray(345, 500).every(byte => byte === 0), 'Archive prefixes are unsupported');
    assert.ok(header[156] === 0 || header[156] === 48, 'Archive links and extensions are forbidden');
    assert.ok(header.subarray(157, 257).every(byte => byte === 0), 'Archive link target is forbidden');
    const sum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(octal(header.subarray(148, 156)), sum, 'Archive header checksum mismatch');
    const size = octal(header.subarray(124, 136));
    assert.ok(size <= (name.endsWith('paperclip-runnerd') ? maxBinary : 512 * 1024) && offset + 512 + size <= tar.length, 'Oversized or truncated archive member');
    const mode = octal(header.subarray(100, 108));
    assert.equal(mode, name.endsWith('paperclip-runnerd') ? 0o755 : 0o644, 'Unexpected archive file permissions');
    files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(offset + 1024 <= tar.length, 'Archive must have a complete end marker');
  verifyRunnerReleaseData(files, sourceRevision, pins);
  return files;
}

export function makeRunnerReleaseArchive(files, sourceRevision) {
  verifyRunnerReleaseData(files, sourceRevision);
  const chunks = [];
  for (const path of archivePaths) {
    const bytes = files.get(path), header = Buffer.alloc(512);
    header.write(path);
    const field = (offset, width, value) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
    field(100, 8, path.endsWith('paperclip-runnerd') ? 0o755 : 0o644);
    field(108, 8, 0); field(116, 8, 0); field(124, 12, bytes.length); field(136, 12, 0);
    header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const sum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

async function main() {
  const [mode, sourceRevision, ...args] = process.argv.slice(2);
  revision(sourceRevision);
  if (mode === 'record-binary') {
    const [target, binary, output, ...extra] = args;
    assert.ok(RELEASE_RUNNER_TARGETS.includes(target) && !extra.length);
    const bytes = file(binary); assert.equal(runnerBinaryTarget(bytes), target);
    assert.equal(`${process.platform}-${process.arch}`, target, 'Execute metadata only on the daemon native target');
    const metadata = JSON.parse(execFileSync(binary, ['--build-metadata'], { timeout: 15_000, maxBuffer: 128 * 1024 }));
    verifyReleaseDaemonMetadata(metadata);
    newDirectory(output); writeFileSync(join(output, 'paperclip-runnerd'), bytes, { mode: 0o755 });
    writeJson(join(output, 'receipt.json'), { sourceRevision, target, sha256: digest(bytes), metadata });
  } else if (mode === 'record-image-binary') {
    const [binary, metadataPath, imageMetadata, output, requestedImage = '', ...extra] = args;
    assert.equal(extra.length, 0);
    const bytes = file(binary); assert.equal(runnerBinaryTarget(bytes), 'linux-x64');
    // Metadata was executed in this same image, whose libc matches the daemon.
    // The host validates data only and must never execute the extracted ELF.
    const metadata = verifyReleaseDaemonMetadata(JSON.parse(file(metadataPath, 128 * 1024)));
    const providerImage = imageProvenance(imageMetadata, sourceRevision, requestedImage);
    newDirectory(output); writeFileSync(join(output, 'paperclip-runnerd'), bytes, { mode: 0o755 });
    writeJson(join(output, 'receipt.json'), { sourceRevision, target: 'linux-x64', sha256: digest(bytes), metadata, providerImage });
  } else if (mode === 'record-pack') {
    const [packPath, imageMetadata, output, requestedImage = '', ...extra] = args; assert.equal(extra.length, 0);
    const bytes = file(packPath, 512 * 1024); verifyReleaseProviderPack(JSON.parse(bytes), sourceRevision);
    const providerImage = imageProvenance(imageMetadata, sourceRevision, requestedImage);
    newDirectory(output); writeFileSync(join(output, 'provider-pack.json'), bytes);
    writeJson(join(output, 'receipt.json'), { sourceRevision, sha256: digest(bytes), providerImage });
  } else if (mode === 'assemble') {
    const [artifacts, output, ...extra] = args; assert.equal(extra.length, 0);
    const platforms = {}, daemonMetadata = {};
    let linuxDaemonImage;
    assert.deepEqual((await import('node:fs')).readdirSync(artifacts).sort(), [...RELEASE_RUNNER_TARGETS, 'provider-pack'].sort());
    for (const target of RELEASE_RUNNER_TARGETS) {
      const path = join(artifacts, target, 'paperclip-runnerd'), bytes = inside(artifacts, `${target}/paperclip-runnerd`);
      const receipt = JSON.parse(inside(artifacts, `${target}/receipt.json`, 128 * 1024));
      assert.equal(receipt.sourceRevision, sourceRevision); assert.equal(receipt.target, target);
      daemonMetadata[target] = verifyReleaseDaemonMetadata(receipt.metadata);
      if (target === 'linux-x64') linuxDaemonImage = receipt.providerImage;
      assert.equal(receipt.sha256, digest(bytes)); assert.equal(runnerBinaryTarget(bytes), target);
      platforms[target] = { path: resolve(path), sha256: receipt.sha256 };
    }
    const packPath = join(artifacts, 'provider-pack/provider-pack.json'), bytes = inside(artifacts, 'provider-pack/provider-pack.json', 512 * 1024);
    const packReceipt = JSON.parse(inside(artifacts, 'provider-pack/receipt.json', 128 * 1024));
    assert.equal(packReceipt.sourceRevision, sourceRevision); assert.equal(packReceipt.sha256, digest(bytes));
    assert.deepEqual(linuxDaemonImage, packReceipt.providerImage, 'Linux daemon and provider pack must come from the same verified image');
    verifyReleaseProviderPack(JSON.parse(bytes), sourceRevision);
    newDirectory(output);
    const manifestPath = join(output, 'assembler-input.json');
    writeJson(manifestPath, { sourceRevision, platforms, remoteProviderPack: { path: resolve(packPath), sha256: packReceipt.sha256 } });
    // The existing assembler owns source/profile-aware staging. Never replace
    // it with a second daemon assembly implementation in this transfer helper.
    execFileSync(process.execPath, [join(repo, 'packages/paperclip-runner/scripts/stage-release-runner-binaries.mjs'), manifestPath], { stdio: 'inherit' });
    const files = new Map(dataPaths.map(path => [path, file(join(repo, 'packages/paperclip-runner/dist', path), path.endsWith('paperclip-runnerd') ? maxBinary : 512 * 1024)]));
    const pins = sourcePins();
    const receipt = { schema: 'paperclip.runner.release-assembly.v1', sourceRevision,
      sourcePins: { profiles: digest(pins.profiles), distributions: digest(pins.distributions) }, daemonMetadata,
      providerImage: packReceipt.providerImage, linuxDaemonImage, files: Object.fromEntries([...files].map(([path, bytes]) => [path, digest(bytes)])) };
    files.set('assembly-receipt.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
    const archive = makeRunnerReleaseArchive(files, sourceRevision);
    writeFileSync(join(output, 'runner-release-assets.tar.gz'), archive);
    writeFileSync(join(output, 'runner-release-assets.tar.gz.sha256'), digest(archive) + '\n');
  } else if (mode === 'unpack') {
    const [archive, checksum, output, sourceRoot = repo, ...extra] = args; assert.equal(extra.length, 0);
    const files = readRunnerReleaseArchive(file(archive, maxArchive), sourceRevision, file(checksum, 256).toString().trim(), sourcePins(sourceRoot));
    newDirectory(output);
    for (const [path, bytes] of files) {
      writeFileSync(destination(output, path), bytes, { mode: path.endsWith('paperclip-runnerd') ? 0o755 : 0o644 });
    }
    console.log(JSON.stringify({ sourceRevision, targets: RELEASE_RUNNER_TARGETS, archiveSha256: digest(file(archive, maxArchive)), providerCalls: 0 }));
  } else if (mode === 'copy') {
    const [assets, output, ...extra] = args; assert.equal(extra.length, 0);
    const files = new Map(archivePaths.map(path => [path, inside(assets, path, path.endsWith('paperclip-runnerd') ? maxBinary : 512 * 1024)]));
    verifyRunnerReleaseData(files, sourceRevision);
    assert.ok(isAbsolute(output) && resolve(output) === output && output !== '/');
    for (const [path, bytes] of files) {
      if (path === 'assembly-receipt.json') continue;
      const target = destination(output, path);
      writeFileSync(target, bytes); chmodSync(target, path.endsWith('paperclip-runnerd') ? 0o755 : 0o644);
    }
  } else throw new Error('Unknown release artifact operation');
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
