import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

async function listCommitsFromBase({ run, baseRef, maintenanceRef }) {
  const revisions = await runGit(run, ['rev-list', '--reverse', `${baseRef}..${maintenanceRef}`]);

  return revisions
    .split('\n')
    .map((commit) => commit.trim())
    .filter(Boolean);
}

export async function listMaintenanceCommits({ run, upstreamRef, maintenanceRef }) {
  const mergeBase = (await runGit(run, ['merge-base', upstreamRef, maintenanceRef])).trim();
  return listCommitsFromBase({ run, baseRef: mergeBase, maintenanceRef });
}

export async function findLatestIntegratedUpstreamBase({ run, upstreamRef, maintenanceRef }) {
  const mergeCommits = (await runGit(run, ['rev-list', '--first-parent', '--merges', maintenanceRef]))
    .split('\n')
    .map((commit) => commit.trim())
    .filter(Boolean);

  for (const mergeCommit of mergeCommits) {
    const parts = (await runGit(run, ['rev-list', '--parents', '-n', '1', mergeCommit]))
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const firstParent = parts[1] ?? null;
    const mergedParents = parts.slice(2);

    for (const candidate of mergedParents) {
      const sharedBase = (await runGit(run, ['merge-base', candidate, upstreamRef])).trim();
      if (sharedBase === candidate) {
        return {
          mergeCommit,
          firstParent,
          upstreamBase: candidate,
        };
      }
    }
  }

  return null;
}

export async function prepareBotBranch({ run, baseRef, branchName }) {
  await runGit(run, ['checkout', '-B', branchName, baseRef]);
}

export async function applyMaintenanceOverlay({ run, overlayBase, maintenanceRef }) {
  const patch = await runGit(run, ['diff', '--binary', overlayBase, maintenanceRef]);
  if (!patch.trim()) {
    return { applied: false };
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'paperclip-upstream-overlay-'));
  const patchPath = path.join(tempDir, 'maintenance-overlay.patch');

  await writeFile(patchPath, patch, 'utf8');

  try {
    await runGit(run, ['apply', '--3way', '--index', patchPath]);
    return { applied: true };
  } catch (error) {
    if (error && typeof error === 'object') {
      error.failingCommit = 'maintenance-overlay';
      error.failingCommitSummary = `maintenance overlay ${overlayBase}..${maintenanceRef}\n`;
    }

    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function commitMaintenanceOverlay({ run, overlayBase, maintenanceRef }) {
  const stagedFiles = await runGit(run, ['diff', '--cached', '--name-only']);
  if (!stagedFiles.trim()) {
    return false;
  }

  await runGit(run, [
    'commit',
    '-m',
    'chore(upstream): apply maintenance overlay',
    '-m',
    `Overlay base: ${overlayBase}\nMaintenance ref: ${maintenanceRef}`,
  ]);

  return true;
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

export async function captureConflictDiagnostics({
  run,
  failingCommit,
  failingCommitSummary: failingCommitSummaryInput,
  status: statusOutput,
  conflicts,
}) {
  const status = statusOutput ?? (await runGit(run, ['status', '--short']));
  const failingCommitSummary = typeof failingCommitSummaryInput === 'string'
    ? failingCommitSummaryInput
    : await runGit(run, ['show', '--stat', '--oneline', '-1', failingCommit]);

  return {
    failingCommit,
    status,
    conflicts: conflicts ?? (await listUnmergedFiles({ run })),
    failingCommitSummary,
  };
}
