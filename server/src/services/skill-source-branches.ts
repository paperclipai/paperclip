import type { SkillSource, SkillSourceBranches } from '@paperclipai/shared';
import { conflict, unprocessable } from '../errors.js';
import type { GitHubRead } from './github-skill-source.js';

const LIMIT = 100;
function branchName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
}

/** One bounded GitHub list request. The repository default is always included. */
export async function listSkillSourceBranches(source: Pick<SkillSource, 'fullName' | 'repositoryId'>, read: GitHubRead, signal?: AbortSignal): Promise<SkillSourceBranches> {
  const repository = await read(`/repos/${source.fullName}`, signal) as { id: number; default_branch: unknown };
  if (source.repositoryId && String(repository.id) !== source.repositoryId) throw conflict('The repository at this URL has changed identity. Add it as a new source.');
  if (!branchName(repository.default_branch)) throw unprocessable('GitHub returned an invalid default branch. Try again.');
  const result = await read(`/repos/${source.fullName}/branches?per_page=${LIMIT}&page=1`, signal);
  if (!Array.isArray(result) || result.some(branch => !branch || !branchName(branch.name))) throw unprocessable('GitHub returned an invalid branch list. Try again.');
  const names = new Set<string>([repository.default_branch, ...result.slice(0, LIMIT).map(branch => branch.name as string)]);
  return { defaultBranch: repository.default_branch, branches: [...names].map(name => ({ name, isDefault: name === repository.default_branch })), truncated: result.length >= LIMIT };
}
