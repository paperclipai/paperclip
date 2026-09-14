/** Fixed, bounded, metadata-only workspace measurement. Never emits paths. */
export const runtimeServiceStorageSource = String.raw`
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
async function main() {
  const root = process.argv[1];
  if (!root || !path.isAbsolute(root) || root === path.parse(root).root) throw new Error();
  const before = await fs.lstat(root);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error();
  const canonical = await fs.realpath(root);
  // du walks physical directory entries, counts hard links once, and stays on
  // this filesystem. The result is allocated workspace blocks, not billing.
  const { stdout } = await promisify(execFile)('/usr/bin/du', ['-skx', '--', canonical], {
    timeout: 8000, maxBuffer: 512 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  const after = await fs.lstat(root);
  if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || await fs.realpath(root) !== canonical) throw new Error();
  const match = /^(\d+)\s/.exec(stdout);
  const bytes = match ? Number(match[1]) * 1024 : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error();
  process.stdout.write(JSON.stringify({ bytes }));
}
main().catch(() => { process.stderr.write('Workspace measurement unavailable\n'); process.exitCode = 1; });
`;
