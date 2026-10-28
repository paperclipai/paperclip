import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materializePaperclipSkillCopy } from '@paperclipai/adapter-utils/server-utils';
import { repositorySkillProjection } from '../services/skill-repository-package.js';
import { snapshotFile, skillFileBytes } from '../services/skill-snapshot.js';

const md = '---\nname: main\ndescription: Work\ndisable-model-invocation: true\n---\nRead [runtime](../runtime/SKILL.md) and ../../agents/worker.md.\n';
describe('repository skill delivery', () => {
  it('survives copying and relocating the assigned skill with original bytes, paths, modes, credits and discovery policy intact', async () => {
    const files = [snapshotFile('skills/main/SKILL.md', 'skill', Buffer.from(md)),
      snapshotFile('skills/main/agents/openai.yaml', 'other', Buffer.from('policy:\n  allow_implicit_invocation: false\n')),
      snapshotFile('skills/runtime/SKILL.md', 'skill', Buffer.from('Runtime instructions')),
      snapshotFile('agents/worker.md', 'markdown', Buffer.from('Worker instructions')),
      snapshotFile('NOTICE.md', 'markdown', Buffer.from('Credits')),
      snapshotFile('shared/run.sh', 'script', Buffer.from('#!/bin/sh\necho ready\n'), true),
      snapshotFile('docs/image.png', 'asset', Buffer.from([0, 255, 137, 80]))];
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repository-skill-'));
    try {
      const source = path.join(root, 'source'), sandbox = path.join(root, 'sandbox', 'main--id');
      for (const file of repositorySkillProjection(files, 'skills/main/SKILL.md')) {
        const target = path.join(source, file.path); await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, skillFileBytes(file), { mode: file.executable ? 0o755 : 0o644 });
      }
      await materializePaperclipSkillCopy(source, sandbox);
      await fs.rm(source, { recursive: true });
      const entrypoint = await fs.readFile(path.join(sandbox, 'SKILL.md'), 'utf8');
      expect(entrypoint).toContain('disable-model-invocation: true');
      expect(entrypoint).toContain('.paperclip-repository/skills/main/SKILL.md');
      const canonical = path.join(sandbox, '.paperclip-repository/skills/main');
      expect(await fs.readFile(path.join(canonical, 'SKILL.md'), 'utf8')).toBe(md);
      expect(await fs.readFile(path.join(canonical, '../runtime/SKILL.md'), 'utf8')).toBe('Runtime instructions');
      expect(await fs.readFile(path.join(canonical, '../../agents/worker.md'), 'utf8')).toBe('Worker instructions');
      for (const file of files) expect(await fs.readFile(path.join(sandbox, '.paperclip-repository', file.path))).toEqual(skillFileBytes(file));
      expect((await fs.stat(path.join(canonical, '../../shared/run.sh'))).mode & 0o111).toBeTruthy();
      expect(await fs.readFile(path.join(sandbox, 'agents/openai.yaml'), 'utf8')).toContain('allow_implicit_invocation: false');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('rejects escaped and absent entrypoints', () => {
    expect(() => repositorySkillProjection([], '../SKILL.md')).toThrow(/Invalid/);
    expect(() => repositorySkillProjection([], 'missing/SKILL.md')).toThrow(/missing/);
  });
});
