import { build, transform } from 'esbuild';
import { readdir, mkdir, writeFile, cp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root = fileURLToPath(new URL("../../..", import.meta.url));
process.chdir(root);
async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '__tests__') out.push(...await sources(file));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.d\.ts$|\.test\.tsx?$/.test(entry.name)) out.push(file);
  }
  return out;
}
async function assets(dir, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name), target = path.join(out, entry.name);
    if (entry.isDirectory() && entry.name !== '__tests__') await assets(file, target);
    else if (entry.isFile() && entry.name.endsWith('.json')) { await mkdir(out, { recursive: true }); await cp(file, target); }
  }
}
for (const pkg of ['packages/shared', 'packages/db', 'server']) {
  const src = path.join(root, pkg, 'src');
  await build({ entryPoints: await sources(src), outbase: src, outdir: path.join(root, pkg, 'dist'),
    format: 'esm', platform: 'node', target: 'node24', sourcemap: true, logLevel: 'warning' });
  await assets(src, path.join(root, pkg, 'dist'));
}
await cp('packages/db/src/migrations', 'packages/db/dist/migrations', { recursive: true });
await cp('packages/shared/src/app-definitions', 'packages/shared/dist/app-definitions', { recursive: true });
await mkdir('server/dist/__tests__/helpers', { recursive: true });
await build({ entryPoints: ['server/src/__tests__/helpers/tool-profile-projection-fixture.ts', 'server/src/__tests__/helpers/embedded-postgres.ts'],
  outbase: 'server/src/__tests__/helpers', outdir: 'server/dist/__tests__/helpers', format: 'esm', platform: 'node', target: 'node24', sourcemap: true });
for (const [label, sha] of [['baseline', '1f8f2e195f4897cd1c237bdc068de95780ab0c3c'], ['pending', 'fd59c0183ce64c44696f79604516f4d51ca5662b']]) {
  for (const [name, file] of [['projection', 'profiles/projection'], ['service', 'profiles/service'], ['attention', 'catalog/attention']]) {
    const relative = `server/src/services/tool-access/${file}.ts`;
    let code = execFileSync('git', ['show', `${sha}:${relative}`], { encoding: 'utf8', maxBuffer: 5e6 });
    if (name === 'service') code = code.replace('from "./projection.js"', `from "./.${label}-projection.js"`);
    if (name === 'attention') code = code.replace('from "../profiles/projection.js"', `from "../profiles/.${label}-projection.js"`);
    const outfile = `server/dist/services/tool-access/${path.dirname(file)}/.${label}-${name}.js`;
    const result = await transform(code, { loader: 'ts', format: 'esm', platform: 'node', target: 'node24', sourcefile: relative, sourcemap: 'inline' });
    await writeFile(outfile, result.code);
  }
}
const owners = ['profiles/projection', 'profiles/service', 'profiles/resolution', 'catalog/attention'];
const manifest = {
  baseline: '1f8f2e195f4897cd1c237bdc068de95780ab0c3c',
  pending: 'fd59c0183ce64c44696f79604516f4d51ca5662b',
  treatmentHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceSha256: Object.fromEntries(await Promise.all(owners.map(async file => [file,
    createHash('sha256').update(await readFile(`server/src/services/tool-access/${file}.ts`)).digest('hex')]))),
};
await writeFile('server/dist/.profile-projection-build.json', JSON.stringify(manifest, null, 2));
console.log('Compiled baseline, pending-only, and current owning service modules; no runtime TypeScript loader.');
