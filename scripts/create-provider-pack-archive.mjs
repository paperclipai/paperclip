import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { constants, createZstdCompress } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createProviderPackArchive(root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'provider-pack.json'), 'utf8'));
  if (manifest.schema !== 'paperclip-runner/remote-provider-pack/v1'
    || !/^sha256:[a-f0-9]{64}$/.test(manifest.digest ?? '')) throw Error('Invalid provider pack identity');
  const archive = `${root}.tar.zst`;
  const tar = spawn('tar', ['--no-xattrs', '-cf', '-', '-C', root, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const completed = new Promise((resolve, reject) => {
    tar.on('error', reject);
    tar.on('close', code => code === 0 ? resolve() : reject(Error('Provider pack archive creation failed')));
  });
  try {
    await Promise.all([completed, pipeline(tar.stdout,
      createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 3 } }), createWriteStream(archive))]);
  } catch (error) {
    tar.kill();
    throw error;
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const receipt = {
    schema: 'paperclip-runner/provider-pack-archive/v1',
    encoding: 'tar+zstd',
    providerPackDigest: manifest.digest,
    sha256: hash.digest('hex'),
    bytes: (await stat(archive)).size,
  };
  await writeFile(`${root}.archive.json`, JSON.stringify(receipt) + '\n');
  return receipt;
}

// Keep large immutable files separate so a fresh sandbox can reuse identical
// image bytes without trusting that image's older provider-pack identity.
export async function createProviderPackLayers(root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'provider-pack.json'), 'utf8'));
  if (manifest.schema !== 'paperclip-runner/remote-provider-pack/v1'
    || !/^sha256:[a-f0-9]{64}$/.test(manifest.digest ?? '')) throw Error('Invalid provider pack identity');
  const directory = `${root}.archives`;
  await mkdir(directory, { recursive: true });
  const small = [], files = [];
  const visit = async (relative = '') => {
    for (const name of (await readdir(resolve(root, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const metadata = await lstat(resolve(root, path));
      if (metadata.isDirectory()) { small.push(path); await visit(path); }
      else if (metadata.isFile() && metadata.size >= 1024 * 1024) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(resolve(root, path))) hash.update(chunk);
        files.push({ path, bytes: metadata.size, mode: metadata.mode & 0o777, sha256: hash.digest('hex') });
      } else if (metadata.isFile() || metadata.isSymbolicLink()) small.push(path);
      else throw Error('Unsupported provider pack entry');
    }
  };
  await visit();
  // Archive N holds file N, so a file's archive name is its place in this
  // list. The pack's `dist` is the Runner's own build output; every other
  // large file is a dependency. The dependencies come first, so that their
  // archive names do not change when the Runner's build gains or loses a
  // large file. `dist` sorts before `node_modules`: in path order alone, one
  // more large file under it renamed every dependency archive.
  const own = file => file.path.startsWith('dist/');
  files.splice(0, files.length, ...files.filter(file => !own(file)), ...files.filter(own));
  const archive = async (name, paths) => {
    const target = resolve(directory, name);
    // Explicit NUL-separated names and no recursion avoid options, duplicate
    // traversal, and hardlinks from an archive to files in a different layer.
    const tar = spawn('tar', ['--no-xattrs', '--no-recursion', '-cf', '-', '-C', root,
      '--null', '-T', '-'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
    const completed = new Promise((resolve, reject) => {
      tar.on('error', reject);
      tar.on('close', code => code === 0 ? resolve() : reject(Error('Provider pack layer creation failed')));
    });
    tar.stdin.on('error', () => {}); // The child/pipeline supplies the causal failure.
    tar.stdin.end(paths.map(path => `./${path}\0`).join(''));
    // The compressor is ended only after it has taken every chunk. When end()
    // arrives while the last chunk is still queued, Node finishes the zstd
    // stream twice and the archive gets an empty frame at its end. Piping
    // leaves that to timing, so the same files gave two different archives.
    const compress = createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 3 } });
    const feed = async () => {
      for await (const chunk of tar.stdout) {
        await new Promise((resolve, reject) => compress.write(chunk, error => error ? reject(error) : resolve()));
      }
      compress.end();
    };
    try {
      await Promise.all([completed, feed(), pipeline(compress, createWriteStream(target))]);
    } catch (error) { tar.kill(); compress.destroy(); throw error; }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    return { sha256: hash.digest('hex'), bytes: (await stat(target)).size };
  };
  const overlay = await archive('overlay.tar.zst', small);
  for (const [index, file] of files.entries()) file.archive = await archive(`${index}.tar.zst`, [file.path]);
  const receipt = { schema: 'paperclip-runner/provider-pack-archive/v2', encoding: 'tar+zstd',
    providerPackDigest: manifest.digest, overlay, files };
  await writeFile(`${root}.archive.json`, JSON.stringify(receipt) + '\n');
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || process.argv[3]) throw Error('Usage: create-provider-pack-archive.mjs PACK_ROOT');
  await createProviderPackLayers(resolve(process.argv[2]));
}
