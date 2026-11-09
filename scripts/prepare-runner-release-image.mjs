import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { verifyReleaseProviderPack } from '../packages/paperclip-runner/scripts/release-provider-pack.mjs';

export function validateReleaseRun(run, source) {
  if (!/^[a-f0-9]{40}$/.test(source) || !/^[a-f0-9]{40}$/.test(run.head_sha ?? '') || run.conclusion !== 'success'
    || run.path !== '.github/workflows/release-smoke.yml' || run.repository?.full_name !== 'paperclipai/paperclip') {
    throw Error('Image inputs require a successful repository-owned Release Smoke run in paperclipai/paperclip');
  }
}

export function selectReleaseArtifacts(artifacts, runId, attempt) {
  const names = [
    `runner-provider-packs-${runId}-${attempt}-linux-x64`,
    `runner-release-${runId}-${attempt}-linux-x64`,
  ];
  const selected = names.map(name => artifacts.filter(a => a.name === name));
  selected.push(artifacts.filter(a => /^[a-zA-Z0-9._-]+-public-packages$/.test(a.name)));
  if (selected.some(matches => matches.length !== 1)) throw Error('Expected one pack, daemon and public-package artifact');
  return selected.map(([a]) => {
    if (a.expired || !Number.isSafeInteger(a.id) || a.id <= 0 || !/^sha256:[a-f0-9]{64}$/.test(a.digest)
      || !Number.isSafeInteger(a.size_in_bytes) || a.size_in_bytes < 1 || a.size_in_bytes > 2 * 1024 ** 3) {
      throw Error('Invalid or expired release artifact');
    }
    return a;
  });
}

export function validateReleaseImageBase(base) {
  if (!/^ghcr\.io\/paperclipai\/paperclip-daytona-runner@sha256:[a-f0-9]{64}$/.test(base)) {
    throw Error('Release image base must be an immutable Paperclip Daytona image');
  }
  return base;
}

export function validateImageBindings({ source, pack, publicPack, receipt, release, daemonBytes }) {
  if (!isDeepStrictEqual(publicPack, pack)) throw Error('Image pack differs from public package authority');
  const sha256 = createHash('sha256').update(daemonBytes).digest('hex');
  if (receipt.schema !== 'paperclip.runner.release-artifact.v1' || receipt.sourceRevision !== source || receipt.target !== 'linux-x64'
    || receipt.sha256 !== `sha256:${sha256}` || release.sourceRevision !== source || release.platforms?.['linux-x64']?.sha256 !== `sha256:${sha256}`
    || daemonBytes.length < 64 || daemonBytes.subarray(0, 4).toString('hex') !== '7f454c46'
    || daemonBytes[4] !== 2 || daemonBytes[5] !== 1 || daemonBytes.readUInt16LE(18) !== 62) {
    throw Error('Daemon source, digest or architecture mismatch');
  }
  return sha256;
}

export function decodeReleaseJson(file, path) {
  if (file?.type !== 'file' || file.path !== path || file.encoding !== 'base64'
    || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 1024 * 1024
    || typeof file.content !== 'string') throw Error('Invalid frozen release JSON');
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.length !== file.size) throw Error('Frozen release JSON size mismatch');
  return JSON.parse(bytes.toString('utf8'));
}

const digestFile = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

async function main() {
  const source = process.env.SOURCE_SHA, runId = process.env.RELEASE_RUN_ID, token = process.env.GH_TOKEN;
  const output = resolve(process.argv[2] ?? 'remote-verification/release-context');
  validateReleaseImageBase(process.env.RELEASE_BASE_IMAGE);
  if (!/^[1-9][0-9]*$/.test(runId ?? '') || !token) throw Error('Release run ID and GitHub token required');
  const api = async endpoint => {
    const response = await fetch(`https://api.github.com/repos/paperclipai/paperclip/${endpoint}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }, redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw Error(`GitHub release metadata request failed: ${response.status}`);
    return response.json();
  };
  const run = await api(`actions/runs/${runId}`);
  validateReleaseRun(run, source);
  const artifacts = [];
  for (let page = 1; ; page++) {
    const result = await api(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
    artifacts.push(...result.artifacts);
    if (result.artifacts.length < 100) break;
    if (page === 10) throw Error('Unexpected artifact count');
  }
  const selected = selectReleaseArtifacts(artifacts, runId, run.run_attempt);
  await mkdir(output, { recursive: false });
  const dirs = [];
  for (const [index, artifact] of selected.entries()) {
    const response = await fetch(`https://api.github.com/repos/paperclipai/paperclip/actions/artifacts/${artifact.id}/zip`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }, redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const url = response.headers.get('location');
    if (response.status !== 302 || !url || new URL(url).protocol !== 'https:'
      || !new URL(url).hostname.endsWith('.blob.core.windows.net')) throw Error('Unexpected artifact download redirect');
    const download = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(300_000) });
    if (!download.ok || !download.body) throw Error('Release artifact download failed');
    const archive = join(output, `artifact-${index}.zip`), hash = createHash('sha256');
    let size = 0;
    await pipeline(download.body, new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > artifact.size_in_bytes) return callback(Error('Artifact exceeds its declared size'));
      hash.update(chunk); callback(null, chunk);
    } }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    if (size !== artifact.size_in_bytes || `sha256:${hash.digest('hex')}` !== artifact.digest) throw Error('Artifact digest or size mismatch');
    const dir = join(output, `artifact-${index}`);
    execFileSync('python3', ['-c', `import zipfile,sys,pathlib,stat
z=zipfile.ZipFile(sys.argv[1]); dest=pathlib.Path(sys.argv[2]); kind=int(sys.argv[3]); entries=z.infolist()
expected=[{'linux-x64/provider-pack.json','linux-x64/provider-pack.tar.gz'},{'linux-x64/paperclip-runnerd','linux-x64/receipt.json'}]
names=[e.filename for e in entries]
if len(names)!=len(set(names)): raise RuntimeError('Duplicate archive paths')
if kind<2:
 if set(names)!=expected[kind]: raise RuntimeError('Unexpected release artifact entries')
else:
 import re
 if 'manifest.json' not in names or any(not re.fullmatch(r'(manifest.json|paperclipai-[a-z0-9.-]+\\.tgz)',n) for n in names): raise RuntimeError('Unexpected public package entries')
if sum(e.file_size for e in entries)>4*1024**3 or any(stat.S_ISLNK(e.external_attr>>16) for e in entries): raise RuntimeError('Unsafe artifact extraction')
z.extractall(dest)
`, archive, dir, String(index)], { stdio: 'pipe' });
    await rm(archive);
    dirs.push(dir);
  }
  const pack = JSON.parse(await readFile(join(dirs[0], 'linux-x64/provider-pack.json'), 'utf8'));
  // The workflow source can be newer than the immutable release being consumed.
  // Read data from that release commit, never execute source from the artifact.
  const [profiles, distributions] = await Promise.all(['acpx-profiles.json', 'cursor-distributions.json'].map(async name => {
    const path = `packages/paperclip-runner/${name}`;
    return decodeReleaseJson(await api(`contents/${path}?ref=${source}`), path);
  }));
  verifyReleaseProviderPack(pack, source, 'linux-x64', { profiles, distributions });
  const packages = JSON.parse(await readFile(join(dirs[2], 'manifest.json'), 'utf8'));
  if (packages.schema !== 'paperclip.runner.public-packages/v1' || packages.sourceRevision !== source) throw Error('Wrong public-package source');
  const server = packages.archives?.filter(a => a.name === '@paperclipai/server');
  if (server?.length !== 1 || !/^paperclipai-server-[a-z0-9.-]+\.tgz$/.test(server[0].file)
    || !/^[a-f0-9]{64}$/.test(server[0].sha256)) throw Error('Invalid server archive');
  const serverArchive = join(dirs[2], server[0].file);
  if (await digestFile(serverArchive) !== server[0].sha256) throw Error('Server archive digest mismatch');
  const fromServer = name => JSON.parse(execFileSync('tar', ['-xOf', serverArchive, `package/dist/vendor/paperclip-runner/${name}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  const publicPack = fromServer('remote-provider-packs/linux-x64/provider-pack.json');
  const packArchive = join(dirs[0], 'linux-x64/provider-pack.tar.gz');
  if (!isDeepStrictEqual(JSON.parse(execFileSync('tar', ['-xOf', packArchive, './provider-pack.json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 })), pack)) throw Error('Pack archive manifest mismatch');
  const receipt = JSON.parse(await readFile(join(dirs[1], 'linux-x64/receipt.json'), 'utf8'));
  const daemon = join(dirs[1], 'linux-x64/paperclip-runnerd'), bytes = await readFile(daemon);
  const release = fromServer('bin/release-manifest.json');
  const sha256 = validateImageBindings({ source, pack, publicPack, receipt, release, daemonBytes: bytes });
  await chmod(daemon, 0o700);
  if (!isDeepStrictEqual(JSON.parse(execFileSync(daemon, ['--build-metadata'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 65536 })), receipt.buildMetadata)) throw Error('Daemon metadata mismatch');
  await copyFile(packArchive, join(output, 'provider-pack.tar.gz'));
  await copyFile(daemon, join(output, 'paperclip-runnerd'));
  await copyFile(new URL('../docker/daytona-runner/Dockerfile.release', import.meta.url), join(output, 'Dockerfile'));
  await copyFile(join(dirs[0], 'linux-x64/provider-pack.json'), join(output, 'provider-pack.json'));
  for (const dir of dirs) await rm(dir, { recursive: true });
  const evidence = { sourceRevision: source, producerRunId: runId, producerWorkflowSource: run.head_sha, producerAttempt: run.run_attempt, providerPackDigest: pack.digest,
    daemonSha256: sha256, baseImage: process.env.RELEASE_BASE_IMAGE, artifacts: selected.map(a => ({ id: a.id, name: a.name, digest: a.digest })), providerCalls: 0 };
  await writeFile(resolve(output, '../release-image-inputs.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
