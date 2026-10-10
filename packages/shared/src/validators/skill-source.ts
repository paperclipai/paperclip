import { z } from 'zod';
import { parseGitHubSkillRepositoryUrl } from '../github-skill-repository.js';
const repositoryUrl = z.string().trim().max(2048).refine(value => parseGitHubSkillRepositoryUrl(value) !== null, 'Enter an HTTPS GitHub repository or branch URL.');
const repoPath = z.string().max(4096).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').some(part => part === '..' || part === '.'), 'Invalid repository path');
const referencePaths = z.array(repoPath.refine(value => value.length > 0)).max(1000);
const includedReferences = z.record(repoPath, referencePaths).refine(value => Object.keys(value).length <= 1000, 'Too many skill selections');
export const skillSourceDiscoverySchema = z.object({
  repositoryUrl,
  trackingRef: z.string().trim().min(1).max(255).optional(),
  connectionId: z.string().uuid().nullable().optional(),
});
export const skillSourcePreviewSchema = skillSourceDiscoverySchema.extend({
  includedReferences: referencePaths.optional(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
  skillPath: repoPath.refine(value => /(^|\/)skill\.md$/i.test(value), 'Invalid skill entrypoint'),
  filePath: repoPath.refine(value => value.length > 0, 'A file path is required'),
});
export const skillSourceCreateSchema = skillSourceDiscoverySchema.extend({
  includedReferences: includedReferences.optional(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
  selectedPaths: z.array(repoPath).max(10000),
  excludedFolders: z.array(repoPath).max(10000).default([]),
});
export const skillSourceSelectionSchema = z.object({
  includedReferences: includedReferences.optional(),
  revision: z.number().int().nonnegative(),
  selectedPaths: z.array(repoPath).max(10000),
  excludedFolders: z.array(repoPath).max(10000),
  connectionId: z.string().uuid().nullable().optional(),
});
