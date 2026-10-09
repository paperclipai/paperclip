import path from 'node:path';
import type { CompanySkillAuditFinding, CompanySkillVersionFileInventoryEntry, SkillPackageInspection, SkillPackageReference } from '@paperclipai/shared';
import { unprocessable } from '../errors.js';
import { skillFileBytes } from './skill-snapshot.js';

/** Inspect explicit Markdown links and inline-code resource paths, not project filenames, prose, or shell commands. */
function referencesIn(markdown: string) {
  const text = markdown.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '');
  const references: { target: string; rootRelative: boolean }[] = [];
  // Link/image destinations and reference definitions; optional titles are not part of the path.
  for (const match of text.matchAll(/(?:!?\[[^\]\n]*\]\(|^\s*\[[^\]\n]+\]:\s*)(?:<([^>\n]+)>|([^\s)]+))/gm)) {
    references.push({ target: match[1] ?? match[2]!, rootRelative: false });
  }
  for (const match of text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
    const target = match[1]!;
    if (/^(?:\.\.?\/|references\/|scripts\/|assets\/)[\w.\-/]+\.[a-z][a-z0-9]{0,11}$/i.test(target)) {
      // Explicit dot paths belong to the containing document; conventional resource paths start at the package root.
      references.push({ target, rootRelative: !target.startsWith('.') });
    }
  }
  return references;
}

/** Build once per repository; stop at ancestors already indexed by an earlier path. */
export function indexSkillPackagePaths(paths: Iterable<string>): ReadonlySet<string> {
  const result = new Set<string>();
  const add = (value: string) => {
    result.add(value);
    if (result.size > 100_000) throw unprocessable('Repository exceeds the 100,000 path scan limit.');
  };
  for (const file of paths) {
    add(file);
    let parent = path.posix.dirname(file);
    while (parent !== '.' && parent !== '/' && !result.has(parent)) {
      add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  if (result.size) add('.');
  return result;
}

export function inspectSkillPackage(
  skillPath: string,
  files: CompanySkillVersionFileInventoryEntry[],
  repositoryPaths: ReadonlySet<string>,
  frontmatter: Record<string, unknown>,
  findings: CompanySkillAuditFinding[],
): SkillPackageInspection {
  const root = path.posix.dirname(skillPath);
  const inPackage = indexSkillPackagePaths(files.map(file => file.path === 'SKILL.md' ? skillPath : path.posix.join(root, file.path)));
  const references = new Map<string, SkillPackageReference>();
  const contains = (paths: ReadonlySet<string>, target: string) => paths.has(target);
  for (const file of files) {
    if (file.encoding === 'base64' || !/\.md$/i.test(file.path)) continue;
    for (const { target, rootRelative } of referencesIn(file.content)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
      let decoded: string;
      try { decoded = decodeURIComponent(target.split(/[?#]/)[0]!); } catch { continue; }
      if (!decoded) continue;
      const resolvedPath = path.posix.normalize(path.posix.join(root, rootRelative ? '' : path.posix.dirname(file.path), decoded)).replace(/\/+$/, '');
      if (!decoded.startsWith('/') && contains(inPackage, resolvedPath)) continue;
      const outsideRoot = decoded.startsWith('/') || resolvedPath === '..' || resolvedPath.startsWith('../')
        || (root !== '.' && !resolvedPath.startsWith(`${root}/`) && resolvedPath !== root);
      const kind = outsideRoot || contains(repositoryPaths, resolvedPath) ? 'outside_package' : 'missing';
      references.set(`${file.path}:${resolvedPath}`, { fromPath: file.path, target, resolvedPath, kind });
    }
  }
  return {
    files: files.map(file => ({ path: file.path, kind: file.kind, encoding: file.encoding ?? 'utf8', executable: file.executable ?? false, sizeBytes: skillFileBytes(file).length })),
    requirements: typeof frontmatter.compatibility === 'string' ? frontmatter.compatibility.trim() || null : null,
    references: [...references.values()],
    // Structured reference findings replace the audit's unstructured, less precise link warnings.
    warnings: [...new Set(findings.filter(finding => finding.severity === 'warning' && finding.code !== 'broken_internal_link').map(finding => finding.message))],
  };
}
