import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function prepareReportLock(root = path.resolve(import.meta.dirname, '../..')) {
  const policy = JSON.parse(await readFile(path.join(root, 'tests/runner-e2e/report-lock.json'), 'utf8'));
  const lockPath = path.join(root, 'pnpm-lock.yaml');
  const bytes = await readFile(lockPath), current = sha256(bytes);
  if (current === policy.outputSha256) return 'already-reviewed';
  if (current !== policy.inputSha256) throw new Error('Reporting lock changed; review the dependency correction before install');
  const patch = await readFile(path.join(root, 'tests/runner-e2e/report-lock.patch'));
  if (sha256(patch) !== policy.patchSha256) throw new Error('Reviewed reporting lock patch changed');
  const result = execFileSync('git', ['apply', '--numstat', '-'], { cwd: root, input: patch, encoding: 'utf8' });
  if (!/^\d+\s+\d+\s+pnpm-lock\.yaml\n$/.test(result)) throw new Error('Reporting correction must change only the lockfile');
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-reviewed-lock-'));
  try {
    await writeFile(path.join(temporary, 'pnpm-lock.yaml'), bytes);
    execFileSync('git', ['apply', '-'], { cwd: temporary, input: patch });
    const corrected = await readFile(path.join(temporary, 'pnpm-lock.yaml'));
    if (sha256(corrected) !== policy.outputSha256) throw new Error('Reviewed reporting lock result changed');
    await writeFile(lockPath, corrected);
    return 'reviewed-correction';
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(await prepareReportLock());
}
