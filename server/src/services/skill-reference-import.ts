import path from 'node:path';
import type { CompanySkillVersionFileInventoryEntry, SkillPackageReference } from '@paperclipai/shared';
import type { GitSkillTreeEntry } from './skill-source-git-snapshot.js';
import { referencesIn } from './skill-package-inspection.js';

/** Resolve only repository-local references. Never accept an arbitrary client folder. */
export function skillReferenceScopes(entries: GitSkillTreeEntry[], roots: GitSkillTreeEntry[]) {
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const byDirectory = new Map<string, GitSkillTreeEntry[]>();
  const skillDirectories = new Set(roots.map(root => path.posix.dirname(root.path)));
  for (const entry of entries) {
    if (entry.type === 'tree') continue;
    let dir = path.posix.dirname(entry.path);
    while (true) {
      const files = byDirectory.get(dir) ?? [];
      files.push(entry); byDirectory.set(dir, files);
      if (dir === '.') break;
      dir = path.posix.dirname(dir);
    }
  }
  return (reference: SkillPackageReference) => {
    const target = reference.resolvedPath;
    let original: string;
    try { original = decodeURIComponent(reference.target.split(/[?#]/)[0]!); } catch { return null; }
    if (original.startsWith('/') || original.includes('\\')) return null;
    if (target.startsWith('/') || target.split('/').some(part => !part || part === '.' || part === '..') || target.includes('\\')) return null;
    const entry = byPath.get(target);
    const directory = byDirectory.has(target);
    if (!directory && (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) return null;
    let dir = directory ? target : path.posix.dirname(target);
    while (true) {
      if (skillDirectories.has(dir)) return { path: dir, kind: 'skill' as const, files: byDirectory.get(dir) ?? [] };
      if (dir === '.') break;
      dir = path.posix.dirname(dir);
    }
    const parent = directory ? target : path.posix.dirname(target);
    // A loose root file must not turn a checkbox into an entire repository import.
    return parent === '.' ? { path: target, kind: 'file' as const, files: [entry!] }
      : { path: parent, kind: 'folder' as const, files: byDirectory.get(parent) ?? [] };
  };
}

/** Mirror repository paths so scripts retain sibling/parent paths; expose the main manifest at the package root. */
export function relocateSkillFiles(skillPath: string, sourceFiles: Map<string, CompanySkillVersionFileInventoryEntry>, originalFiles: CompanySkillVersionFileInventoryEntry[]) {
  let mirrorRoot = 'repository';
  while (originalFiles.some(file => file.path === mirrorRoot || file.path.startsWith(`${mirrorRoot}/`))) mirrorRoot = `_${mirrorRoot}`;
  const destinations = new Map([...sourceFiles.keys()].map(origin => [origin, `${mirrorRoot}/${origin}`]));
  const origins = new Map([...destinations].map(([origin, destination]) => [destination, origin]));
  const files = [...sourceFiles].map(([origin, file]) => ({ ...file, path: destinations.get(origin)! }));
  for (const file of originalFiles) {
    const origin = file.path === 'SKILL.md' ? skillPath : path.posix.join(path.posix.dirname(skillPath), file.path);
    origins.set(file.path, origin);
  }
  files.unshift(...originalFiles);
  const roots = new Set([...sourceFiles.keys()].filter(value => /(^|\/)skill\.md$/i.test(value)).map(value => path.posix.dirname(value)));
  const rewritten = files.map(file => {
    if (file.encoding === 'base64' || !/\.md$/i.test(file.path)) return file;
    const origin = origins.get(file.path)!;
    // Conventional scripts/assets/references paths are rooted at the containing skill.
    let packageRoot = path.posix.dirname(origin);
    while (packageRoot !== '.' && !roots.has(packageRoot)) packageRoot = path.posix.dirname(packageRoot);
    const edits = referencesIn(file.content).flatMap(reference => {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(reference.target)) return [];
      const [raw] = reference.target.split(/[?#]/);
      let decoded: string;
      try { decoded = decodeURIComponent(raw!); } catch { return []; }
      const resolved = path.posix.normalize(path.posix.join(reference.rootRelative ? packageRoot : path.posix.dirname(origin), decoded));
      // Directories may be linked too, provided at least one included file lives there.
      const destination = destinations.get(resolved)
        ?? ([...destinations.keys()].some(value => value.startsWith(`${resolved}/`)) ? `${mirrorRoot}/${resolved}` : undefined);
      if (destination === undefined) return [];
      const relative = path.posix.relative(path.posix.dirname(file.path), destination) || '.';
      const replacement = `${!relative.startsWith('.') ? './' : ''}${relative.split('/').map(encodeURIComponent).join('/')}${reference.target.slice(raw!.length)}`;
      return [{ ...reference, replacement }];
    }).sort((a, b) => b.offset - a.offset);
    let content = file.content;
    for (const edit of edits) content = content.slice(0, edit.offset) + edit.replacement + content.slice(edit.offset + edit.target.length);
    return { ...file, content };
  });
  return { files, rewritten, origins };
}
