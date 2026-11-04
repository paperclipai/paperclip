// Writes an unauthorized template with explicit local path locations. This does
// not register a build, alter a pin, qualify a host or release execution.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hash } from './verify-package.mjs';

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const template = option('template'), mapping = option('path-map'), output = option('output');
assert.ok(template && mapping && output, 'Pass --template, --path-map and a fresh --output');
const input = await readFile(template), value = JSON.parse(input);
assert.equal(value.authorized, false, 'Only unauthorized templates may be relocated');
const paths = JSON.parse(await readFile(mapping, 'utf8'));
for (const [from, to] of Object.entries(paths)) {
  assert.ok(path.isAbsolute(from) && path.isAbsolute(to));
  assert.equal(path.normalize(from), from); assert.equal(path.normalize(to), to);
}
let replacements = 0;
function relocate(item) {
  if (Array.isArray(item)) return item.map(relocate);
  if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, relocate(child)]));
  if (typeof item !== 'string') return item;
  for (const [from, to] of Object.entries(paths).sort(([a], [b]) => b.length - a.length)) {
    if (item === from || item.startsWith(from + '/')) { replacements++; return to + item.slice(from.length); }
  }
  return item;
}
const relocated = relocate(value);
assert.equal(relocated.authorized, false);
await writeFile(output, JSON.stringify(relocated, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ templateSha256: hash(input), output, replacements, authorized: false,
  executionReleased: false, note: 'Locations only. Exact build/source/native/hash/runtime and guard evidence must still match; original receipt references may require their original qualified path.' }));
