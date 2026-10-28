import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { prepareReportLock } from './prepare-report-lock.mjs';

it.each(['valid', 'unknown-lock', 'changed-patch', 'wrong-output'])(
  'installs only the reviewed dependency correction: %s', async variant => {
    const root = await mkdtemp(path.join(tmpdir(), 'eval-report-lock-test-'));
    const here = import.meta.dirname, relative = path.join(root, 'tests/runner-e2e');
    try {
      await mkdir(relative, { recursive: true });
      for (const file of ['report-lock.json', 'report-lock.patch']) await copyFile(path.join(here, file), path.join(relative, file));
      const committed = execFileSync('git', ['show', 'HEAD:pnpm-lock.yaml'], { cwd: path.resolve(here, '../..') });
      const policy = JSON.parse(await readFile(path.join(relative, 'report-lock.json'), 'utf8'));
      const committedHash = createHash('sha256').update(committed).digest('hex');
      expect([policy.inputSha256, policy.outputSha256]).toContain(committedHash);
      const lock = path.join(root, 'pnpm-lock.yaml');
      await writeFile(lock, committed);
      if (variant === 'valid') {
        expect(await prepareReportLock(root)).toBe(committedHash === policy.outputSha256 ? 'already-reviewed' : 'reviewed-correction');
        expect(createHash('sha256').update(await readFile(lock)).digest('hex')).toBe(policy.outputSha256);
        await writeFile(lock, committed);
      }
      if (committedHash === policy.outputSha256) {
        execFileSync('git', ['apply', '--reverse', path.join(relative, 'report-lock.patch')], { cwd: root });
      }
      const input = await readFile(lock);
      expect(createHash('sha256').update(input).digest('hex')).toBe(policy.inputSha256);
      await writeFile(lock, variant === 'unknown-lock' ? 'unknown\n' : input);
      if (variant === 'changed-patch') await writeFile(path.join(relative, 'report-lock.patch'), 'changed');
      if (variant === 'wrong-output') { policy.outputSha256 = '0'.repeat(64); await writeFile(path.join(relative, 'report-lock.json'), JSON.stringify(policy)); }
      if (variant === 'valid') {
        expect(await prepareReportLock(root)).toBe('reviewed-correction');
        expect(createHash('sha256').update(await readFile(lock)).digest('hex')).toBe(policy.outputSha256);
        expect(await prepareReportLock(root)).toBe('already-reviewed');
        const before = parse(input.toString()).packages;
        const after = parse(await readFile(lock, 'utf8')).packages;
        expect(Object.keys(after).filter(key => !Object.hasOwn(before, key))).toEqual(['yaml@2.9.1']);
        for (const [key, value] of Object.entries(before)) expect(after[key]).toEqual(value);
        expect(after['yaml@2.9.1'].resolution.integrity).toBe('sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==');

      } else {
        await expect(prepareReportLock(root)).rejects.toThrow();
        expect(await readFile(lock)).toEqual(variant === 'unknown-lock' ? Buffer.from('unknown\n') : input);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  },
);
