export function parseSyncConfig(env = process.env, argv = process.argv.slice(2)) {
  const githubRepository = env.GITHUB_REPOSITORY;

  if (!githubRepository) {
    throw new Error('GITHUB_REPOSITORY is required');
  }

  return {
    githubRepository,
    baseBranch: env.BASE_BRANCH ?? 'zh-enterprise',
    upstreamRemote: env.UPSTREAM_REMOTE ?? 'upstream',
    upstreamRef: env.UPSTREAM_REF ?? 'upstream/master',
    maintenanceRef: env.MAINTENANCE_REF ?? 'origin/zh-enterprise',
    branchPrefix: env.BRANCH_PREFIX ?? 'bot-upgrade',
    dryRun: argv.includes('--dry-run'),
    llmApiBase: env.LLM_API_BASE,
    llmApiKey: env.LLM_API_KEY,
    llmModel: env.LLM_MODEL,
  };
}
