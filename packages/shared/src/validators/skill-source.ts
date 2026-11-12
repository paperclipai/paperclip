import { z } from 'zod';
import { parseGitHubSkillRepositoryUrl } from '../github-skill-repository.js';
const repositoryUrl = z.string().trim().max(2048).refine(value => parseGitHubSkillRepositoryUrl(value) !== null, 'Enter an HTTPS GitHub repository or branch URL.');
const repoPath = z.string().max(4096).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').some(part => part === '..' || part === '.'), 'Invalid repository path');
export const skillSourceDiscoverySchema = z.object({
  repositoryUrl,
  packageMode: z.enum(['skills', 'repository']).optional(),
  trackingRef: z.string().trim().min(1).max(255).optional(),
  connectionId: z.string().uuid().nullable().optional(),
});
export const skillSourcePreviewSchema = skillSourceDiscoverySchema.extend({
  commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
  skillPath: repoPath.refine(value => /(^|\/)skill\.md$/i.test(value), 'Invalid skill entrypoint'),
  filePath: repoPath.refine(value => value.length > 0, 'A file path is required'),
});
const sha = z.string().regex(/^[a-f0-9]{40}$/i);
/**
 * Path bytes one approval may carry. With the hashes this keeps an approval near 5 MB,
 * well inside the server's 10 MB JSON body limit together with the selected paths.
 */
export const SKILL_SECURITY_OVERRIDE_MAX_PATH_BYTES = 4 * 1024 * 1024;
const utf8 = new TextEncoder();
export function skillSecurityOverridePathBytes(files: ReadonlyArray<{ path: string }>) {
  let total = 0;
  for (const file of files) total += utf8.encode(file.path).length;
  return total;
}
// The count matches the server's repository scan file limit; the path budget above keeps the request within the body limit.
export const skillSecurityOverrideSchema = z.object({
  commitSha: sha,
  files: z.array(z.object({ path: repoPath.refine(value => value.length > 0, 'A file path is required'), sha256: z.string().regex(/^[a-f0-9]{64}$/i) })).min(1).max(10_000)
    .refine(files => new Set(files.map(file => file.path)).size === files.length, 'Each file can be approved once.')
    .refine(files => skillSecurityOverridePathBytes(files) <= SKILL_SECURITY_OVERRIDE_MAX_PATH_BYTES, 'Too many flagged files to approve in one request.'),
  reason: z.string().trim().min(10, 'Explain why this repository is trusted.').max(2000),
  trustFutureUpdates: z.boolean().default(false),
});
export const skillSourceCreateSchema = skillSourceDiscoverySchema.extend({
  commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
  selectedPaths: z.array(repoPath).max(10000),
  excludedFolders: z.array(repoPath).max(10000).default([]),
  securityOverride: skillSecurityOverrideSchema.optional(),
});
export const skillSourceSelectionSchema = z.object({
  packageMode: z.enum(['skills', 'repository']).optional(),
  revision: z.number().int().nonnegative(),
  selectedPaths: z.array(repoPath).max(10000),
  excludedFolders: z.array(repoPath).max(10000),
  connectionId: z.string().uuid().nullable().optional(),
  securityOverride: skillSecurityOverrideSchema.nullable().optional(),
});
export const skillSourceSettingsSchema = z.object({
  revision: z.number().int().nonnegative(),
  automaticUpdates: z.boolean().optional(),
  importNewSkills: z.boolean().optional(),
  connectionId: z.string().uuid().nullable().optional(),
  trackingRef: z.string().trim().min(1).max(255).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Enter a valid branch or revision.').optional(),
});
export const skillSourceBranchesQuerySchema = z.object({ connectionId: z.string().uuid().optional() });
export const projectSkillSourceAdoptSchema = z.object({
  workspaceId: z.string().uuid(),
});

export const skillSourceDisconnectSchema = z.object({
  revision: z.number().int().nonnegative(),
  skills: z.enum(['copy', 'delete']),
});
