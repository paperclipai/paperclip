import { expect, it, vi } from 'vitest';
import { skillRepositoryDependencies } from '../services/skill-repository-dependencies.js';
import { MAX_REPOSITORY_FILES } from '../services/skill-repository-package.js';
import type { GitSkillTreeEntry } from '../services/skill-source-git-snapshot.js';

it('keeps path visits bounded for a reference chain at the repository file limit', async () => {
  let pathVisits = 0;
  const paths = ['skills/main/SKILL.md', ...Array.from({ length: MAX_REPOSITORY_FILES - 1 }, (_, i) => `shared/${i}.md`)];
  const entries: GitSkillTreeEntry[] = paths.map((name, i) => ({
    get path() { pathVisits++; return name; },
    sha: i.toString(16).padStart(40, '0'), mode: '100644', type: 'blob', size: 100,
  }));
  const content = new Map(paths.map((name, i) => [name, Buffer.from(i === 0 ? '[Next](../../shared/0.md)'
    : `[Next](${i === paths.length - 1 ? '0' : String(i)}.md)`)]));
  const read = vi.fn(async (entry: GitSkillTreeEntry) => content.get(entry.path)!);
  const prefetch = vi.fn(async () => {});
  const selected = await skillRepositoryDependencies(entries, [entries[0]!], new Set(['skills/main']), read, prefetch);
  expect(selected).toEqual(entries);
  expect(read).toHaveBeenCalledTimes(MAX_REPOSITORY_FILES);
  expect(prefetch).toHaveBeenCalledTimes(MAX_REPOSITORY_FILES);
  expect(pathVisits).toBeLessThan(MAX_REPOSITORY_FILES * 100);
});
