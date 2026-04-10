import { execFileSync } from 'node:child_process';

function readConfigValue(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readRepositoryFromGitRemote() {
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const sshMatch = remoteUrl.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
    if (sshMatch) {
      return sshMatch[1];
    }

    const urlMatch = remoteUrl.match(/github\.com\/(.+?\/.+?)(?:\.git)?$/);
    if (urlMatch) {
      return urlMatch[1];
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function readArgValue(argv, flag) {
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];

    if (entry === flag) {
      const next = argv[index + 1];
      return next && !next.startsWith('--') ? next : undefined;
    }

    if (entry.startsWith(`${flag}=`)) {
      return entry.slice(flag.length + 1);
    }
  }

  return undefined;
}

export function parseSyncConfig(
  env = process.env,
  argv = process.argv.slice(2),
  { readRepositoryFromGitRemote: resolveRepository = readRepositoryFromGitRemote } = {},
) {
  const githubRepository = readConfigValue(env.GITHUB_REPOSITORY) ?? resolveRepository();

  if (!githubRepository) {
    throw new Error('GITHUB_REPOSITORY is required');
  }

  return {
    githubRepository,
    baseBranch: readConfigValue(env.BASE_BRANCH) ?? 'zh-enterprise',
    upstreamRemote: readConfigValue(env.UPSTREAM_REMOTE) ?? 'upstream',
    upstreamRef: readArgValue(argv, '--upstream-ref') ?? readConfigValue(env.UPSTREAM_REF) ?? 'upstream/master',
    maintenanceRef: readArgValue(argv, '--maintenance-ref') ?? readConfigValue(env.MAINTENANCE_REF) ?? 'origin/zh-enterprise',
    branchPrefix: readConfigValue(env.BRANCH_PREFIX) ?? 'bot-upgrade',
    dryRun: argv.includes('--dry-run'),
    llmApiBase: readConfigValue(env.LLM_API_BASE),
    llmApiKey: readConfigValue(env.LLM_API_KEY),
    llmModel: readConfigValue(env.LLM_MODEL),
  };
}
