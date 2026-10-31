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
export async function refreshReportLock(root = path.resolve(import.meta.dirname, '../..')) {
  const directory = path.join(root, 'tests/runner-e2e');
  const policyPath = path.join(directory, 'report-lock.json');
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const committed = execFileSync('git', ['show', 'HEAD:pnpm-lock.yaml'], { cwd: root });
  const inputSha256 = sha256(committed);
  if (![policy.inputSha256, policy.outputSha256].includes(inputSha256)) {
    throw new Error('Committed report lock is not reviewed; refusing to refresh its proof');
  }
  const resolved = await readFile(path.join(root, 'pnpm-lock.yaml'));
  if (resolved.equals(committed)) return 'unchanged';
  const patch = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', 'pnpm-lock.yaml'], { cwd: root });
  const changed = execFileSync('git', ['apply', '--numstat', '-'], { cwd: root, input: patch, encoding: 'utf8' });
  if (!/^\d+\s+\d+\s+pnpm-lock\.yaml\n$/.test(changed)) throw new Error('Report correction must change only the lockfile');
  await writeFile(path.join(directory, 'report-lock.patch'), patch);
  await writeFile(policyPath, JSON.stringify({ inputSha256, outputSha256: sha256(resolved), patchSha256: sha256(patch),
    basis: 'Generated with the trusted master lockfile refresh. Review this offline correction and its hashes with the dependency changes.' }, null, 2) + '\n');
  return 'refreshed';
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 0) console.log(await prepareReportLock());
  else if (args.length === 1 && args[0] === '--refresh') console.log(await refreshReportLock());
  else throw new Error('Usage: prepare-report-lock.mjs [--refresh]');
}
