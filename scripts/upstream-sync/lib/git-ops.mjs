function toOutputText(result) {
  if (typeof result === 'string') {
    return result;
  }

  if (result && typeof result.stdout === 'string') {
    return result.stdout;
  }

  return '';
}

async function runGit(run, args) {
  return toOutputText(await run({ command: 'git', args }));
}

export async function listMaintenanceCommits({ run, upstreamRef, maintenanceRef }) {
  const mergeBase = (await runGit(run, ['merge-base', upstreamRef, maintenanceRef])).trim();
  const revisions = await runGit(run, ['rev-list', '--reverse', `${mergeBase}..${maintenanceRef}`]);

  return revisions
    .split('\n')
    .map((commit) => commit.trim())
    .filter(Boolean);
}

export async function prepareBotBranch({ run, baseRef, branchName }) {
  await runGit(run, ['checkout', '-B', branchName, baseRef]);
}

export async function replayCommitStack({ run, commits }) {
  for (const commit of commits) {
    try {
      await runGit(run, ['cherry-pick', commit]);
    } catch (error) {
      if (error && typeof error === 'object') {
        error.failingCommit = commit;
      }

      throw error;
    }
  }
}

export async function listUnmergedFiles({ run }) {
  const conflicts = await runGit(run, ['diff', '--name-only', '--diff-filter=U']);

  return conflicts
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function captureConflictDiagnostics({ run, failingCommit, status: statusOutput, conflicts }) {
  const status = statusOutput ?? (await runGit(run, ['status', '--short']));
  const failingCommitSummary = await runGit(run, ['show', '--stat', '--oneline', '-1', failingCommit]);

  return {
    failingCommit,
    status,
    conflicts: conflicts ?? (await listUnmergedFiles({ run })),
    failingCommitSummary,
  };
}
