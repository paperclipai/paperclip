import path from 'node:path';
import type { CompanySkillVersionFileInventoryEntry, SkillRepositoryPackage } from '@paperclipai/shared';
import { z } from 'zod';
import { assertSkillSnapshotPath, skillFileBytes } from './skill-snapshot.js';

export const REPOSITORY_CONTENT_DIR = '.paperclip-repository';
export const MAX_REPOSITORY_FILES = 9_990;
export const MAX_REPOSITORY_BYTES = 61 * 1024 * 1024;
export function repositorySkillFrontmatter(content: string): string | undefined {
  return content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
}
const manifestSchema = z.object({
  version: z.literal(1),
  skills: z.array(z.string().min(1).max(4096)).min(1).max(1000),
  requirements: z.string().max(4000).optional(),
}).strict();

/** Declarative metadata only: importing never invokes a repository's installer. */
export function inspectRepositoryManifest(files: CompanySkillVersionFileInventoryEntry[], skillPaths: string[]) {
  const file = files.find(file => file.path === 'paperclip.skills.json');
  if (!file) return {};
  const manifest = manifestSchema.parse(JSON.parse(skillFileBytes(file).toString('utf8')));
  const declared = [...new Set(manifest.skills.map(assertSkillSnapshotPath))];
  if (declared.some(value => !skillPaths.includes(value))) throw new Error('Manifest skills must name existing SKILL.md entrypoints.');
  return { skillPaths: declared, requirements: manifest.requirements ?? null };
}

export function repositoryPackageInspection(files: CompanySkillVersionFileInventoryEntry[], skillPaths: string[], warnings: string[], error: string | null): SkillRepositoryPackage {
  let manifest: ReturnType<typeof inspectRepositoryManifest> = {};
  try { manifest = inspectRepositoryManifest(files, skillPaths); }
  catch { warnings = [...warnings, 'paperclip.skills.json — Invalid manifest; skills were discovered automatically.']; }
  return { files: files.map(file => ({ path: file.path, kind: file.kind, sizeBytes: skillFileBytes(file).length,
    encoding: file.encoding ?? 'utf8', executable: file.executable ?? false })), requirements: null, ...manifest, error, warnings };
}

/** A portable discovery entrypoint directs the agent to the untouched original.
 * The full tree travels inside the skill on every existing adapter and sandbox
 * transport. Never rewrite authored relative links or use host-only symlinks.
 */
export function repositorySkillProjection(files: CompanySkillVersionFileInventoryEntry[], skillPath: string): CompanySkillVersionFileInventoryEntry[] {
  assertSkillSnapshotPath(skillPath);
  const skill = files.find(file => file.path === skillPath);
  if (!skill || skill.encoding === 'base64') throw new Error('Repository skill entrypoint is missing or not text.');
  const frontmatter = repositorySkillFrontmatter(skill.content);
  if (!frontmatter) throw new Error('Repository skill entrypoint has no frontmatter.');
  const target = `${REPOSITORY_CONTENT_DIR}/${skillPath}`;
  const wrapper = `${frontmatter.trimEnd()}\n\nRead and follow the complete skill instructions in [${skillPath}](${target.split('/').map(encodeURIComponent).join('/')}). Resolve the original skill's relative file references from its directory inside \`${REPOSITORY_CONTENT_DIR}/\`. That directory contains the included pinned repository files, including supporting skills and shared files. Repository-root paths are relative to that directory.\n`;
  // Host-specific discovery policy belongs beside the generated entrypoint too.
  const policyPath = path.posix.join(path.posix.dirname(skillPath), 'agents/openai.yaml');
  return [{ path: 'SKILL.md', kind: 'skill', content: wrapper },
    ...files.filter(file => file.path === policyPath).map(file => ({ ...file, path: 'agents/openai.yaml' })),
    ...files.map(file => ({ ...file, path: `${REPOSITORY_CONTENT_DIR}/${assertSkillSnapshotPath(file.path)}` }))];
}
