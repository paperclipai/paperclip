import { isEntrypoint } from './entrypoint.mjs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeRuntimeReceipt, RUNTIME_MAX_BYTES, RUNTIME_MAX_FILES } from './verify-runtime.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const repository = resolve(source, '../../../..');
const require = createRequire(join(repository, 'server/package.json'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const scripts = ['hosted.mjs', 'entrypoint.mjs', 'evidence-files.mjs', 'archive.mjs', 'manifest.mjs', 'observability.mjs', 'report.mjs', 'run.mjs', 'verify-runtime.mjs'];

export async function buildControllerRuntime({ outputDirectory, sourceRevision }) {
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error('Controller runtime requires an exact source revision');
  const output = resolve(outputDirectory);
  await mkdir(output, { mode: 0o700 });
  const controller = join(output, 'controlled-evals');
  await mkdir(controller, { mode: 0o700 });
  for (const file of scripts) await cp(join(source, file), join(controller, file), { errorOnExist: true, force: false });
  const runtime = join(output, 'tests/runner-e2e/shared-runtime.mjs');
  await mkdir(dirname(runtime), { recursive: true, mode: 0o700 });
  const { build } = await import(require.resolve('esbuild'));
  const result = await build({ entryPoints: [join(source, 'shared-cost-runtime.ts')], outfile: runtime, bundle: true,
    platform: 'node', format: 'esm', target: 'node24', metafile: true, logLevel: 'silent',
    banner: { js: "import { createRequire as __paperclipCreateRequire } from 'node:module'; const require = __paperclipCreateRequire(import.meta.url);" } });
  const history = await build({ entryPoints: [join(repository, 'tests/runner-e2e/private-history.ts')],
    outfile: join(output, 'private-history.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', metafile: true, logLevel: 'silent' });
  await cp(join(repository, 'tests/runner-e2e/private-history-archive.py'), join(output, 'private-history-archive.py'), { errorOnExist: true, force: false });
  if (result.warnings.length || history.warnings.length) throw new Error('Controller runtime bundle emitted unresolved build warnings');
  const { isBuiltin } = await import('node:module');
  if (Object.values({ ...result.metafile.outputs, ...history.metafile.outputs }).some(item => item.imports.some(item => !isBuiltin(item.path)))) throw new Error('Controller runtime has unbundled imports');
  async function packageManifest(name, parentRequire) {
    try { return await realpath(parentRequire.resolve(`${name}/package.json`)); }
    catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }
    let directory = dirname(await realpath(parentRequire.resolve(name)));
    while (true) {
      const candidate = join(directory, 'package.json');
      try {
        if (JSON.parse(await readFile(candidate, 'utf8')).name === name) return candidate;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = dirname(directory);
      if (parent === directory) throw new Error('Controller dependency package metadata is missing');
      directory = parent;
    }
  }
  let packages = 0;
  const packageInputs = {};
  async function copyPackage(name, parentRequire, destination, ancestors = new Set()) {
    if (++packages > 128 || ancestors.size > 16) throw new Error('Controller dependency closure exceeds its limit');
    const manifest = await packageManifest(name, parentRequire);
    if (ancestors.has(manifest)) throw new Error('Controller dependency closure contains an unsupported cycle');
    const bytes = await readFile(manifest), metadata = JSON.parse(bytes.toString('utf8'));
    packageInputs[`${metadata.name}@${metadata.version}`] = sha256(bytes);
    const target = join(destination, 'node_modules', name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(dirname(manifest), target, { recursive: true, dereference: true, errorOnExist: true, force: false,
      filter: path => basename(path) !== 'node_modules' });
    for (const dependency of Object.keys(metadata.dependencies ?? {}).sort()) {
      await copyPackage(dependency, createRequire(manifest), target, new Set([...ancestors, manifest]));
    }
  }
  const server = join(output, 'server'); await mkdir(server, { mode: 0o700 });
  await writeFile(join(server, 'package.json'), '{"private":true}\n', { flag: 'wx', mode: 0o600 });
  await copyPackage('protobufjs', require, server);
  await writeFile(join(controller, 'runtime.mjs'), "export * as costRuntime from '../tests/runner-e2e/shared-runtime.mjs';\n", { flag: 'wx', mode: 0o600 });
  const inputs = { 'pnpm-lock.yaml': sha256(await readFile(join(repository, 'pnpm-lock.yaml'))) };
  for (const path of Object.keys({ ...result.metafile.inputs, ...history.metafile.inputs })) {
    const absolute = resolve(path);
    inputs[relative(repository, absolute).split('\\').join('/')] = sha256(await readFile(absolute));
  }
  inputs['tests/runner-e2e/private-history-archive.py'] = sha256(await readFile(join(repository, 'tests/runner-e2e/private-history-archive.py')));
  for (const file of [...scripts, 'build-runtime.mjs', 'runtime.mjs']) inputs[relative(repository, join(source, file))] = sha256(await readFile(join(source, file)));
  const files = {}; let payloadBytes = 0;
  async function inventory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inventory(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path); payloadBytes += bytes.length;
        if (payloadBytes > RUNTIME_MAX_BYTES || Object.keys(files).length >= RUNTIME_MAX_FILES - 1) throw new Error('Controller runtime exceeds its artifact allowance');
        files[relative(output, path).split('\\').join('/')] = { sha256: sha256(bytes), sizeBytes: bytes.length };
      } else throw new Error('Controller runtime contains a nonregular file');
    }
  }
  await inventory(output);
  const receipt = { schema: 'paperclip.runner-eval.controller-runtime/v1', sourceRevision, nodeMajor: 24, inputs, packageInputs, payloadBytes, files };
  const receiptBytes = encodeRuntimeReceipt(receipt);
  if (payloadBytes + Buffer.byteLength(receiptBytes) > RUNTIME_MAX_BYTES) throw new Error('Controller runtime receipt exceeds its artifact allowance');
  await writeFile(join(output, 'runtime.json'), receiptBytes, { flag: 'wx', mode: 0o600 });
  return { ...receipt, totalBytes: payloadBytes + Buffer.byteLength(receiptBytes), receiptSha256: sha256(receiptBytes) };
}

if (await isEntrypoint(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: build-runtime.mjs <new-output-directory> <source-revision>');
  const receipt = await buildControllerRuntime({ outputDirectory: process.argv[2], sourceRevision: process.argv[3] });
  process.stdout.write(JSON.stringify({ sourceRevision: receipt.sourceRevision, totalBytes: receipt.totalBytes, receiptSha256: receipt.receiptSha256, files: Object.keys(receipt.files).length + 1 }) + '\n');
}
