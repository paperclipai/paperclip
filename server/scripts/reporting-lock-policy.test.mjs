import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { prepareReportLock } from '../../tests/runner-e2e/prepare-report-lock.mjs';

it('admits the committed controller lock through the reviewed reporting policy before paid execution', async () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), 'controller-report-policy-'));
  const relative = 'tests/runner-e2e';
  try {
    await mkdir(path.join(root, relative), { recursive: true });
    for (const file of ['report-lock.json', 'report-lock.patch']) {
      await copyFile(path.join(repository, relative, file), path.join(root, relative, file));
    }
    await writeFile(path.join(root, 'pnpm-lock.yaml'), execFileSync('git', ['show', 'HEAD:pnpm-lock.yaml'], { cwd: repository }));
    const manifests = execFileSync('git', ['ls-files', '--', 'package.json', '**/package.json', 'pnpm-workspace.yaml', '.npmrc', 'patches/*'], { cwd: repository, encoding: 'utf8' }).trim().split('\n');
    for (const file of manifests) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await copyFile(path.join(repository, file), path.join(root, file));
    }
    await prepareReportLock(root);
    const policy = JSON.parse(await readFile(path.join(root, relative, 'report-lock.json'), 'utf8'));
    expect(createHash('sha256').update(await readFile(path.join(root, 'pnpm-lock.yaml'))).digest('hex')).toBe(policy.outputSha256);
    expect(execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim()).toBe('9.15.4');
    execFileSync('pnpm', ['install', '--lockfile-only', '--frozen-lockfile', '--ignore-scripts', '--offline'], { cwd: root, stdio: 'pipe', timeout: 10000 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
