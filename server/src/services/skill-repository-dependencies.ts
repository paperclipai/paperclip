import path from 'node:path';
import { unprocessable } from '../errors.js';
import { indexSkillPackagePaths, inspectSkillPackage } from './skill-package-inspection.js';
import { MAX_REPOSITORY_BYTES, MAX_REPOSITORY_FILES } from './skill-repository-package.js';
import { snapshotFile } from './skill-snapshot.js';
import type { GitSkillTreeEntry } from './skill-source-git-snapshot.js';

export async function skillRepositoryDependencies(
  entries: GitSkillTreeEntry[],
  initial: GitSkillTreeEntry[],
  skillDirectories: ReadonlySet<string>,
  readBlob: (entry: GitSkillTreeEntry) => Promise<Buffer | null>,
  prefetch?: (entries: GitSkillTreeEntry[]) => Promise<void>,
): Promise<GitSkillTreeEntry[]> {
  const paths = indexSkillPackagePaths(entries.map(entry => entry.path));
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const selected = new Map<string, GitSkillTreeEntry>();
  let pending: GitSkillTreeEntry[] = [];
  let bytes = 0;
  const add = (entry: GitSkillTreeEntry) => {
    if (entry.type === 'tree' || selected.has(entry.path)) return;
    selected.set(entry.path, entry);
    if (selected.size > MAX_REPOSITORY_FILES) throw unprocessable('Repository package exceeds the 9,990 file limit.');
    if (entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && (entry.size ?? 0) <= 1024 * 1024) bytes += entry.size ?? 0;
    if (bytes > MAX_REPOSITORY_BYTES) throw unprocessable('Repository package exceeds the 61 MB runtime limit.');
    if (entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && /\.md$/i.test(entry.path)) pending.push(entry);
  };
  for (const entry of initial) add(entry);
  const manifest = byPath.get('paperclip.skills.json');
  if (manifest) add(manifest);
  while (pending.length) {
    const frontier = pending;
    pending = [];
    await prefetch?.(frontier);
    for (const entry of frontier) {
      const content = await readBlob(entry);
      if (!content) continue;
      let root = path.posix.dirname(entry.path);
      while (root !== '.' && !skillDirectories.has(root)) root = path.posix.dirname(root);
      const file = snapshotFile(path.posix.relative(root, entry.path), 'reference', content);
      const inspection = inspectSkillPackage(path.posix.join(root, 'SKILL.md'), [file], paths, {}, [], new Set([entry.path]));
      for (const reference of inspection.references) {
        const target = reference.resolvedPath;
        if (target === '..' || target.startsWith('../') || path.posix.isAbsolute(target)) continue;
        const exact = byPath.get(target);
        if (exact && exact.type !== 'tree') add(exact);
        else if (paths.has(target)) {
          const prefix = target === '.' ? '' : `${target}/`;
          for (const child of entries) if (child.path.startsWith(prefix)) add(child);
        }
      }
    }
  }
  return [...selected.values()];
}
