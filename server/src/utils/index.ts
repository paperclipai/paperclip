/**
 * Fork-specific shared utilities.
 *
 * New files that consolidate duplicated logic across our fork's server
 * services. Consumers can migrate to these imports incrementally without
 * touching upstream code.
 */

export {
  parseGitHubRepoUrl,
  isGitHubRepoUrl,
  parseGitHubSkillUrl,
  parseGitHubCompanyUrl,
  buildRawGitHubUrl,
  type GitHubRepo,
  type ParsedGitHubSourceUrl,
  type ParsedGitHubSkillUrl,
  type ParsedGitHubCompanyUrl,
} from "./github-url.js";

export { normalizePortablePath, resolvePortablePath } from "./portable-path.js";

export { normalizeSkillSlug, normalizeSkillKey } from "./skill-key.js";
